//! Native ownership of the private Open Notebook runtime. No runtime/package
//! installation, shell commands, or backend credentials cross the webview IPC.
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Write, net::TcpListener, path::{Component, Path, PathBuf}, process::{Child, Command, Stdio}, sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}}, time::{Duration, Instant}};
use tauri::{Manager, State};
use tokio::sync::Mutex;
use uuid::Uuid;
use fs2::FileExt;

#[derive(Default)]
pub struct NotebookState {
    lifecycle: Mutex<()>,
    runtime: Mutex<Option<Runtime>>,
}

struct Runtime {
    connection: Arc<Connection>,
    children: Vec<Child>,
    _workspace_lock: fs::File,
}

struct Connection {
    id: String,
    vault: PathBuf,
    base_url: String,
    password: String,
    client: Client,
    accepting: AtomicBool,
    inflight: AtomicUsize,
}

struct Lease(Arc<Connection>);
impl Drop for Lease {
    fn drop(&mut self) { self.0.inflight.fetch_sub(1, Ordering::SeqCst); }
}

impl Runtime {
    fn alive(&mut self) -> bool {
        self.children.iter_mut().all(|child| matches!(child.try_wait(), Ok(None)))
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.connection.accepting.store(false, Ordering::SeqCst);
        // Startup failure and unexpected native shutdown also clean up children.
        for child in self.children.iter_mut().rev() { terminate(child); }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: String,
    pub workspace_id: Option<String>,
    pub vault_path: Option<String>,
    pub message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    revision: String,
    python_executable: String,
    surreal_executable: String,
}

fn terminate(child: &mut Child) {
    if !matches!(child.try_wait(), Ok(None)) { return; }
    #[cfg(unix)]
    unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM); }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).creation_flags(0x08000000).status();
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) { return; }
        std::thread::sleep(Duration::from_millis(50));
    }
    #[cfg(unix)]
    unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn(mut command: Command) -> Result<Child, String> {
    // Each child owns a process group, including media extraction subprocesses.
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; command.process_group(0); }
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    // Upstream logs can contain provider URLs and input content. Native errors
    // expose process/phase only, never raw stderr or credential-bearing env.
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    command.spawn().map_err(|e| format!("Could not start the bundled Notebook service: {e}"))
}

fn unused_port() -> Result<u16, String> {
    let socket = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(socket.local_addr().map_err(|e| e.to_string())?.port())
}

fn runtime_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let target = if cfg!(target_os = "windows") { "x86_64-pc-windows-msvc" }
        else if cfg!(target_arch = "aarch64") { "aarch64-apple-darwin" }
        else { "x86_64-apple-darwin" };
    let resource = app.path().resource_dir().map_err(|e| e.to_string())?.join("notebook-runtime").join(target);
    if resource.join("manifest.json").is_file() { return Ok(resource); }
    #[cfg(debug_assertions)]
    {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("notebook-runtime").join(target);
        if dev.join("manifest.json").is_file() { return Ok(dev); }
    }
    Err("Notebook runtime is missing from this installation. Install a complete Prism build or build the Notebook runtime for development.".into())
}

fn credential(workspace: &str, name: &str, allow_create: bool) -> Result<String, String> {
    let entry = keyring::Entry::new("com.prism.app.notebook", &format!("{workspace}:{name}"))
        .map_err(|_| "Cannot access Notebook's OS credential store".to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) if allow_create => {
            let value = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            entry.set_password(&value).map_err(|_| "Cannot save Notebook's encryption key in the OS credential store".to_string())?;
            Ok(value)
        }
        Err(keyring::Error::NoEntry) => Err("Notebook's encryption key is missing from this computer. Restore the original OS credential-store entry before opening this workspace.".into()),
        Err(_) => Err("Notebook's OS credential store is locked or unavailable".into()),
    }
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() { return Err("Notebook backup refuses symbolic links in its data directory".into()); }
        let out = destination.join(entry.file_name());
        if kind.is_dir() { copy_tree(&entry.path(), &out)?; }
        else { fs::copy(entry.path(), out).map_err(|e| e.to_string())?; }
    }
    Ok(())
}

async fn ready(runtime: &mut Runtime, url: &str, phase: &str) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if !runtime.alive() { return Err(format!("Notebook {phase} exited during startup. Retry or reinstall the bundled runtime.")); }
        if let Ok(response) = runtime.connection.client.get(url).timeout(Duration::from_secs(2)).send().await {
            if response.status().is_success() { return Ok(()); }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(format!("Notebook {phase} did not become ready within two minutes."))
}

async fn stop_locked(state: &NotebookState) {
    let runtime = state.runtime.lock().await.take();
    if let Some(runtime) = runtime {
        let c = &runtime.connection;
        c.accepting.store(false, Ordering::SeqCst);
        let _ = c.client.post(format!("{}/api/prism/drain", c.base_url)).bearer_auth(&c.password).timeout(Duration::from_secs(2)).send().await;
        // No new IPC requests can be leased once the runtime is removed. Allow
        // existing requests/jobs to finish; keep the old vault DB alive meanwhile.
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            let jobs = c.client.get(format!("{}/api/commands/jobs?status_filter=running&limit=1000", c.base_url))
                .bearer_auth(&c.password).timeout(Duration::from_secs(2)).send().await;
            let idle = match jobs {
                Ok(r) => r.json::<Vec<Value>>().await.map(|v| v.is_empty()).unwrap_or(false),
                Err(_) => false,
            };
            if idle && c.inflight.load(Ordering::SeqCst) == 0 { break; }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        // Drop performs bounded process-tree termination outside the async pool.
        let _ = tauri::async_runtime::spawn_blocking(move || drop(runtime)).await;
    }
}

pub async fn shutdown(state: &NotebookState) {
    let _lifecycle = state.lifecycle.lock().await;
    stop_locked(state).await;
}

#[tauri::command]
pub async fn notebook_stop(state: State<'_, NotebookState>) -> Result<(), String> { shutdown(&state).await; Ok(()) }

#[tauri::command]
pub async fn notebook_status(state: State<'_, NotebookState>) -> Result<RuntimeStatus, String> {
    let mut guard = state.runtime.lock().await;
    Ok(match guard.as_mut() {
        Some(r) => RuntimeStatus {
            state: if r.alive() { "ready" } else { "failed" }.into(),
            workspace_id: Some(r.connection.id.clone()),
            vault_path: Some(r.connection.vault.to_string_lossy().into()),
            message: if r.alive() { None } else { Some("A Notebook service stopped. Restart Notebook to recover.".into()) },
        },
        None => RuntimeStatus { state: "stopped".into(), workspace_id: None, vault_path: None, message: None },
    })
}

#[tauri::command]
pub async fn notebook_start(app: tauri::AppHandle, state: State<'_, NotebookState>, vault_path: String) -> Result<RuntimeStatus, String> {
    let _lifecycle = state.lifecycle.lock().await;
    #[cfg(target_os = "macos")]
    {
        let version = Command::new("/usr/bin/sw_vers").arg("-productVersion").output().map_err(|e| e.to_string())?;
        let major = String::from_utf8_lossy(&version.stdout).split('.').next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        if major < 14 { return Err("Notebook requires macOS 14 or newer. Prism's other pages remain available.".into()); }
    }
    let vault = fs::canonicalize(vault_path).map_err(|_| "Select an existing vault before opening Notebook".to_string())?;
    if !vault.is_dir() { return Err("Notebook requires a vault folder".into()); }
    {
        let mut guard = state.runtime.lock().await;
        if let Some(r) = guard.as_mut() {
            if r.connection.vault == vault && r.alive() {
                return Ok(RuntimeStatus { state: "ready".into(), workspace_id: Some(r.connection.id.clone()), vault_path: Some(vault.to_string_lossy().into()), message: None });
            }
        }
    }
    stop_locked(&state).await;
    let root = runtime_root(&app)?;
    let manifest: Manifest = serde_json::from_slice(&fs::read(root.join("manifest.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let workspace = vault.join(".prism/notebook");
    fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    let workspace = fs::canonicalize(workspace).map_err(|e| e.to_string())?;
    if !workspace.starts_with(&vault) { return Err("Notebook data directory must remain inside the vault".into()); }
    let workspace_lock = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(workspace.join("runtime.lock")).map_err(|e| e.to_string())?;
    workspace_lock.try_lock_exclusive().map_err(|_| "This Notebook workspace is already open in another Prism process".to_string())?;
    let identity_file = workspace.join("workspace-id");
    let identity = if identity_file.exists() { fs::read_to_string(&identity_file).map_err(|e| e.to_string())? }
        else { let id = Uuid::new_v4().to_string(); fs::write(&identity_file, &id).map_err(|e| e.to_string())?; id };
    let data = workspace.join("data");
    let existing = data.join("surreal.db").exists();
    let secret = credential(&identity, "encryption", !existing)?;
    let database_password = credential(&identity, "database", !existing)?;
    let password = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let version_file = workspace.join("runtime-revision");
    let old_version = fs::read_to_string(&version_file).unwrap_or_default();
    let migration_pending = workspace.join("migration-pending");
    if migration_pending.exists() {
        return Err(format!("A previous Notebook migration did not finish. Restore the backup recorded in {} before retrying.", migration_pending.display()));
    }
    let changing = existing && old_version != manifest.revision;
    if changing {
        let backup = workspace.join("backups").join(Uuid::new_v4().to_string());
        copy_tree(&data, &backup)?;
        fs::write(&migration_pending, backup.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let db_port = unused_port()?;
    let mut api_port = unused_port()?;
    while api_port == db_port { api_port = unused_port()?; }
    let client = Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(600)).build().map_err(|e| e.to_string())?;
    let connection = Arc::new(Connection { id: Uuid::new_v4().to_string(), vault: vault.clone(), base_url: format!("http://127.0.0.1:{api_port}"), password: password.clone(), client, accepting: AtomicBool::new(true), inflight: AtomicUsize::new(0) });
    let mut runtime = Runtime { connection, children: vec![], _workspace_lock: workspace_lock };
    let mut db = Command::new(root.join(&manifest.surreal_executable));
    db.args(["start", "--bind", &format!("127.0.0.1:{db_port}"), "--user", "prism", "--log", "error"])
        .env("SURREAL_PASS", &database_password).arg(format!("rocksdb:{}", data.join("surreal.db").display()));
    runtime.children.push(spawn(db)?);
    ready(&mut runtime, &format!("http://127.0.0.1:{db_port}/health"), "database").await?;
    for service in ["api", "worker"] {
        let mut command = Command::new(root.join(&manifest.python_executable));
        command.arg("-B").arg(root.join("launcher.py")).arg(service).arg(api_port.to_string())
            .env("PRISM_NOTEBOOK_DATA", &data)
            .env("SURREAL_URL", format!("ws://127.0.0.1:{db_port}/rpc"))
            .env("SURREAL_USER", "prism").env("SURREAL_PASSWORD", &database_password)
            .env("SURREAL_NAMESPACE", "open_notebook").env("SURREAL_DATABASE", "open_notebook")
            .env("OPEN_NOTEBOOK_ENCRYPTION_KEY", &secret).env("OPEN_NOTEBOOK_PASSWORD", &password)
            .env("CORS_ORIGINS", "http://tauri.localhost,tauri://localhost")
            .env("PYTHONNOUSERSITE", "1");
        runtime.children.push(spawn(command)?);
        if service == "api" {
            let health = format!("{}/health", runtime.connection.base_url);
            ready(&mut runtime, &health, "API/migrations").await?;
        }
    }
    tokio::time::sleep(Duration::from_millis(750)).await;
    if !runtime.alive() { return Err("Notebook worker could not start".into()); }
    fs::write(&version_file, &manifest.revision).map_err(|e| e.to_string())?;
    if changing { fs::remove_file(migration_pending).map_err(|e| e.to_string())?; }
    let status = RuntimeStatus { state: "ready".into(), workspace_id: Some(runtime.connection.id.clone()), vault_path: Some(vault.to_string_lossy().into()), message: None };
    *state.runtime.lock().await = Some(runtime);
    Ok(status)
}

async fn lease(state: &NotebookState, workspace_id: &str) -> Result<Lease, String> {
    let mut guard = state.runtime.lock().await;
    let r = guard.as_mut().ok_or("Notebook is not running")?;
    if r.connection.id != workspace_id || !r.connection.accepting.load(Ordering::SeqCst) { return Err("Notebook workspace changed. Reopen the current notebook.".into()); }
    if !r.alive() { return Err("A Notebook service stopped. Restart Notebook.".into()); }
    r.connection.inflight.fetch_add(1, Ordering::SeqCst);
    Ok(Lease(r.connection.clone()))
}

fn api_path(path: &str) -> Result<(), String> {
    let head = path.split('?').next().unwrap_or("");
    if !head.starts_with("/api/") || head.contains("..") || head.contains('\\') || head.contains('%') || path.contains('#') || path.chars().any(char::is_control) {
        return Err("Invalid Notebook API path".into());
    }
    Ok(())
}

async fn response_value(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let text = response.text().await.map_err(|_| "Notebook response was interrupted".to_string())?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("detail").cloned()).unwrap_or(json!("Notebook request failed"));
        return Err(format!("Notebook ({status}): {detail}"));
    }
    if text.is_empty() { return Ok(Value::Null); }
    serde_json::from_str(&text).or_else(|_| Ok(json!({"stream": text})))
}

#[tauri::command]
pub async fn notebook_request(state: State<'_, NotebookState>, workspace_id: String, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    api_path(&path)?;
    if !["GET", "POST", "PUT", "DELETE", "PATCH"].contains(&method.as_str()) { return Err("Unsupported Notebook method".into()); }
    let lease = lease(&state, &workspace_id).await?;
    let c = &lease.0;
    let mut request = c.client.request(Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?, format!("{}{path}", c.base_url)).bearer_auth(&c.password);
    if let Some(body) = body { request = request.json(&body); }
    response_value(request.send().await.map_err(|_| "Could not reach Notebook. Check its runtime status and retry.".to_string())?).await
}

#[tauri::command]
pub async fn notebook_add_source(state: State<'_, NotebookState>, workspace_id: String, fields: std::collections::HashMap<String, String>, upload: bool) -> Result<Value, String> {
    let lease = lease(&state, &workspace_id).await?;
    let c = &lease.0;
    let mut form = reqwest::multipart::Form::new();
    for (key, value) in fields { form = form.text(key, value); }
    if upload {
        let selected = rfd::AsyncFileDialog::new().pick_file().await;
        let Some(file) = selected else { return Ok(Value::Null); };
        let size = fs::metadata(file.path()).map_err(|e| e.to_string())?.len();
        if size > 95 * 1024 * 1024 { return Err("Choose a file smaller than 95 MB".into()); }
        form = form.part("file", reqwest::multipart::Part::bytes(file.read().await).file_name(file.file_name()));
    }
    if !c.accepting.load(Ordering::SeqCst) { return Err("Notebook workspace changed".into()); }
    response_value(c.client.post(format!("{}/api/sources", c.base_url)).bearer_auth(&c.password).multipart(form).send().await.map_err(|_| "Source upload failed".to_string())?).await
}

#[tauri::command]
pub async fn notebook_media(state: State<'_, NotebookState>, workspace_id: String, path: String) -> Result<tauri::ipc::Response, String> {
    api_path(&path)?;
    if !(path.ends_with("/audio") || path.ends_with("/download")) { return Err("Invalid media request".into()); }
    let lease = lease(&state, &workspace_id).await?;
    let c = &lease.0;
    let response = c.client.get(format!("{}{path}", c.base_url)).bearer_auth(&c.password).send().await.map_err(|_| "Media download failed".to_string())?;
    if !response.status().is_success() { return Err(format!("Media unavailable ({})", response.status())); }
    let bytes = response.bytes().await.map_err(|_| "Media download interrupted".to_string())?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

#[tauri::command]
pub async fn notebook_download(state: State<'_, NotebookState>, workspace_id: String, path: String, filename: String) -> Result<bool, String> {
    api_path(&path)?;
    if !(path.ends_with("/audio") || path.ends_with("/download")) { return Err("Invalid media request".into()); }
    let lease = lease(&state, &workspace_id).await?;
    let c = &lease.0;
    let suggested = filename.chars().filter(|ch| !ch.is_control() && !"/\\:*?\"<>|".contains(*ch)).take(180).collect::<String>();
    let Some(destination) = rfd::AsyncFileDialog::new().set_file_name(&suggested).save_file().await else { return Ok(false); };
    if !c.accepting.load(Ordering::SeqCst) { return Err("Notebook workspace changed".into()); }
    let mut response = c.client.get(format!("{}{path}", c.base_url)).bearer_auth(&c.password).send().await.map_err(|_| "Download failed".to_string())?;
    if !response.status().is_success() { return Err(format!("Download unavailable ({})", response.status())); }
    let parent = destination.path().parent().ok_or("Invalid destination")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    while let Some(chunk) = response.chunk().await.map_err(|_| "Download interrupted".to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(destination.path()).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn notebook_export(state: State<'_, NotebookState>, workspace_id: String, title: String, content: String) -> Result<String, String> {
    let lease = lease(&state, &workspace_id).await?;
    let name = safe_filename(&title);
    for suffix in 0..10000 {
        let filename = if suffix == 0 { format!("{name}.md") } else { format!("{name} ({suffix}).md") };
        let path = lease.0.vault.join(&filename);
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => { f.write_all(content.as_bytes()).map_err(|e| e.to_string())?; return Ok(filename); }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Too many notes have this title".into())
}

fn safe_filename(title: &str) -> String {
    let name: String = title.chars().filter(|c| !c.is_control() && !"/\\:*?\"<>|".contains(*c)).take(120).collect();
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() { "Notebook export".into() } else { format!("Notebook - {name}") }
}

#[tauri::command]
pub async fn notebook_read_vault_note(state: State<'_, NotebookState>, workspace_id: String, relative_path: String) -> Result<String, String> {
    let lease = lease(&state, &workspace_id).await?;
    let relative = Path::new(&relative_path);
    if relative.components().any(|c| !matches!(c, Component::Normal(_))) { return Err("Invalid vault note path".into()); }
    let path = fs::canonicalize(lease.0.vault.join(relative)).map_err(|e| e.to_string())?;
    if !path.starts_with(&lease.0.vault) || crate::engine::indexer::is_hidden(relative) || !matches!(path.extension().and_then(|x| x.to_str()), Some("md" | "markdown")) { return Err("Select a Markdown note inside this vault".into()); }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_cannot_escape_private_backend() {
        for bad in ["https://example.com", "//example.com/api", "/api/../health", "/api/%2e%2e/health", "/api/a\\b", "/api/a#b"] { assert!(api_path(bad).is_err(), "{bad}"); }
        assert!(api_path("/api/sources/source:abc/chat/sessions?limit=50").is_ok());
    }
    #[test]
    fn export_names_are_portable_and_bounded() {
        assert_eq!(safe_filename("../../CON:*?"), "Notebook - CON");
        assert_eq!(safe_filename(" . "), "Notebook export");
        assert!(safe_filename(&"a".repeat(1000)).len() < 150);
    }
}

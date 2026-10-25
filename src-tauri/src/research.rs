//! Local research assets and PDF annotations. Files remain canonical; handles are vault-generation scoped.
use crate::knowledge::{self, operations, Scope};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;
const MAX_PDF: u64 = 256 * 1024 * 1024;
const CHUNK: usize = 1024 * 1024;
#[derive(Default)]
pub struct Assets(Mutex<HashMap<String, Asset>>);
#[derive(Clone)]
struct Asset {
    scope: Scope,
    path: PathBuf,
    size: u64,
    modified: std::time::SystemTime,
    mime: String,
    document_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub handle: String,
    pub size: u64,
    pub mime: String,
    pub name: String,
    pub document_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Annotation {
    pub id: String,
    pub page: u32,
    pub rects: Vec<[f64; 4]>,
    pub text: String,
    pub comment: String,
    pub color: String,
    pub created_at: u64,
    pub updated_at: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotations {
    pub version: u32,
    pub document_id: String,
    pub revision: u64,
    pub entries: Vec<Annotation>,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn id_valid(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn directory(s: &Scope, name: &str) -> Result<PathBuf, String> {
    let p = s.root.join(name);
    operations::validate(&s.root, &p)?;
    fs::create_dir_all(&p).map_err(err)?;
    Ok(p)
}
fn mime(path: &Path) -> Result<String, String> {
    Ok(match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        _ => return Err("Unsupported attachment type".into()),
    }
    .into())
}
fn asset(
    app: &tauri::AppHandle,
    path: PathBuf,
    document_id: Option<String>,
) -> Result<AssetInfo, String> {
    let scope = knowledge::current(app)?;
    operations::validate(&scope.root, &path)?;
    let meta = fs::metadata(&path).map_err(err)?;
    if !meta.is_file() || meta.len() == 0 {
        return Err("Attachment is empty or missing".into());
    }
    let mime = mime(&path)?;
    let handle = uuid::Uuid::new_v4().to_string();
    let stored_id = document_id.clone();
    if mime.starts_with("image/") && meta.len() > 32 * 1024 * 1024 {
        return Err("Images are limited to 32 MiB".into());
    }
    let info = AssetInfo {
        handle: handle.clone(),
        size: meta.len(),
        mime: mime.clone(),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        document_id,
    };
    let state = app.state::<Assets>();
    let mut map = state.0.lock().map_err(err)?;
    map.retain(|_, a| a.scope.generation == scope.generation);
    if map.len() >= 256 {
        return Err("Too many open attachments. Close a document first.".into());
    }
    map.insert(
        handle,
        Asset {
            scope,
            path,
            size: meta.len(),
            modified: meta.modified().map_err(err)?,
            mime,
            document_id: stored_id,
        },
    );
    Ok(info)
}
fn resolve(app: &tauri::AppHandle, handle: &str) -> Result<Asset, String> {
    let a = app
        .state::<Assets>()
        .0
        .lock()
        .map_err(err)?
        .get(handle)
        .cloned()
        .ok_or("Attachment is closed")?;
    if knowledge::current(app)?.generation != a.scope.generation {
        return Err("Vault changed".into());
    }
    operations::validate(&a.scope.root, &a.path)?;
    let m = fs::metadata(&a.path).map_err(|_| "Source is missing; relink the original PDF")?;
    if m.len() != a.size || m.modified().map_err(err)? != a.modified {
        return Err("Source changed; reopen or relink the identical PDF".into());
    }
    Ok(a)
}
#[tauri::command]
pub fn research_close(app: tauri::AppHandle, handle: String) {
    if let Ok(mut map) = app.state::<Assets>().0.lock() {
        map.remove(&handle);
    }
}
#[tauri::command]
pub fn research_asset(
    app: tauri::AppHandle,
    note_path: String,
    target: String,
) -> Result<AssetInfo, String> {
    let scope = knowledge::current(&app)?;
    let note = Path::new(&note_path);
    operations::validate(&scope.root, note)?;
    let target = urlencoding::decode(&target).map_err(err)?;
    if Path::new(target.as_ref()).is_absolute() || target.contains(':') {
        return Err("Use a vault-relative attachment path".into());
    }
    // Normalize parent components, then validate canonical containment and symlinks.
    let mut p = note.parent().ok_or("Missing note folder")?.to_path_buf();
    for c in Path::new(target.as_ref()).components() {
        match c {
            std::path::Component::ParentDir => {
                p.pop();
            }
            std::path::Component::Normal(n) => p.push(n),
            std::path::Component::CurDir => {}
            _ => return Err("Invalid attachment path".into()),
        }
    }
    asset(&app, p, None)
}
#[tauri::command]
pub fn research_read(
    app: tauri::AppHandle,
    handle: String,
    offset: u64,
    length: usize,
) -> Result<tauri::ipc::Response, String> {
    let a = resolve(&app, &handle)?;
    if length > CHUNK || offset > a.size {
        return Err("Invalid byte range".into());
    }
    let mut f = fs::File::open(&a.path).map_err(err)?;
    f.seek(SeekFrom::Start(offset)).map_err(err)?;
    let mut b = vec![0; length.min((a.size - offset) as usize)];
    f.read_exact(&mut b).map_err(err)?;
    Ok(tauri::ipc::Response::new(b))
}
fn pdf_copy(s: &Scope, source: &Path, expected: Option<&str>) -> Result<(PathBuf, String), String> {
    let mut f = fs::File::open(source).map_err(err)?;
    if f.metadata().map_err(err)?.len() > MAX_PDF {
        return Err("PDF exceeds 256 MiB".into());
    }
    let mut bytes = Vec::new();
    f.by_ref()
        .take(MAX_PDF + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() as u64 > MAX_PDF || !bytes.starts_with(b"%PDF-") {
        return Err("Choose a PDF up to 256 MiB".into());
    }
    let id = format!("{:x}", Sha256::digest(&bytes));
    if expected.is_some_and(|e| e != id) {
        return Err("This is a different PDF. Choose the identical original.".into());
    }
    let dir = directory(s, ".prism/research")?;
    let reference = dir.join(format!("{id}.source.json"));
    operations::validate(&s.root, &reference)?;
    let retained = crate::path_util::relative_to(&s.root, source)
        .is_some_and(|relative| relative.starts_with(Path::new(".prism").join("documents")));
    if retained {
        operations::validate(&s.root, source)?;
        operations::atomic_write(
            &reference,
            &serde_json::to_vec(
                &crate::path_util::relative_to(&s.root, source)
                    .ok_or_else(|| err("Source is outside vault"))?
                    .to_string_lossy(),
            )
            .map_err(err)?,
            !reference.exists(),
        )?;
        return Ok((source.to_path_buf(), id));
    }
    let path = dir.join(format!("{id}.pdf"));
    operations::validate(&s.root, &path)?;
    if !path.exists() || knowledge::documents::file_hash(&path)? != id {
        operations::atomic_write(&path, &bytes, !path.exists())?;
    }
    operations::atomic_write(
        &reference,
        &serde_json::to_vec(
            &crate::path_util::relative_to(&s.root, &path)
                .ok_or_else(|| err("Source is outside vault"))?
                .to_string_lossy(),
        )
        .map_err(err)?,
        !reference.exists(),
    )?;
    Ok((path, id))
}
#[tauri::command]
pub async fn research_open_pdf(
    app: tauri::AppHandle,
    document_id: Option<String>,
    block_id: Option<String>,
    attachment_handle: Option<String>,
    relink: bool,
) -> Result<Option<AssetInfo>, String> {
    let scope = knowledge::current(&app)?;
    let selected =
        if (document_id.is_none() && block_id.is_none() && attachment_handle.is_none()) || relink {
            rfd::AsyncFileDialog::new()
                .add_filter("PDF", &["pdf"])
                .pick_file()
                .await
                .map(|f| f.path().to_path_buf())
        } else {
            None
        };
    if ((document_id.is_none() && block_id.is_none() && attachment_handle.is_none()) || relink)
        && selected.is_none()
    {
        return Ok(None);
    }
    let _guard = operations::lock()?;
    if knowledge::current(&app)?.generation != scope.generation {
        return Err("Vault changed".into());
    }
    let (path, id) = if let Some(p) = selected {
        pdf_copy(&scope, &p, document_id.as_deref())?
    } else if let Some(id) = document_id {
        if !id_valid(&id) {
            return Err("Invalid document ID".into());
        }
        let dir = scope.root.join(".prism/research");
        let reference = dir.join(format!("{id}.source.json"));
        operations::validate(&scope.root, &reference)?;
        let path = if reference.exists() {
            if fs::metadata(&reference).map_err(err)?.len() > 8192 {
                return Err("Invalid PDF reference".into());
            }
            let relative: String =
                serde_json::from_slice(&fs::read(&reference).map_err(err)?).map_err(err)?;
            scope.root.join(relative)
        } else {
            dir.join(format!("{id}.pdf"))
        };
        operations::validate(&scope.root, &path)?;
        if knowledge::documents::file_hash(&path)
            .map_err(|_| "Source is missing. Relink the identical PDF.")?
            != id
        {
            return Err("Source changed. Relink the identical PDF.".into());
        }
        (path, id)
    } else if let Some(handle) = attachment_handle {
        let a = resolve(&app, &handle)?;
        pdf_copy(&scope, &a.path, None)?
    } else {
        let path = knowledge::documents::pdf_source_path(&app, &block_id.ok_or("Missing source")?)?;
        pdf_copy(&scope, &path, None)?
    };
    Ok(Some(asset(&app, path, Some(id))?))
}
#[tauri::command]
pub async fn research_import_attachment(
    app: tauri::AppHandle,
    note_path: String,
    name: Option<String>,
    bytes: Option<Vec<u8>>,
) -> Result<Option<String>, String> {
    let scope = knowledge::current(&app)?;
    let (name, bytes) = if let (Some(name), Some(bytes)) = (name, bytes) {
        (name, bytes)
    } else {
        let Some(file) = rfd::AsyncFileDialog::new()
            .add_filter(
                "Media",
                &[
                    "png", "jpg", "jpeg", "webp", "gif", "avif", "mp3", "wav", "ogg", "m4a", "mp4",
                    "webm", "pdf",
                ],
            )
            .pick_file()
            .await
        else {
            return Ok(None);
        };
        let p = file.path();
        if fs::metadata(p).map_err(err)?.len() > MAX_PDF {
            return Err("Attachment exceeds 256 MiB".into());
        }
        (file.file_name(), fs::read(p).map_err(err)?)
    };
    let _guard = operations::lock()?;
    if knowledge::current(&app)?.generation != scope.generation {
        return Err("Vault changed".into());
    }
    if bytes.len() as u64 > MAX_PDF {
        return Err("Attachment exceeds 256 MiB".into());
    }
    if Path::new(&name).file_name().and_then(|s| s.to_str()) != Some(&name)
        || name.contains(['/', '\\'])
    {
        return Err("Invalid filename".into());
    }
    mime(Path::new(&name))?;
    let note = Path::new(&note_path);
    operations::validate(&scope.root, note)?;
    let dir = directory(&scope, "attachments")?;
    let filename = format!("{}-{}", uuid::Uuid::new_v4(), name);
    let dest = dir.join(&filename);
    operations::atomic_write(&dest, &bytes, true)?;
    let depth = crate::path_util::relative_to(
        &scope.root,
        note.parent().ok_or("Missing note folder")?,
    )
    .ok_or_else(|| err("Note is outside the vault"))?
    .components()
    .count();
    Ok(Some(format!(
        "{}attachments/{}",
        "../".repeat(depth),
        urlencoding::encode(&filename)
    )))
}
fn annotation_path(s: &Scope, id: &str) -> Result<PathBuf, String> {
    if !id_valid(id) {
        return Err("Invalid document ID".into());
    }
    let p = directory(s, ".prism/annotations")?.join(format!("{id}.json"));
    operations::validate(&s.root, &p)?;
    Ok(p)
}
fn load(s: &Scope, id: &str) -> Result<Annotations, String> {
    let p = annotation_path(s, id)?;
    if !p.exists() {
        return Ok(Annotations {
            version: 1,
            document_id: id.into(),
            revision: 0,
            entries: vec![],
        });
    }
    if fs::metadata(&p).map_err(err)?.len() > 8 * 1024 * 1024 {
        return Err("Annotation file exceeds limit".into());
    }
    let a: Annotations = serde_json::from_slice(&fs::read(p).map_err(err)?).map_err(err)?;
    if a.version != 1 || a.document_id != id {
        return Err("Unsupported annotation file".into());
    }
    Ok(a)
}
#[tauri::command]
pub fn research_annotations(
    app: tauri::AppHandle,
    handle: String,
    document_id: String,
) -> Result<Annotations, String> {
    let a = resolve(&app, &handle)?;
    if a.document_id.as_deref() != Some(&document_id) {
        return Err("Document mismatch".into());
    }
    load(&a.scope, &document_id)
}
fn validate_annotations(entries: &[Annotation]) -> Result<(), String> {
    if entries.len() > 10000 {
        return Err("Annotation limit reached".into());
    }
    let mut ids = std::collections::HashSet::new();
    for a in entries {
        if a.id.is_empty()
            || a.id.len() > 100
            || !ids.insert(&a.id)
            || a.page == 0
            || a.text.len() > 100_000
            || a.comment.len() > 100_000
            || a.rects.is_empty()
            || a.rects.len() > 1000
            || !["yellow", "green", "blue", "pink"].contains(&a.color.as_str())
            || a.rects
                .iter()
                .any(|r| r.iter().any(|v| !v.is_finite() || v.abs() > 1_000_000.0))
        {
            return Err("Invalid annotation".into());
        }
    }
    Ok(())
}
#[tauri::command]
pub fn research_save_annotations(
    app: tauri::AppHandle,
    handle: String,
    document_id: String,
    expected_revision: u64,
    entries: Vec<Annotation>,
) -> Result<Annotations, String> {
    let _guard = operations::lock()?;
    let a = resolve(&app, &handle)?;
    if a.document_id.as_deref() != Some(&document_id) {
        return Err("Document mismatch".into());
    }
    if knowledge::documents::file_hash(&a.path)? != document_id {
        return Err("Source changed".into());
    }
    let old = load(&a.scope, &document_id)?;
    if old.revision != expected_revision {
        return Err("CONFLICT: Annotations changed. Keep your draft and reopen to review the saved version.".into());
    }
    validate_annotations(&entries)?;
    let next = Annotations {
        version: 1,
        document_id: document_id.clone(),
        revision: old.revision + 1,
        entries,
    };
    let bytes = serde_json::to_vec_pretty(&next).map_err(err)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Annotation file exceeds limit".into());
    }
    let p = annotation_path(&a.scope, &document_id)?;
    operations::atomic_write(&p, &bytes, !p.exists())?;
    Ok(next)
}
fn byte_range(range: Option<&str>, size: u64, cap: u64) -> Result<(u64, u64), String> {
    if size == 0 {
        return Err("Empty attachment".into());
    }
    let (start, end) = if let Some(range) = range {
        let (s, e) = range
            .strip_prefix("bytes=")
            .and_then(|r| r.split_once('-'))
            .ok_or("Invalid range")?;
        if s.is_empty() {
            let suffix = e.parse::<u64>().map_err(err)?;
            if suffix == 0 {
                return Err("Invalid range".into());
            }
            (size.saturating_sub(suffix), size - 1)
        } else {
            let start = s.parse::<u64>().map_err(err)?;
            let end = if e.is_empty() {
                size - 1
            } else {
                e.parse::<u64>().map_err(err)?.min(size - 1)
            };
            (start, end)
        }
    } else {
        (0, size - 1)
    };
    if start > end || start >= size {
        return Err("Invalid range".into());
    }
    Ok((start, end.min(start.saturating_add(cap - 1))))
}
pub fn response(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let result = (|| -> Result<tauri::http::Response<Vec<u8>>, String> {
        let handle = request.uri().path().trim_start_matches('/');
        let a = resolve(app, handle)?;
        let range = request
            .headers()
            .get("Range")
            .map(|r| r.to_str().map_err(err))
            .transpose()?;
        let (start, end) = byte_range(
            range,
            a.size,
            if a.mime.starts_with("image/") {
                32 * 1024 * 1024
            } else {
                8 * CHUNK as u64
            },
        )?;
        let mut f = fs::File::open(&a.path).map_err(err)?;
        f.seek(SeekFrom::Start(start)).map_err(err)?;
        let mut bytes = vec![0; (end - start + 1) as usize];
        f.read_exact(&mut bytes).map_err(err)?;
        tauri::http::Response::builder()
            .status(if range.is_none() && end + 1 == a.size {
                200
            } else {
                206
            })
            .header("Content-Type", a.mime)
            .header("Accept-Ranges", "bytes")
            .header("Content-Range", format!("bytes {start}-{end}/{}", a.size))
            .header("Access-Control-Allow-Origin", "*")
            .header("Content-Length", bytes.len())
            .body(bytes)
            .map_err(err)
    })();
    result.unwrap_or_else(|e| {
        tauri::http::Response::builder()
            .status(404)
            .body(e.into_bytes())
            .unwrap()
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn annotation_validation() {
        assert!(validate_annotations(&[Annotation {
            id: "a".into(),
            page: 0,
            rects: vec![],
            text: String::new(),
            comment: String::new(),
            color: "yellow".into(),
            created_at: 0,
            updated_at: 0
        }])
        .is_err());
        assert!(!id_valid("../outside"));
    }
    #[test]
    fn sidecar_roundtrip() {
        let root = tempfile::tempdir().unwrap();
        let s = Scope {
            root: root.path().into(),
            vault_id: "v".into(),
            generation: "g".into(),
        };
        let id = "a".repeat(64);
        let a = load(&s, &id).unwrap();
        assert_eq!(a.revision, 0);
        let p = annotation_path(&s, &id).unwrap();
        operations::atomic_write(&p, &serde_json::to_vec(&a).unwrap(), true).unwrap();
        assert_eq!(load(&s, &id).unwrap().document_id, id);
    }
}

#[cfg(test)]
mod contracts {
    use super::*;
    fn scope(root: &Path) -> Scope {
        Scope {
            root: root.into(),
            vault_id: "vault".into(),
            generation: "generation".into(),
        }
    }
    #[test]
    fn media_ranges_are_bounded_and_seekable() {
        assert_eq!(byte_range(Some("bytes=10-19"), 100, 64).unwrap(), (10, 19));
        assert_eq!(byte_range(Some("bytes=80-"), 100, 64).unwrap(), (80, 99));
        assert_eq!(byte_range(Some("bytes=-10"), 100, 64).unwrap(), (90, 99));
        assert_eq!(byte_range(None, 100, 64).unwrap(), (0, 63));
        for bad in ["bytes=200-", "bytes=2-1", "bytes=-0", "bytes=1-2,4-5"] {
            assert!(byte_range(Some(bad), 100, 64).is_err());
        }
    }
    #[test]
    fn original_pdf_bytes_and_identity_survive_relink() {
        let dir = tempfile::tempdir().unwrap();
        let s = scope(dir.path());
        let source = dir.path().join("original.pdf");
        let bytes = b"%PDF-1.4\nfixture\n";
        fs::write(&source, bytes).unwrap();
        let (copy, id) = pdf_copy(&s, &source, None).unwrap();
        assert_eq!(fs::read(&copy).unwrap(), bytes);
        assert_ne!(copy, source);
        fs::remove_file(&copy).unwrap();
        assert!(pdf_copy(&s, &source, Some(&id)).is_ok());
        fs::write(&source, b"%PDF-1.4\ndifferent\n").unwrap();
        assert!(pdf_copy(&s, &source, Some(&id)).is_err());
        assert_eq!(fs::read(&copy).unwrap(), bytes);
    }
    #[test]
    fn retained_pdf_is_reused_and_annotation_vaults_are_separate() {
        let dir = tempfile::tempdir().unwrap();
        let s = scope(dir.path());
        let d = directory(&s, ".prism/documents/retained").unwrap();
        let source = d.join("source.pdf");
        fs::write(&source, b"%PDF-1.4\nfixture").unwrap();
        let (copy, id) = pdf_copy(&s, &source, None).unwrap();
        assert_eq!(copy, source);
        assert!(!s.root.join(format!(".prism/research/{id}.pdf")).exists());
        let other = tempfile::tempdir().unwrap();
        assert_ne!(
            annotation_path(&s, &id).unwrap(),
            annotation_path(&scope(other.path()), &id).unwrap()
        );
    }
    #[cfg(unix)]
    #[test]
    fn symlink_annotation_directory_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let s = scope(dir.path());
        fs::create_dir(s.root.join(".prism")).unwrap();
        std::os::unix::fs::symlink(outside.path(), s.root.join(".prism/annotations")).unwrap();
        assert!(annotation_path(&s, &"a".repeat(64)).is_err());
    }
}

//! Tauri adapter for the independent ingestor. No extraction code runs in the UI process.
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use tauri::{Emitter, Manager};
pub fn executable(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let bundled = super::resolve_resource_file(app, "ingest-runtime/bin/prism-ingest");
    let bundled = if cfg!(windows) {
        bundled.with_extension("exe")
    } else {
        bundled
    };
    if bundled.is_file() {
        return Some(bundled);
    }
    if cfg!(debug_assertions) {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/ingest/target/debug")
            .join(format!("prism-ingest{}", std::env::consts::EXE_SUFFIX));
        if dev.is_file() {
            return Some(dev);
        }
    }
    None
}
pub fn run(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    vault: &str,
    kind: &str,
    value: &str,
    method: &str,
    check: impl Fn() -> Result<(), String>,
) -> Result<String, String> {
    check()?;
    let exe = executable(app).ok_or(
        "Native ingestor is not installed; build the ingest runtime or disable ingest-rust",
    )?;
    let work = tempfile::Builder::new()
        .prefix("prism-ingest-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let mut command = Command::new(&exe);
    command
        .env("PRISM_INGEST_WORK", work.path())
        .env("PRISM_INGEST_SUPERVISED", "1");
    command.args([
        "--supervised",
        "--vault",
        vault,
        "--yt_method",
        method,
        if kind == "url" { "--urls" } else { "--files" },
        value,
    ]);
    let script = super::resolve_resource_file(app, "Extractor Final/master_extractor.py");
    if script.is_file() {
        command.arg("--python-script").arg(script);
    }
    if let Some(bin) = exe.parent() {
        command
            .env("PRISM_INGEST_BIN", bin)
            .env("PRISM_INGEST_LIB", bin.parent().unwrap().join("lib"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let _job = match WindowsJob::attach(&child) {
        Ok(job) => job,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let mut stdin = child.stdin.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let tx_err = tx.clone();
    let out_reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send((false, line)).is_err() {
                break;
            }
        }
    });
    let err_reader = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if tx_err.send((true, line)).is_err() {
                break;
            }
        }
    });
    let mut groups = HashSet::<i32>::new();
    let result = (|| {
        writeln!(stdin, "{{\"start\":true}}").map_err(|e| e.to_string())?;
        loop {
            check()?;
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok((stderr, line)) => {
                    if stderr {
                        let _ = window.emit("ingestion-error", line);
                        continue;
                    }
                    let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
                        let _ = window.emit("ingestion-progress", line);
                        continue;
                    };
                    if msg["version"] != 1 {
                        return Err("Unsupported ingestor protocol".into());
                    }
                    let message = msg["message"].as_str().unwrap_or("");
                    match msg["type"].as_str().unwrap_or("") {
                        "process_started" => {
                            if let Ok(pid) = message.parse() {
                                groups.insert(pid);
                            }
                        }
                        "process_exited" => {
                            if let Ok(pid) = message.parse() {
                                groups.remove(&pid);
                            }
                        }
                        "ready" => {
                            check()?;
                            writeln!(stdin, "{{\"commit\":true}}").map_err(|e| e.to_string())?;
                        }
                        "python_required" => {
                            check()?;
                            // Resolve/install Python only after the native worker has requested fallback.
                            let env = app.path().home_dir().map_err(|e| e.to_string())?.join(
                                if cfg!(windows) {
                                    ".prism/env/Scripts/python.exe"
                                } else {
                                    ".prism/env/bin/python"
                                },
                            );
                            if !env.is_file() && super::find_supported_python().is_none() {
                                return Err("Python fallback needs setup. Run the extractor installer, then retry.".into());
                            }
                            let python = super::find_prism_python(app);
                            check()?;
                            writeln!(stdin, "{}", serde_json::json!({"python":python}))
                                .map_err(|e| e.to_string())?;
                        }
                        "error" => {
                            let _ = window.emit("ingestion-error", message);
                        }
                        _ => {
                            let _ = window.emit("ingestion-progress", message);
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let status = child.wait().map_err(|e| e.to_string())?;
                    return if status.success() {
                        Ok("Extraction completed successfully.".into())
                    } else {
                        Err("Extraction failed. Check logs for details.".into())
                    };
                }
            }
        }
    })();
    // Include separately grouped deadline workers; children without groups inherit their parent's.
    #[cfg(unix)]
    unsafe {
        for pid in groups {
            libc::kill(-pid, libc::SIGKILL);
        }
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
    drop(stdin);
    #[cfg(windows)]
    drop(_job);
    let _ = out_reader.join();
    let _ = err_reader.join();
    result
}
#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl WindowsJob {
    fn attach(child: &std::process::Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0
            {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(Self(job))
        }
    }
}
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

use crate::{Error, Result};
use std::{
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
pub fn binary(name: &str) -> PathBuf {
    let key = format!("PRISM_INGEST_{}", name.replace('-', "_").to_uppercase());
    std::env::var_os(key)
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("PRISM_INGEST_BIN")
                .map(|p| PathBuf::from(p).join(format!("{name}{}", std::env::consts::EXE_SUFFIX)))
        })
        .unwrap_or_else(|| PathBuf::from(name))
}
pub fn run(cmd: &mut Command, timeout: Duration, cap: u64) -> Result<Vec<u8>> {
    run_inner(cmd, timeout, cap, false)
}
pub fn run_logged(cmd: &mut Command, timeout: Duration, cap: u64) -> Result<Vec<u8>> {
    run_inner(cmd, timeout, cap, true)
}
fn run_inner(cmd: &mut Command, timeout: Duration, cap: u64, logged: bool) -> Result<Vec<u8>> {
    let mut out = tempfile::NamedTempFile::new()?;
    let mut err = tempfile::NamedTempFile::new()?;
    cmd.stdout(Stdio::from(out.reopen()?))
        .stderr(Stdio::from(err.reopen()?))
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    if !cmd.get_envs().any(|(key, _)| key == "OMP_NUM_THREADS") {
        cmd.env("OMP_NUM_THREADS", crate::budget().to_string());
    }
    let mut child = cmd.spawn().map_err(|e| Error::new("unavailable", e))?;
    #[cfg(windows)]
    let _job = match Job::attach(&child) {
        Ok(job) => job,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let start = Instant::now();
    let mut finished = false;
    let result = loop {
        if logged {
            drain_log(out.as_file_mut());
            drain_log(err.as_file_mut());
        }
        if start.elapsed() > timeout {
            break Err(Error::new("timeout", "Extraction worker deadline exceeded"));
        }
        if out
            .as_file()
            .metadata()
            .map(|m| m.len())
            .unwrap_or(u64::MAX)
            > cap
            || err
                .as_file()
                .metadata()
                .map(|m| m.len())
                .unwrap_or(u64::MAX)
                > 4 * 1024 * 1024
        {
            break Err(Error::new("extract", "Tool output exceeded limit"));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                finished = true;
                break if status.success() {
                    Ok(())
                } else {
                    Err(Error::new("extract", format!("Tool exited with {status}")))
                };
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => break Err(Error::new("extract", e)),
        }
    };
    if result.is_err() && !finished {
        #[cfg(unix)]
        kill_tree(child.id() as i32);
        let _ = child.kill();
    }
    let _ = child.wait();
    if logged {
        drain_log(out.as_file_mut());
        drain_log(err.as_file_mut());
    }
    result?;
    use std::io::{Seek, SeekFrom};
    let out = out.as_file_mut();
    out.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    out.take(cap).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Enumerate descendants before terminating the parent, which avoids reparenting
/// deadline workers before their OCR/decoder children have been stopped.
#[cfg(unix)]
fn kill_tree(pid: i32) {
    unsafe {
        libc::kill(pid, libc::SIGSTOP);
    }
    let children: Vec<i32> = {
        #[cfg(target_os = "macos")]
        {
            #[link(name = "proc")]
            extern "C" {
                fn proc_listchildpids(
                    ppid: i32,
                    buffer: *mut std::ffi::c_void,
                    buffersize: i32,
                ) -> i32;
            }
            let mut pids = vec![0i32; 4096];
            let bytes = unsafe {
                proc_listchildpids(pid, pids.as_mut_ptr().cast(), (pids.len() * 4) as i32)
            };
            pids.truncate(bytes.max(0) as usize / 4);
            pids.into_iter().filter(|p| *p > 0).collect()
        }
        #[cfg(target_os = "linux")]
        {
            std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
                .unwrap_or_default()
                .split_whitespace()
                .filter_map(|s| s.parse().ok())
                .collect()
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            Vec::new()
        }
    };
    for child in children {
        kill_tree(child);
    }
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
}

#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Job {
    fn attach(child: &std::process::Child) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(Error::new("extract", std::io::Error::last_os_error()));
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle() as _) == 0
            {
                CloseHandle(handle);
                return Err(Error::new("extract", std::io::Error::last_os_error()));
            }
            Ok(Self(handle))
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

fn drain_log(file: &mut std::fs::File) {
    let mut bytes = [0u8; 8192];
    for _ in 0..32 {
        match file.read(&mut bytes) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for line in String::from_utf8_lossy(&bytes[..n]).lines() {
                    if !line.trim().is_empty() {
                        crate::event("progress", line);
                    }
                }
            }
        }
    }
}

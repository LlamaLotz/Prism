use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};
fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_prism-ingest")
}
#[test]
fn no_inputs_shows_help() {
    let out = Command::new(binary()).output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("Usage:"));
}
#[test]
fn native_text_never_needs_python() {
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("source.txt");
    std::fs::write(&input, "A complete native document.").unwrap();
    let out = Command::new(binary())
        .arg("--files")
        .arg(input)
        .arg("--vault")
        .arg(d.path().join("vault"))
        .env("PRISM_INGEST_DATA", d.path().join("data"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(d.path().join("vault/source.md").exists());
    assert!(!String::from_utf8_lossy(&out.stdout).contains("python_required"));
}
#[test]
fn supervisor_denial_preserves_existing_note() {
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("source.txt");
    let vault = d.path().join("vault");
    std::fs::create_dir(&vault).unwrap();
    std::fs::write(vault.join("source.md"), "original").unwrap();
    std::fs::write(&input, "replacement").unwrap();
    let mut child = Command::new(binary())
        .arg("--supervised")
        .arg("--files")
        .arg(input)
        .arg("--vault")
        .arg(&vault)
        .env("PRISM_INGEST_DATA", d.path().join("data"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{{\"start\":true}}").unwrap();
    for line in BufReader::new(child.stdout.take().unwrap()).lines() {
        let msg: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        if msg["type"] == "ready" {
            assert_eq!(
                std::fs::read_to_string(vault.join("source.md")).unwrap(),
                "original"
            );
            writeln!(stdin, "{{\"commit\":false}}").unwrap();
        }
    }
    assert!(!child.wait().unwrap().success());
    assert_eq!(
        std::fs::read_to_string(vault.join("source.md")).unwrap(),
        "original"
    );
    assert_eq!(
        std::fs::read_dir(d.path().join("data"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("job-"))
            .count(),
        0
    );
}
#[cfg(unix)]
#[test]
fn timeout_reaps_process() {
    let now = std::time::Instant::now();
    let err = prism_ingest::process::run(
        Command::new("sh").args(["-c", "sleep 30"]),
        std::time::Duration::from_millis(100),
        1024,
    )
    .unwrap_err();
    assert_eq!(err.kind, "timeout");
    assert!(now.elapsed() < std::time::Duration::from_secs(2));
}
#[test]
fn failed_input_preserves_note() {
    let d = tempfile::tempdir().unwrap();
    let note = d.path().join("source.md");
    std::fs::write(&note, "keep").unwrap();
    let output = Command::new(binary())
        .args(["--no-fallback", "--files", "missing.pdf", "--vault"])
        .arg(d.path())
        .env("PRISM_INGEST_DATA", d.path().join("data"))
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(std::fs::read_to_string(note).unwrap(), "keep");
}
#[cfg(unix)]
#[test]
fn python_fallback_runs_once_and_publishes_staged_output() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("source.unknown");
    std::fs::write(&input, "unsupported native format").unwrap();
    let script = d.path().join("master_extractor.py");
    std::fs::write(&script, "fixture").unwrap();
    let python = d.path().join("python-fixture");
    let counter = d.path().join("calls");
    std::fs::write(&python,format!("#!/bin/sh\necho call >> '{}'\nshift\nwhile [ \"$#\" -gt 0 ]; do\nif [ \"$1\" = '--vault' ]; then shift; vault=$1; fi\nshift\ndone\nprintf '# Converted\\n\\nFixture content.' > \"$vault/source.md\"\n",counter.display())).unwrap();
    std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
    let out = Command::new(binary())
        .arg("--files")
        .arg(input)
        .arg("--vault")
        .arg(d.path().join("vault"))
        .arg("--python-script")
        .arg(script)
        .arg("--fallback-python")
        .arg(python)
        .env("PRISM_INGEST_DATA", d.path().join("data"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert_eq!(std::fs::read_to_string(counter).unwrap(), "call\n");
    assert!(std::fs::read_to_string(d.path().join("vault/source.md"))
        .unwrap()
        .contains("Fixture content."));
}
#[test]
fn missing_external_tool_is_fallback_eligible() {
    let mut cmd = Command::new("/nonexistent/prism-ingest-tool");
    let error = prism_ingest::process::run(&mut cmd, std::time::Duration::from_millis(20), 1024)
        .unwrap_err();
    assert_eq!(error.kind, "unavailable");
}
#[test]
fn runtime_dir_lookup_falls_back_to_path() {
    let bin_key = "PRISM_INGEST_BIN";
    let old_bin = std::env::var_os(bin_key);
    let tool_key = "PRISM_INGEST_SOME_TOOL_XYZ";
    let old_tool = std::env::var_os(tool_key);
    // Runtime dir exists but does not bundle this tool: PATH fallback wins.
    std::env::set_var(bin_key, "/nonexistent/prism-runtime-bin");
    std::env::set_var(tool_key, "/explicit/tool");
    assert_eq!(
        prism_ingest::process::binary("some-tool-xyz"),
        std::path::PathBuf::from("/explicit/tool")
    );
    std::env::remove_var(tool_key);
    assert_eq!(
        prism_ingest::process::binary("some-tool-xyz"),
        std::path::PathBuf::from("some-tool-xyz")
    );
    match old_bin {
        Some(v) => std::env::set_var(bin_key, v),
        None => std::env::remove_var(bin_key),
    }
    match old_tool {
        Some(v) => std::env::set_var(tool_key, v),
        None => {}
    }
}
#[test]
fn failed_tool_reports_stderr_context() {
    #[cfg(unix)]
    {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo boom-message >&2; exit 3"]);
        let error = prism_ingest::process::run(&mut cmd, std::time::Duration::from_secs(5), 1024)
            .unwrap_err();
        assert_eq!(error.kind, "extract");
        assert!(error.message.contains("boom-message"), "{}", error.message);
    }
}

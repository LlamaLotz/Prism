/// Fixture-driven YouTube tests: a fake yt-dlp serves metadata so no network
/// or real downloader is needed.
#[cfg(unix)]
#[test]
fn explicit_captions_without_subtitles_fails_fast() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let meta = d.path().join("meta.json");
    std::fs::write(&meta, r#"{"title":"Fixture video","duration":120.0}"#).unwrap();
    // Any media-download attempt exits 1; only metadata dumps are served.
    let tool = d.path().join("yt-dlp-fixture");
    std::fs::write(
        &tool,
        format!(
            "#!/bin/sh\nif printf '%s' \"$*\" | grep -q dump-single-json; then cat '{}'; else echo 'unexpected download' >&2; exit 1; fi\n",
            meta.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
    let key = "PRISM_INGEST_YT_DLP";
    let old = std::env::var_os(key);
    std::env::set_var(key, &tool);
    let result = prism_ingest::youtube::extract(
        "https://www.youtube.com/watch?v=fixture",
        "captions",
        d.path(),
    );
    match old {
        Some(v) => std::env::set_var(key, v),
        None => std::env::remove_var(key),
    }
    // Must be a fallback-eligible quality error, not a slow download attempt.
    let err = result.unwrap_err();
    assert_eq!(err.kind, "quality");
    assert!(err.message.contains("captions"));
}

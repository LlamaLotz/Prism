use crate::{cli::Ocr, Error, Result};
use std::{path::Path, process::Command, time::Duration};
pub fn extract(
    python: &Path,
    script: &Path,
    source: &str,
    ocr: Ocr,
    method: &str,
    stage: &Path,
    scratch: &Path,
    crawl: Option<usize>,
) -> Result<()> {
    // Running a copy keeps the unchanged legacy script's logs/downloads out of signed resources.
    let runtime = scratch.join("python");
    std::fs::create_dir_all(&runtime)?;
    if let Some(max) = crawl {
        let copy = runtime.join("crawl_extractor.py");
        std::fs::copy(script.with_file_name("crawl_extractor.py"), &copy)
            .map_err(|e| Error::new("unavailable", e))?;
        let mut cmd = Command::new(python);
        // Unbuffered so progress lines stream instead of arriving on exit.
        cmd.env("PYTHONUNBUFFERED", "1").arg("-u");
        cmd.arg(copy)
            .arg(source)
            .args(["--follow-links", "--max-pages", &max.max(1).to_string()])
            .current_dir(&runtime);
        crate::process::run_logged(&mut cmd, Duration::from_secs(7200), 16 * 1024 * 1024)?;
        let bytes = std::fs::read(runtime.join("prism_output/extracted_web_content.md"))?;
        if bytes.is_empty() {
            return Err(Error::new("quality", "Crawl fallback produced no content"));
        }
        return crate::output::atomic(&stage.join("extracted_web_content.md"), &bytes);
    }
    let copy = runtime.join("master_extractor.py");
    std::fs::copy(script, &copy).map_err(|e| Error::new("unavailable", e))?;
    let mut cmd = Command::new(python);
    cmd.env("PYTHONUNBUFFERED", "1").arg("-u");
    cmd.arg(copy)
        .args(["--vault"])
        .arg(stage)
        .args([
            "--ocr",
            ocr.name(),
            "--yt_method",
            method,
            if source.starts_with("http://") || source.starts_with("https://") {
                "--urls"
            } else {
                "--files"
            },
            source,
        ])
        .env("OMP_NUM_THREADS", "1")
        .env("MKL_NUM_THREADS", "1")
        .env("KMP_DUPLICATE_LIB_OK", "TRUE");
    crate::process::run_logged(&mut cmd, Duration::from_secs(7200), 16 * 1024 * 1024)?;
    fn preserve(source: &Path, dest: &Path) -> Result<()> {
        if !source.is_dir() {
            return Ok(());
        }
        std::fs::create_dir_all(dest)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            let target = dest.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                preserve(&entry.path(), &target)?;
            } else if entry.file_type()?.is_file() {
                std::fs::copy(entry.path(), target)?;
            }
        }
        Ok(())
    }
    let diagnostics = crate::data_dir().join("raw_service_files").join(format!(
        "python_{}",
        scratch.file_name().unwrap_or_default().to_string_lossy()
    ));
    preserve(
        &runtime.join("prism_output/raw_service_files"),
        &diagnostics,
    )?;
    preserve(&runtime.join("logs"), &diagnostics.join("logs"))?;
    let notes = std::fs::read_dir(stage)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|e| e == "md"))
        .collect::<Vec<_>>();
    if notes.is_empty() {
        return Err(Error::new(
            "quality",
            "Python succeeded without producing a note",
        ));
    }
    for note in notes {
        let text = std::fs::read_to_string(note.path())?;
        if text.trim().is_empty()
            || [
                "No content extracted.",
                "[PDF extraction produced no text]",
                "Office conversion failed:",
            ]
            .iter()
            .any(|v| text.contains(v))
        {
            return Err(Error::new(
                "quality",
                "Python produced an extraction failure placeholder",
            ));
        }
    }
    Ok(())
}

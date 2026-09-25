use clap::Parser;
use prism_ingest::{cli::Args, event, Error, Result};
use std::{
    io::BufRead,
    sync::mpsc,
    time::{Duration, Instant},
};
/// Backstop for stages without their own deadline (notably CPU-bound HTML
/// parsing, which runs much slower in unoptimized dev builds). The worker
/// thread cannot be cancelled mid-parse, so on expiry it is abandoned and
/// the source fails over; the thread exits on its own and process-level
/// cancellation stays with the Tauri adapter.
const SOURCE_DEADLINE: Duration = Duration::from_secs(600);
fn answer() -> Result<serde_json::Value> {
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    serde_json::from_str(&line).map_err(|e| Error::new("protocol", e))
}
/// Run one source with a backstop deadline. Blocking extraction stages
/// (network with timeouts, CPU-bound parsing) normally finish far inside
/// it; expiry yields a fallback-eligible timeout instead of a silent stall.
fn extract_one(
    source: &str,
    ocr: prism_ingest::cli::Ocr,
    method: &str,
    follow_links: bool,
    max_pages: usize,
    scratch: &std::path::Path,
) -> Result<prism_ingest::Extraction> {
    let (tx, rx) = mpsc::channel();
    let task_source = source.to_owned();
    let task_method = method.to_owned();
    let task_scratch = scratch.to_owned();
    std::thread::spawn(move || {
        let result = if follow_links && task_source.starts_with("http") {
            prism_ingest::web::crawl(&task_source, max_pages)
        } else {
            prism_ingest::extract(&task_source, ocr, &task_method, &task_scratch)
        };
        let _ = tx.send(result);
    });
    let start = Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if start.elapsed() > SOURCE_DEADLINE {
                    event(
                        "diagnostic",
                        format!("Source deadline exceeded for {source}; abandoning native attempt"),
                    );
                    return Err(Error::new(
                        "timeout",
                        "Per-source extraction deadline exceeded",
                    ));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(Error::new("extract", "Extraction worker thread died"))
            }
        }
    }
}
fn run(args: Args) -> Result<()> {
    if let Some(path) = &args.pdf_chunk {
        let text = prism_ingest::pdf::range(path, args.page_start, args.page_end, args.ocr)?;
        return prism_ingest::output::atomic(
            args.chunk_output
                .as_ref()
                .ok_or_else(|| Error::new("input", "Missing chunk output"))?,
            text.as_bytes(),
        );
    }
    if args.supervised && answer()?["start"] != true {
        return Err(Error::new("cancelled", "Start denied"));
    }
    let sources = args.sources()?;
    if sources.is_empty() {
        return Err(Error::new("input", "Specify --files or --urls"));
    }
    let data = prism_ingest::data_dir();
    std::fs::create_dir_all(&data)?;
    let vault = args
        .vault
        .clone()
        .unwrap_or_else(|| data.join("main_extractions"));
    let mut failed = false;
    for (i, (source, ocr)) in sources.iter().enumerate() {
        event(
            "progress",
            format!("{}/{} Processing {}", i + 1, sources.len(), source),
        );
        let work = std::env::var_os("PRISM_INGEST_WORK")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| data.clone());
        let scratch = tempfile::Builder::new().prefix("job-").tempdir_in(&work)?;
        let stage = scratch.path().join("staged");
        std::fs::create_dir(&stage)?;
        let result = extract_one(
            source,
            *ocr,
            &args.yt_method,
            args.follow_links,
            args.max_pages,
            scratch.path(),
        );
        let staged = match result {
            Ok(e) => {
                let raw = data.join("raw_service_files").join(format!(
                    "item_{}_{}",
                    i + 1,
                    scratch.path().file_name().unwrap().to_string_lossy()
                ));
                prism_ingest::output::atomic(&raw.join("extraction.md"), e.body.as_bytes())?;
                prism_ingest::output::atomic(
                    &raw.join("extraction_meta.json"),
                    serde_json::json!({"title":e.title,"url":e.source,"selected_service":e.engine,"reason":"Native extraction succeeded","timestamp":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs_f64()})
                        .to_string()
                        .as_bytes(),
                )?;
                prism_ingest::output::stage(&e, &stage)
            }
            Err(e) if e.fallback() && !args.no_fallback && args.python_script.is_some() => {
                event(
                    "diagnostic",
                    format!("Native extraction unavailable: {e}. Trying Python once."),
                );
                let python = if args.supervised {
                    event("python_required", source);
                    let response = answer()?;
                    response["python"]
                        .as_str()
                        .map(std::path::PathBuf::from)
                        .ok_or_else(|| Error::new("protocol", "Missing Python executable"))?
                } else {
                    args.fallback_python.clone().unwrap_or_else(|| {
                        data.parent().unwrap().join(if cfg!(windows) {
                            "env/Scripts/python.exe"
                        } else {
                            "env/bin/python"
                        })
                    })
                };
                prism_ingest::fallback::extract(
                    &python,
                    args.python_script.as_ref().unwrap(),
                    source,
                    *ocr,
                    &args.yt_method,
                    &stage,
                    scratch.path(),
                    args.follow_links.then_some(args.max_pages),
                )
            }
            Err(e) => Err(e),
        };
        if let Err(e) = staged {
            prism_ingest::error_event(&e);
            failed = true;
            continue;
        }
        if args.supervised {
            event("ready", source);
            if answer()?["commit"] != true {
                return Err(Error::new("cancelled", "Commit denied"));
            }
        }
        prism_ingest::output::publish(&stage, &vault)?;
        event(
            "result",
            format!("{}/{} Completed {}", i + 1, sources.len(), source),
        );
    }
    if failed {
        Err(Error::new("extract", "One or more sources failed"))
    } else {
        Ok(())
    }
}
fn main() {
    std::env::set_var("RAYON_NUM_THREADS", prism_ingest::budget().to_string());
    if let Err(e) = run(Args::parse()) {
        prism_ingest::error_event(&e);
        std::process::exit(1);
    }
}

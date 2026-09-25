pub mod assets;
pub mod audio;
pub mod cli;
pub mod docs;
pub mod fallback;
pub mod output;
pub mod pdf;
pub mod process;
pub mod web;
pub mod youtube;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Serialize, Deserialize)]
pub struct Error {
    pub kind: String,
    pub message: String,
}
impl Error {
    pub fn new(kind: &str, message: impl ToString) -> Self {
        Self {
            kind: kind.into(),
            message: message.to_string(),
        }
    }
    pub fn fallback(&self) -> bool {
        matches!(
            self.kind.as_str(),
            "unavailable" | "unsupported" | "quality" | "extract" | "timeout"
        )
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new("io", e)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Extraction {
    pub title: String,
    pub stem: String,
    pub body: String,
    pub engine: String,
    pub source: String,
    pub kind: String,
}
pub fn budget() -> usize {
    let hardware = (std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        / 2)
    .clamp(1, 8);
    std::env::var("PRISM_INGEST_THREADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(hardware)
        .clamp(1, hardware)
}
pub fn data_dir() -> PathBuf {
    std::env::var_os("PRISM_INGEST_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(
                std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .unwrap_or_default(),
            )
            .join(".prism/ingest")
        })
}
pub fn event(kind: &str, message: impl ToString) {
    use std::io::Write;
    let payload = serde_json::json!({"version":1,"type":kind,"message":message.to_string()});
    println!("{payload}");
    let dir = data_dir().join("logs");
    if std::fs::create_dir_all(&dir).is_ok() {
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(format!("prism-{}.jsonl", std::process::id())))
        {
            let _ = writeln!(file, "{payload}");
        }
    }
}
pub fn error_event(error: &Error) {
    println!(
        "{}",
        serde_json::json!({"version":1,"type":"error","code":error.kind,"message":error.to_string()})
    );
}
pub fn meaningful(text: &str) -> usize {
    static MARKER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let marker =
        MARKER.get_or_init(|| regex::Regex::new(r"(?i)^\s*(page|p\.?)\s*[-.]?\s*\d+\s*$").unwrap());
    text.lines()
        .filter(|l| !marker.is_match(l))
        .map(|l| l.split_whitespace().count())
        .sum()
}
pub fn extract(source: &str, ocr: cli::Ocr, method: &str, scratch: &Path) -> Result<Extraction> {
    if let Ok(url) = url::Url::parse(source) {
        if matches!(url.scheme(), "http" | "https") {
            let host = url.host_str().unwrap_or("");
            return if host == "youtu.be" || host == "youtube.com" || host.ends_with(".youtube.com")
            {
                youtube::extract(source, method, scratch)
            } else {
                web::extract(source)
            };
        }
    }
    let path = Path::new(source);
    if !path.is_file() {
        return Err(Error::new("input", "Source file does not exist"));
    }
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let (body, engine, kind) = match ext.as_str() {
        "pdf" => (pdf::extract(path, ocr, scratch)?, "Prism PDF", "document"),
        "docx" | "pptx" | "xlsx" | "html" | "htm" | "txt" | "md" => {
            (docs::extract(path)?, "Prism Documents", "document")
        }
        "png" | "jpg" | "jpeg" | "webp" => (pdf::ocr_image(path)?, "Tesseract OCR", "document"),
        "mp3" | "wav" | "m4a" | "flac" | "aac" | "ogg" | "mp4" | "mov" | "mkv" | "avi" | "webm" => {
            (audio::extract(path, scratch)?, "Whisper.cpp ASR", "audio")
        }
        _ => {
            return Err(Error::new(
                "unsupported",
                format!("Unsupported format: {ext}"),
            ))
        }
    };
    if body.trim().is_empty() {
        return Err(Error::new("quality", "Extraction produced no content"));
    }
    Ok(Extraction {
        title: path.file_name().unwrap().to_string_lossy().into(),
        stem: path.file_stem().unwrap().to_string_lossy().into(),
        body,
        engine: engine.into(),
        source: source.into(),
        kind: kind.into(),
    })
}

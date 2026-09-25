use clap::{Parser, ValueEnum};
use std::path::PathBuf;
#[derive(Debug, Clone, Copy, ValueEnum, PartialEq)]
pub enum Ocr {
    Adaptive,
    On,
    Off,
}
impl Ocr {
    pub fn parse(s: &str) -> crate::Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "adaptive" | "a" => Ok(Self::Adaptive),
            "on" | "o" => Ok(Self::On),
            "off" | "n" => Ok(Self::Off),
            _ => Err(crate::Error::new("input", "Invalid OCR mode")),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Adaptive => "adaptive",
            Self::On => "on",
            Self::Off => "off",
        }
    }
}
#[derive(Debug, Parser)]
#[command(
    version,
    about = "Native Prism document ingestor",
    arg_required_else_help = true
)]
pub struct Args {
    #[arg(long)]
    pub vault: Option<PathBuf>,
    #[arg(long,num_args=1..)]
    pub files: Vec<String>,
    #[arg(long,num_args=1..)]
    pub urls: Vec<String>,
    #[arg(long = "yt_method", default_value = "auto")]
    pub yt_method: String,
    #[arg(long, value_enum, default_value = "adaptive")]
    pub ocr: Ocr,
    #[arg(long)]
    pub follow_links: bool,
    #[arg(long, default_value_t = 10)]
    pub max_pages: usize,
    #[arg(long)]
    pub fallback_python: Option<PathBuf>,
    #[arg(long)]
    pub python_script: Option<PathBuf>,
    #[arg(long)]
    pub no_fallback: bool,
    #[arg(long, hide = true)]
    pub supervised: bool,
    #[arg(long, hide = true)]
    pub pdf_chunk: Option<PathBuf>,
    #[arg(long, hide = true, default_value_t = 0)]
    pub page_start: u32,
    #[arg(long, hide = true, default_value_t = 0)]
    pub page_end: u32,
    #[arg(long, hide = true)]
    pub chunk_output: Option<PathBuf>,
}
impl Args {
    pub fn sources(&self) -> crate::Result<Vec<(String, Ocr)>> {
        let default = if ["A", "O", "N"].contains(&self.yt_method.as_str()) {
            Ocr::parse(&self.yt_method)?
        } else {
            self.ocr
        };
        self.files
            .iter()
            .chain(&self.urls)
            .map(|s| {
                let (p, m) = s
                    .rsplit_once('|')
                    .map(|(p, m)| Ok::<_, crate::Error>((p, Ocr::parse(m)?)))
                    .unwrap_or(Ok((s.as_str(), default)))?;
                Ok((p.to_owned(), m))
            })
            .collect()
    }
}

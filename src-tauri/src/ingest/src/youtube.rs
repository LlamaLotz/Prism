use crate::{Error, Extraction, Result};
use std::{path::Path, process::Command, sync::OnceLock, time::Duration};
fn tag_stripper() -> &'static regex::Regex {
    static STRIPPER: OnceLock<regex::Regex> = OnceLock::new();
    STRIPPER.get_or_init(|| regex::Regex::new(r"<[^>]+>").unwrap())
}
pub fn clean(text: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(events) = value["events"].as_array() {
            return events
                .iter()
                .filter_map(|e| e["segs"].as_array())
                .flat_map(|s| s.iter())
                .filter_map(|s| s["utf8"].as_str())
                .collect::<Vec<_>>()
                .join("")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
        }
    }
    let tags = tag_stripper();
    let plain = tags.replace_all(text, " ");
    let mut lines = Vec::new();
    let mut style = false;
    for line in plain.lines() {
        let line = line.trim();
        if line.starts_with("STYLE") {
            style = true;
            continue;
        }
        if line.is_empty() {
            style = false;
            continue;
        }
        if style
            || line.starts_with("WEBVTT")
            || line.starts_with("Kind:")
            || line.starts_with("Language:")
            || line.contains("-->")
            || line.chars().all(|c| c.is_ascii_digit())
        {
            continue;
        }
        let line = html2md::parse_html(line)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if lines.last() != Some(&line) {
            lines.push(line);
        }
    }
    lines.join(" ")
}
pub fn captions_acceptable(text: &str, duration: Option<f64>) -> bool {
    let n = crate::meaningful(text);
    n >= 50 || (duration.is_some_and(|d| d <= 60.0) && n >= 10)
}
pub fn extract(url: &str, method: &str, scratch: &Path) -> Result<Extraction> {
    let mut cmd = Command::new(crate::process::binary("yt-dlp"));
    cmd.args([
        "--no-playlist",
        "--skip-download",
        "--dump-single-json",
        "--",
        url,
    ]);
    let bytes = crate::process::run(&mut cmd, Duration::from_secs(120), 16 * 1024 * 1024)?;
    let meta: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| Error::new("extract", e))?;
    let title = meta["title"].as_str().unwrap_or("YouTube video").to_owned();
    let method = match method {
        "captions" | "caption" | "native" | "yt-dlp" | "yt_dlp" => "captions",
        "whisper" | "asr" | "whisper_asr" => "whisper",
        _ => "auto",
    };
    let mut captions = String::new();
    if method != "whisper" {
        let client = crate::web::client(None)?;
        'outer: for key in ["subtitles", "automatic_captions"] {
            if let Some(langs) = meta[key].as_object() {
                for (lang, formats) in langs {
                    if lang != "en" && !lang.starts_with("en-") {
                        continue;
                    }
                    for ext in ["json3", "vtt", "srv1", "ttml"] {
                        if let Some(formats) = formats.as_array() {
                            for format in formats {
                                if format["ext"] == ext {
                                    if let Some(url) = format["url"].as_str() {
                                        if let Ok(text) = crate::web::fetch(&client, url) {
                                            captions = clean(&text);
                                            if !captions.is_empty() {
                                                break 'outer;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    // Explicit captions mode fails fast so the adapter retries once with
    // Python; downloading media for Whisper here would be slow and surprising.
    if method == "captions" && captions.is_empty() {
        return Err(Error::new("quality", "No native captions available"));
    }
    let use_captions = method == "captions" && !captions.is_empty()
        || method == "auto" && captions_acceptable(&captions, meta["duration"].as_f64());
    let (body, engine) = if use_captions {
        (captions, "yt-dlp Native")
    } else {
        let media = scratch.join("media.audio");
        let mut cmd = Command::new(crate::process::binary("yt-dlp"));
        cmd.args([
            "--no-playlist",
            "-f",
            "bestaudio/best",
            "--no-progress",
            "-o",
        ])
        .arg(&media)
        .args(["--", url]);
        crate::process::run(&mut cmd, Duration::from_secs(7200), 4 * 1024 * 1024)?;
        (crate::audio::extract(&media, scratch)?, "Whisper.cpp ASR")
    };
    Ok(Extraction {
        stem: title.clone(),
        title,
        body,
        source: url.into(),
        engine: engine.into(),
        kind: "youtube".into(),
    })
}

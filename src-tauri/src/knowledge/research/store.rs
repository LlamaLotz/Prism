//! Content-addressed research cache and promoted web snapshots.
use crate::knowledge::operations;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::dedupe::sha256_hex;

pub(crate) const EXTRACTOR: &str = "prism-html-v1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceMeta {
    pub url: String,
    pub title: String,
    pub fetched_at: i64,
    pub content_type: String,
    pub extractor: String,
    pub hash: String,
}

pub(crate) fn research_root(root: &Path) -> PathBuf {
    root.join(".prism/research")
}
pub(crate) fn cache_dir(root: &Path) -> PathBuf {
    research_root(root).join("cache")
}
pub(crate) fn sources_dir(root: &Path) -> PathBuf {
    research_root(root).join("sources")
}
pub(crate) fn sessions_dir(root: &Path) -> PathBuf {
    research_root(root).join("sessions")
}

fn ensure_dir(root: &Path, dir: &Path) -> Result<(), String> {
    operations::validate(root, dir)?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())
}

pub(crate) fn valid_sha(sha: &str) -> bool {
    sha.len() == 64 && sha.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn web_key(sha: &str) -> String {
    format!("web:{sha}")
}

/// Extracts the content hash from a `web:<sha256>` source key.
pub(crate) fn key_sha(key: &str) -> Option<&str> {
    let sha = key.strip_prefix("web:")?;
    valid_sha(sha).then_some(sha)
}

fn paths(dir: &Path, sha: &str) -> (PathBuf, PathBuf) {
    (dir.join(format!("{sha}.md")), dir.join(format!("{sha}.json")))
}

fn write_bytes(root: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    operations::validate(root, path)?;
    if let Some(parent) = path.parent() {
        ensure_dir(root, parent)?;
    }
    operations::atomic_write(path, bytes, false)
}

fn read_pair(dir: &Path, sha: &str) -> Option<(SourceMeta, String)> {
    if !valid_sha(sha) {
        return None;
    }
    let (text_path, meta_path) = paths(dir, sha);
    let text = std::fs::read_to_string(text_path).ok()?;
    let raw = std::fs::read_to_string(meta_path).ok()?;
    let meta: SourceMeta = serde_json::from_str(&raw).ok()?;
    if meta.hash != sha || sha256_hex(&text) != sha {
        return None;
    }
    Some((meta, text))
}

fn write_pair(root: &Path, dir: &Path, meta: &SourceMeta, text: &str) -> Result<(), String> {
    if !valid_sha(&meta.hash) || sha256_hex(text) != meta.hash {
        return Err("Content hash does not match the extracted text".into());
    }
    if let Some((existing, body)) = read_pair(dir, &meta.hash) {
        if existing == *meta && body == text {
            return Ok(());
        }
    }
    ensure_dir(root, dir)?;
    let (text_path, meta_path) = paths(dir, &meta.hash);
    write_bytes(root, &text_path, text.as_bytes())?;
    let raw = serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?;
    write_bytes(root, &meta_path, &raw)
}

pub(crate) fn write_cache(root: &Path, meta: &SourceMeta, text: &str) -> Result<(), String> {
    write_pair(root, &cache_dir(root), meta, text)
}

pub(crate) fn cache_source(root: &Path, sha: &str) -> Option<(SourceMeta, String)> {
    read_pair(&cache_dir(root), sha)
}

pub(crate) fn snapshot_source(root: &Path, sha: &str) -> Option<(SourceMeta, String)> {
    read_pair(&sources_dir(root), sha)
}

pub(crate) fn cache_exists(root: &Path, sha: &str) -> bool {
    cache_source(root, sha).is_some()
}

pub(crate) fn snapshot_exists(root: &Path, sha: &str) -> bool {
    snapshot_source(root, sha).is_some()
}

/// Copies a cache entry into the permanent snapshot store. Snapshot files are
/// what notebook sources resolve; cache entries alone are never sources.
pub(crate) fn promote(root: &Path, sha: &str) -> Result<SourceMeta, String> {
    if let Some((meta, _)) = snapshot_source(root, sha) {
        return Ok(meta);
    }
    let (meta, text) = cache_source(root, sha).ok_or("Source is no longer in the research cache")?;
    write_pair(root, &sources_dir(root), &meta, &text)?;
    Ok(meta)
}

pub(crate) struct StoredPreview {
    pub title: String,
    pub text: String,
    pub url: Option<String>,
    pub chars: usize,
}

/// Preview prefers a promoted snapshot and falls back to the discovery cache.
pub(crate) fn preview(root: &Path, key: &str, limit: usize) -> Result<StoredPreview, String> {
    let sha = key_sha(key).ok_or("Preview is only available for web source keys")?;
    let (meta, text) = snapshot_source(root, sha)
        .or_else(|| cache_source(root, sha))
        .ok_or("This web source is not available")?;
    let chars = text.chars().count();
    let text: String = text.chars().take(limit).collect();
    Ok(StoredPreview {
        title: if meta.title.is_empty() {
            meta.url.clone()
        } else {
            meta.title
        },
        text,
        url: Some(meta.url),
        chars,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(text: &str) -> SourceMeta {
        SourceMeta {
            url: "https://example.com/article".into(),
            title: "Example article".into(),
            fetched_at: 1_700_000_000,
            content_type: "text/html; charset=utf-8".into(),
            extractor: EXTRACTOR.into(),
            hash: sha256_hex(text),
        }
    }

    #[test]
    fn snapshot_metadata_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let text = "Readable article body";
        let meta = meta(text);
        write_cache(root, &meta, text).unwrap();
        let promoted = promote(root, &meta.hash).unwrap();
        assert_eq!(promoted, meta);
        let (read, body) = snapshot_source(root, &meta.hash).unwrap();
        assert_eq!(read, meta);
        assert_eq!(body, text);
        assert!(!cache_exists(root, &"0".repeat(64)));
    }

    #[test]
    fn identical_content_reuses_cache_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let text = "Same extracted content";
        let meta = meta(text);
        write_cache(root, &meta, text).unwrap();
        let path = cache_dir(root).join(format!("{}.md", meta.hash));
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        write_cache(root, &meta, text).unwrap();
        let after = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(before, after);
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
    }

    #[test]
    fn preview_prefers_snapshot_and_bounds_text() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let text = "x".repeat(25_000);
        let meta = meta(&text);
        write_cache(root, &meta, &text).unwrap();
        promote(root, &meta.hash).unwrap();
        let preview = preview(root, &web_key(&meta.hash), 20_000).unwrap();
        assert_eq!(preview.chars, 25_000);
        assert_eq!(preview.text.chars().count(), 20_000);
        assert_eq!(preview.url.as_deref(), Some("https://example.com/article"));
    }
}

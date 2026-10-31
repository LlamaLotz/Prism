//! Save selected research sources as plain vault notes.
//!
//! Notes land in `Researched Sources/<batch>/`, where `<batch>` is a safe,
//! frontend-supplied folder segment such as `2026-10-31 15-42-09`. Saving a
//! candidate never touches a notebook: the notes are ordinary Markdown files
//! that the vault indexer picks up like any other note.
use super::{dedupe, store};
use crate::engine::indexer::{suppress_self_write, SELF_WRITE_MASK_MS};
use crate::knowledge::operations;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub(crate) const NOTES_ROOT: &str = "Researched Sources";
const MAX_FOLDER_CHARS: usize = 80;
const MAX_FILENAME_CHARS: usize = 80;
const MAX_BATCH: usize = 100;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResearchNotes {
    /// Actual vault-relative batch folder (collision suffixes included).
    pub folder: String,
    /// Vault-relative paths of the notes written in this batch.
    pub paths: Vec<String>,
}

/// A resolved snapshot with its extracted text, ready to become a note.
struct ResolvedSource {
    meta: store::SourceMeta,
    text: String,
}

/// A batch that has been written to disk and still needs indexing.
pub(crate) struct PreparedNotes {
    pub result: ResearchNotes,
    pub writes: Vec<(PathBuf, String)>,
}

/// Validates the single folder segment the frontend supplies.
pub(crate) fn validate_folder(folder: &str) -> Result<String, String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return Err("Enter a folder name".into());
    }
    if folder.chars().count() > MAX_FOLDER_CHARS {
        return Err("Folder names are limited to 80 characters".into());
    }
    if folder == "." || folder.contains("..") {
        return Err("Folder names must not contain '.' path segments".into());
    }
    if !folder
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
    {
        return Err(
            "Folder names may only contain letters, numbers, spaces, '-', '_' and '.'".into(),
        );
    }
    Ok(folder.to_owned())
}

fn invalid_filename_char(c: char) -> bool {
    c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
}

/// Turns a source title into a Windows-safe, collapsed filename stem.
pub(crate) fn sanitize_filename(title: &str) -> String {
    let mut cleaned = String::with_capacity(title.len());
    for c in title.chars() {
        cleaned.push(if invalid_filename_char(c) { ' ' } else { c });
    }
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|c: char| c == '.' || c == ' ');
    let mut limited: String = trimmed.chars().take(MAX_FILENAME_CHARS).collect();
    while limited.ends_with('.') || limited.ends_with(' ') {
        limited.pop();
    }
    if limited.is_empty() {
        "Source".into()
    } else {
        limited
    }
}

fn filename_with_suffix(base: &str, index: usize) -> String {
    if index <= 1 {
        return base.to_owned();
    }
    let suffix = format!(" {index}");
    let keep = MAX_FILENAME_CHARS.saturating_sub(suffix.chars().count());
    let mut stem: String = base.chars().take(keep).collect();
    while stem.ends_with('.') || stem.ends_with(' ') {
        stem.pop();
    }
    if stem.is_empty() {
        stem.push_str("Source");
    }
    format!("{stem}{suffix}")
}

/// Returns a stem that is unique both within this batch and on disk.
/// Comparison is case-insensitive so Windows and macOS do not collide later.
pub(crate) fn unique_filename(base: &str, used: &mut HashSet<String>, dir: &Path) -> String {
    // Seed with the directory's existing entries, lowercased, so a case-only
    // difference is treated as a collision even on case-sensitive filesystems.
    let existing: HashSet<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_lowercase))
        .collect();
    let mut index = 1usize;
    loop {
        let candidate = filename_with_suffix(base, index);
        let key = candidate.to_lowercase();
        let path = dir.join(format!("{candidate}.md"));
        if !used.contains(&key) && !existing.contains(&format!("{key}.md")) && !path.exists() {
            used.insert(key);
            return candidate;
        }
        index += 1;
    }
}

fn single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Display title for a note: source title, then domain, then URL, then "Source".
pub(crate) fn source_title(meta: &store::SourceMeta) -> String {
    let title = single_line(&meta.title);
    if !title.is_empty() {
        return title;
    }
    let domain = dedupe::domain(&meta.url);
    if !domain.is_empty() {
        return domain;
    }
    let url = meta.url.trim();
    if !url.is_empty() {
        return url.to_owned();
    }
    "Source".into()
}

/// Formats a UNIX timestamp (UTC) as `YYYY-MM-DD`, reusing the app's existing
/// civil-date helper instead of pulling in a date/time dependency.
pub(crate) fn retrieved_date(epoch_secs: i64) -> String {
    let (year, month, day, _, _, _) = crate::civil_from_epoch(epoch_secs);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Quotes a value for a YAML double-quoted scalar.
pub(crate) fn yaml_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Builds the complete Markdown note: YAML frontmatter, title heading, source
/// line, then the extracted text.
pub(crate) fn render_note(meta: &store::SourceMeta, text: &str) -> String {
    let title = source_title(meta);
    let domain = dedupe::domain(&meta.url);
    let url = meta.url.trim();
    let source_line = if url.is_empty() {
        domain.clone()
    } else {
        let label = if domain.is_empty() { url } else { &domain };
        format!("[{label}]({url})")
    };
    let body = text.trim();
    let body = if body.is_empty() {
        String::new()
    } else {
        format!("\n{body}\n")
    };
    format!(
        "---\ntitle: {}\nsource: {}\ndomain: {}\nretrieved: {}\ntype: source\n---\n\n# {}\n\nSource: {}\n{}",
        yaml_quote(&title),
        yaml_quote(url),
        yaml_quote(&domain),
        yaml_quote(&retrieved_date(meta.fetched_at)),
        single_line(&title),
        source_line,
        body
    )
}

/// Drops later duplicates by content hash or canonical URL within one batch.
fn dedupe_sources(sources: Vec<ResolvedSource>) -> Vec<ResolvedSource> {
    let mut hashes = HashSet::new();
    let mut urls = HashSet::new();
    sources
        .into_iter()
        .filter(|source| {
            let hash = source.meta.hash.as_str();
            let url = dedupe::normalize_url(&source.meta.url);
            let duplicate_hash = !hash.is_empty() && hashes.contains(hash);
            let duplicate_url = url.as_ref().is_some_and(|url| urls.contains(url));
            if duplicate_hash || duplicate_url {
                return false;
            }
            if !hash.is_empty() {
                hashes.insert(hash.to_owned());
            }
            if let Some(url) = url {
                urls.insert(url);
            }
            true
        })
        .collect()
}

/// Resolves every key from the promoted snapshot first, then the cache. A
/// notebook membership is deliberately not required.
fn resolve_sources(root: &Path, keys: &[String]) -> Result<Vec<ResolvedSource>, String> {
    let mut sources = Vec::new();
    for raw in keys {
        let key = crate::study::normalize_key(raw);
        let Some(sha) = store::key_sha(&key) else {
            return Err(format!("{key} is not a web source key"));
        };
        let Some((meta, text)) =
            store::snapshot_source(root, sha).or_else(|| store::cache_source(root, sha))
        else {
            return Err(format!(
                "{key} is no longer available in the research cache"
            ));
        };
        sources.push(ResolvedSource { meta, text });
    }
    Ok(dedupe_sources(sources))
}

/// Creates `Researched Sources/<folder>`, suffixing ` 2`, ` 3`, ... when the
/// folder already exists. Returns the vault-relative folder and its path.
pub(crate) fn create_batch_folder(root: &Path, folder: &str) -> Result<(String, PathBuf), String> {
    let base = validate_folder(folder)?;
    let parent = root.join(NOTES_ROOT);
    operations::validate(root, &parent)?;
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let mut index = 1usize;
    loop {
        let name = if index == 1 {
            base.clone()
        } else {
            format!("{base} {index}")
        };
        let dir = parent.join(&name);
        operations::validate(root, &dir)?;
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok((format!("{NOTES_ROOT}/{name}"), dir)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                index += 1;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

/// Writes every unique source as a note and returns the files to index.
pub(crate) fn prepare_notes(
    root: &Path,
    keys: &[String],
    folder: &str,
) -> Result<PreparedNotes, String> {
    if keys.is_empty() {
        return Err("Select at least one source to save".into());
    }
    if keys.len() > MAX_BATCH {
        return Err("Save at most 100 sources at once".into());
    }
    let sources = resolve_sources(root, keys)?;
    let (folder, dir) = create_batch_folder(root, folder)?;
    let mut used = HashSet::new();
    let mut paths = Vec::with_capacity(sources.len());
    let mut writes = Vec::with_capacity(sources.len());
    for source in &sources {
        let stem = unique_filename(&sanitize_filename(&source_title(&source.meta)), &mut used, &dir);
        let path = dir.join(format!("{stem}.md"));
        operations::validate(root, &path)?;
        let content = render_note(&source.meta, &source.text);
        // Mask the create so the watcher does not re-index the same write.
        suppress_self_write(&path, SELF_WRITE_MASK_MS);
        operations::atomic_write(&path, content.as_bytes(), true)?;
        paths.push(format!("{folder}/{stem}.md"));
        writes.push((path, content));
    }
    Ok(PreparedNotes {
        result: ResearchNotes { folder, paths },
        writes,
    })
}

#[tauri::command]
pub fn research_create_notes(
    app: tauri::AppHandle,
    vault_path: String,
    keys: Vec<String>,
    folder: String,
) -> Result<ResearchNotes, String> {
    let scope = crate::study::scope(&app, &vault_path)?;
    let _lock = operations::lock()?;
    let prepared = prepare_notes(&scope.root, &keys, &folder)?;
    for (path, content) in &prepared.writes {
        crate::knowledge::sync_file(&app, path, content)?;
    }
    Ok(prepared.result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(url: &str, title: &str, hash: &str, fetched_at: i64) -> store::SourceMeta {
        store::SourceMeta {
            url: url.into(),
            title: title.into(),
            fetched_at,
            content_type: "text/html; charset=utf-8".into(),
            extractor: store::EXTRACTOR.into(),
            hash: hash.into(),
        }
    }

    fn source(url: &str, hash: &str, text: &str) -> ResolvedSource {
        ResolvedSource {
            meta: meta(url, "", hash, 0),
            text: text.into(),
        }
    }

    #[test]
    fn folder_names_are_validated_and_trimmed() {
        assert_eq!(
            validate_folder("  2026-10-31 15-42-09  ").unwrap(),
            "2026-10-31 15-42-09"
        );
        assert_eq!(validate_folder("Batch_01.v2").unwrap(), "Batch_01.v2");
        for (folder, reason) in [
            ("", "empty"),
            ("   ", "blank"),
            (".", "dot segment"),
            ("..", "parent segment"),
            ("../escape", "parent traversal"),
            ("a/b", "forward slash"),
            ("a\\b", "backslash"),
            ("C:name", "colon"),
            ("bad*name", "wildcard"),
            (&"x".repeat(81), "too long"),
        ] {
            assert!(
                validate_folder(folder).is_err(),
                "{reason} folder {folder:?} should be rejected"
            );
        }
    }

    #[test]
    fn batch_folders_get_numbered_suffixes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (first, first_dir) = create_batch_folder(root, "2026-10-31 15-42-09").unwrap();
        let (second, _) = create_batch_folder(root, "2026-10-31 15-42-09").unwrap();
        let (third, _) = create_batch_folder(root, "2026-10-31 15-42-09").unwrap();
        assert_eq!(first, "Researched Sources/2026-10-31 15-42-09");
        assert_eq!(second, "Researched Sources/2026-10-31 15-42-09 2");
        assert_eq!(third, "Researched Sources/2026-10-31 15-42-09 3");
        assert!(first_dir.is_dir());
    }

    #[test]
    fn filenames_are_slugged_and_collisions_are_case_insensitive() {
        assert_eq!(
            sanitize_filename("  A / B : C * ? \" < > | D.  "),
            "A B C D"
        );
        assert_eq!(sanitize_filename("... trimmed ..."), "trimmed");
        assert_eq!(sanitize_filename("   "), "Source");
        assert_eq!(sanitize_filename(&"x".repeat(120)).chars().count(), 80);

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut used = HashSet::new();
        assert_eq!(unique_filename("Note", &mut used, root), "Note");
        assert_eq!(unique_filename("Note", &mut used, root), "Note 2");
        assert_eq!(unique_filename("note", &mut used, root), "note 3");
    }

    #[test]
    fn existing_files_are_avoided_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("Existing.md"), "note").unwrap();
        let mut used = HashSet::new();
        assert_eq!(unique_filename("existing", &mut used, root), "existing 2");
    }

    #[test]
    fn unix_timestamps_format_as_utc_dates() {
        assert_eq!(retrieved_date(0), "1970-01-01");
        assert_eq!(retrieved_date(86_400), "1970-01-02");
        assert_eq!(retrieved_date(1_700_000_000), "2023-11-14");
        assert_eq!(retrieved_date(1_741_741_200), "2025-03-12");
    }

    #[test]
    fn note_markdown_has_escaped_frontmatter_and_source_line() {
        let meta = meta(
            "https://www.example.com/article?x=1",
            "He said \"hi\" \\ bye",
            "hash",
            1_700_000_000,
        );
        let note = render_note(&meta, "  Body paragraph.\n\nSecond paragraph.  ");
        assert!(
            note.starts_with(
                "---\ntitle: \"He said \\\"hi\\\" \\\\ bye\"\n\
                 source: \"https://www.example.com/article?x=1\"\n\
                 domain: \"example.com\"\n\
                 retrieved: \"2023-11-14\"\n\
                 type: source\n---\n"
            ),
            "{note}"
        );
        assert!(note.contains("# He said \"hi\" \\ bye"));
        assert!(note.contains("Source: [example.com](https://www.example.com/article?x=1)"));
        assert!(note.contains("Body paragraph.\n\nSecond paragraph."));
        assert!(!note.contains("  Body paragraph"));
    }

    #[test]
    fn titles_fall_back_to_domain_url_then_source() {
        assert_eq!(
            source_title(&meta("https://www.example.com/x", "", "h", 0)),
            "example.com"
        );
        assert_eq!(source_title(&meta("", "", "h", 0)), "Source");
        assert_eq!(
            source_title(&meta("https://example.com/x", "  Real   title  ", "h", 0)),
            "Real title"
        );
    }

    #[test]
    fn duplicate_urls_and_hashes_are_dropped_within_a_batch() {
        let sources = vec![
            source("https://example.com/a?utm_source=x", "h1", "one"),
            // Same canonical URL (tracking stripped, host case, slash) -> dropped.
            source("https://EXAMPLE.com/a/", "h2", "two"),
            // Same content hash as the first -> dropped.
            source("https://example.com/b", "h1", "three"),
            source("https://example.com/c", "h3", "four"),
        ];
        let deduped = dedupe_sources(sources);
        assert_eq!(deduped.len(), 2);
        assert_eq!(deduped[0].meta.hash, "h1");
        assert_eq!(deduped[1].meta.hash, "h3");
    }

    #[test]
    fn prepare_notes_writes_under_a_timestamped_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let text = "Extracted body text";
        let meta = meta(
            "https://example.com/article",
            "Example article",
            &dedupe::sha256_hex(text),
            1_700_000_000,
        );
        store::write_cache(root, &meta, text).unwrap();
        let keys = vec![
            store::web_key(&meta.hash),
            store::web_key(&meta.hash), // duplicate key in one batch
        ];
        let prepared = prepare_notes(root, &keys, "2026-10-31 15-42-09").unwrap();
        assert_eq!(prepared.result.folder, "Researched Sources/2026-10-31 15-42-09");
        assert_eq!(prepared.result.paths.len(), 1);
        assert_eq!(
            prepared.result.paths[0],
            "Researched Sources/2026-10-31 15-42-09/Example article.md"
        );
        let written = std::fs::read_to_string(
            root.join("Researched Sources/2026-10-31 15-42-09/Example article.md"),
        )
        .unwrap();
        assert_eq!(written, prepared.writes[0].1);
        assert!(written.contains("retrieved: \"2023-11-14\""));
    }
}

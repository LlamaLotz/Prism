//! Stable note-path identities for SQLite.
//!
//! The knowledge index keys notes by their absolute path. `std::fs::canonicalize`
//! on Windows returns an extended-length path (`\\?\C:\...`) while the vault
//! indexer and the frontend use the normal spelling (`C:\...`). Mixing the two
//! creates multiple `knowledge_notes` rows for one file, which the graph then
//! renders as duplicate notes plus a fake folder chain for every path segment.
//!
//! `path_id` is deliberately lexical: it strips the Windows verbatim prefix and
//! lets `Path::components` emit the platform's native separators, but it does
//! not resolve symlinks. Resolving links here would change a vault opened through
//! a symlink/junction into the real path and reintroduce the same identity split
//! against the path the user selected.

use std::path::{Path, PathBuf};

fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix("//?/UNC/") {
        return PathBuf::from(format!("//{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    if let Some(rest) = text.strip_prefix("//?/") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// Returns the canonical database identity for a filesystem path.
///
/// `components().collect()` collapses repeated separators and rewrites mixed
/// `/` + `\` input to the platform-native form, which is what every caller uses
/// as a `knowledge_notes.path` key.
pub fn path_id(path: &Path) -> String {
    let stripped = strip_verbatim(path);
    stripped
        .components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned()
}

/// Splits a Windows-spelled path (drive letter or UNC) into normalized
/// components, independent of the host platform. Returns `None` for native
/// paths and for traversal attempts, so callers fall back to `Path::components`.
fn windows_parts(path: &Path) -> Option<Vec<String>> {
    let text = strip_verbatim(path).to_string_lossy().into_owned();
    let bytes = text.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let unc = text.starts_with(r"\\") || text.starts_with("//");
    if !drive && !unc {
        return None;
    }
    let parts = text
        .split(['\\', '/'])
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    (!parts.iter().any(|part| part == "..")).then_some(parts)
}

fn same_component(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> bool {
    #[cfg(windows)]
    {
        a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// Returns `path` relative to `root` when it is inside, after stripping
/// Windows verbatim prefixes.
///
/// Raw `Path::starts_with` cannot be used for vault containment on Windows:
/// `knowledge::activate` stores the canonical root (`\\?\C:\Vault`) while
/// indexed notes keep the normal spelling (`C:\Vault\Note.md`). Both name the
/// same directory, but the verbatim prefix makes the raw prefix comparison
/// fail, which rejected every note in the vault (including the post-save read
/// that reports "CONFLICT"). Comparing normalized components also makes the
/// check case-insensitive on Windows, where the filesystem is.
///
/// The comparison is lexical: it does not resolve symlinks. Callers that must
/// reject symlinked components (see `knowledge::operations::validate`) still
/// walk the returned relative path.
pub fn relative_to(root: &Path, path: &Path) -> Option<PathBuf> {
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    if let (Some(root_parts), Some(path_parts)) = (windows_parts(root), windows_parts(path)) {
        if path_parts.len() < root_parts.len()
            || !root_parts
                .iter()
                .zip(&path_parts)
                .all(|(root, path)| root.eq_ignore_ascii_case(path))
        {
            return None;
        }
        return Some(path_parts[root_parts.len()..].iter().collect());
    }
    // Native paths: compare components directly so non-UTF-8 names stay exact.
    let mut root_parts = root.components();
    let mut path_parts = path.components();
    for root_part in root_parts.by_ref() {
        let path_part = path_parts.next()?;
        if !same_component(root_part.as_os_str(), path_part.as_os_str()) {
            return None;
        }
    }
    Some(path_parts.as_path().to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_windows_verbatim_prefix() {
        assert_eq!(
            path_id(Path::new(r"\\?\C:\Vault\a\Note.md")),
            r"C:\Vault\a\Note.md"
        );
        assert_eq!(
            path_id(Path::new("//?/C:/Vault/a/Note.md")),
            path_id(Path::new("C:/Vault/a/Note.md"))
        );
    }

    #[test]
    fn strips_verbatim_unc_prefix() {
        assert_eq!(
            path_id(Path::new(r"\\?\UNC\server\share\a\Note.md")),
            r"\\server\share\a\Note.md"
        );
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_mixed_separators() {
        assert_eq!(
            path_id(Path::new("C:\\Vault/a\\Note.md")),
            r"C:\Vault\a\Note.md"
        );
    }

    #[test]
    fn relative_to_matches_verbatim_and_normal_windows_spellings() {
        // `activate` canonicalizes the root (verbatim on Windows); the indexer
        // and frontend use the normal spelling for every note.
        let root = Path::new(r"\\?\C:\Users\Shiva\Documents\New folder");
        assert_eq!(
            relative_to(
                root,
                Path::new(r"C:\Users\Shiva\Documents\New folder\Untitled Note.md")
            ),
            Some(Path::new("Untitled Note.md").to_path_buf())
        );
        // Windows paths are case-insensitive.
        assert_eq!(
            relative_to(root, Path::new(r"c:\users\shiva\documents\new folder\a.md")),
            Some(Path::new("a.md").to_path_buf())
        );
        // UNC roots are stored verbatim too.
        let unc = Path::new(r"\\?\UNC\server\share\Vault");
        assert_eq!(
            relative_to(unc, Path::new(r"\\server\share\Vault\a.md")),
            Some(Path::new("a.md").to_path_buf())
        );
    }

    #[test]
    fn relative_to_respects_component_boundaries_and_traversal() {
        let root = Path::new(r"\\?\C:\Vault");
        assert!(relative_to(root, Path::new(r"C:\Vault2\a.md")).is_none());
        assert!(relative_to(root, Path::new(r"C:\Other\a.md")).is_none());
        assert!(relative_to(root, Path::new(r"C:\Vault\..\a.md")).is_none());
        assert_eq!(
            relative_to(root, Path::new(r"C:\Vault")),
            Some(PathBuf::new())
        );
        assert_eq!(
            relative_to(Path::new("/vault"), Path::new("/vault/a.md")),
            Some(Path::new("a.md").to_path_buf())
        );
        assert!(relative_to(Path::new("/vault"), Path::new("/vault2/a.md")).is_none());
        assert!(relative_to(Path::new("/vault"), Path::new("/vault/../etc/passwd")).is_none());
    }
}

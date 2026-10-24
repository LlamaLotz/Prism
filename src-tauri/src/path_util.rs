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
}

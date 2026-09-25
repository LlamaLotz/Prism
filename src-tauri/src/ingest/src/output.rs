use crate::{Error, Extraction, Result};
use std::{io::Write, path::Path};
pub fn sanitize(value: &str) -> String {
    let s = regex::Regex::new(r#"[\\/*?:"<>|\x00-\x1f]"#)
        .unwrap()
        .replace_all(value, " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let s = s.trim_end_matches(['.', ' ']);
    if s.is_empty() {
        "Untitled".into()
    } else {
        let mut s = s.to_owned();
        while s.len() > 180 {
            s.pop();
        }
        let reserved = s.split('.').next().unwrap_or("").to_ascii_uppercase();
        if ["CON", "PRN", "AUX", "NUL"].contains(&reserved.as_str())
            || (reserved.len() == 4
                && (reserved.starts_with("COM") || reserved.starts_with("LPT"))
                && reserved.as_bytes()[3].is_ascii_digit())
        {
            format!("_{s}")
        } else {
            s
        }
    }
}
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::new("write", "No output directory"))?;
    std::fs::create_dir_all(parent).map_err(|e| Error::new("write", e))?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| Error::new("write", e))?;
    tmp.write_all(bytes)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|e| Error::new("write", e))?;
    tmp.persist(path).map_err(|e| Error::new("write", e))?;
    Ok(())
}
pub fn note(e: &Extraction) -> String {
    match e.kind.as_str() {
        "audio" => format!(
            "# Transcript: {}\n\n**Source File:** `{}`\n**Engine:** `{}`\n\n---\n\n{}",
            e.title, e.title, e.engine, e.body
        ),
        "document" => format!(
            "# Note: {}\n\n**Source File:** `{}`\n\n{}",
            e.stem, e.title, e.body
        ),
        "youtube" => format!("# {}\n\n{}", e.title, e.body),
        _ => format!(
            "# {}\n\n**Source URL:** {}\n\n{}",
            e.title, e.source, e.body
        ),
    }
}
pub fn stage(e: &Extraction, dir: &Path) -> Result<()> {
    let name = format!("{}.md", sanitize(&e.stem));
    if e.kind == "youtube" {
        atomic(
            &dir.join("note metadata").join(format!("{name}.meta.json")),
            &serde_json::to_vec_pretty(&serde_json::json!({"source":e.source,"engine":e.engine}))
                .unwrap(),
        )?;
    }
    atomic(&dir.join(name), note(e).as_bytes())
}
pub fn publish(stage: &Path, vault: &Path) -> Result<()> {
    std::fs::create_dir_all(vault).map_err(|e| Error::new("write", e))?;
    let notes = std::fs::read_dir(stage)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "md"))
        .collect::<Vec<_>>();
    if notes.is_empty() {
        return Err(Error::new("quality", "No staged notes"));
    }
    for p in notes {
        let name = p.file_name().unwrap();
        let side_name = format!("{}.meta.json", name.to_string_lossy());
        let side = stage.join("note metadata").join(&side_name);
        let dest = vault.join(name);
        let side_dest = vault.join("note metadata").join(side_name);
        // Reject symlink metadata directories instead of escaping the authorized vault.
        if std::fs::symlink_metadata(vault.join("note metadata"))
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err(Error::new("write", "Metadata directory is a symlink"));
        }
        let previous = std::fs::read(&side_dest).ok();
        if side.exists() {
            atomic(&side_dest, &std::fs::read(&side)?)?;
        }
        if let Err(e) = atomic(&dest, &std::fs::read(p)?) {
            if side.exists() {
                if let Some(bytes) = previous {
                    let _ = atomic(&side_dest, &bytes);
                } else {
                    let _ = std::fs::remove_file(side_dest);
                }
            }
            return Err(e);
        }
    }
    Ok(())
}

//! Durable agent mutation journal. Filesystem publication and indexing are separate,
//! recoverable steps; no transaction is claimed across the two stores.
use super::{blocks, Scope};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
static MUTATIONS: Mutex<()> = Mutex::new(());
pub fn lock() -> Result<MutexGuard<'static, ()>, String> {
    MUTATIONS
        .lock()
        .map_err(|_| "RECOVERY_REQUIRED: mutation coordinator unavailable".into())
}
fn persistence(e: impl std::fmt::Display) -> String {
    format!("PERSISTENCE: {e}")
}
fn conflict(message: &str) -> String {
    format!("CONFLICT: {message}. Generate a fresh preview.")
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    pub data: Option<String>,
    pub fingerprint: String,
    pub identity: String,
}
pub type Snapshot = BTreeMap<String, Entry>;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Mutation {
    pub tool: String,
    pub source: String,
    pub destination: Option<String>,
    pub before: Snapshot,
    pub destination_before: Snapshot,
    pub after: Snapshot,
    pub identities: BTreeMap<String, String>,
    pub parents: Vec<String>,
    #[serde(default)]
    pub post_identities: BTreeMap<String, String>,
    #[serde(default)]
    pub staging: Option<String>,
    #[serde(default)]
    pub undo_post: Option<Snapshot>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationView {
    pub id: String,
    pub tool: String,
    pub note_path: String,
    pub state: String,
    pub undo_available: bool,
    pub error: Option<String>,
}

pub fn validate(root: &Path, path: &Path) -> Result<(), String> {
    if !path.starts_with(root)
        || path == root
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(conflict("Path is outside the vault or is its root"));
    }
    let mut current = root.to_path_buf();
    for part in path.strip_prefix(root).map_err(persistence)?.components() {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(conflict("Symlink paths are not supported"))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(persistence(e)),
        }
    }
    Ok(())
}
fn physical_id(meta: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", meta.dev(), meta.ino())
    }
    #[cfg(not(unix))]
    {
        format!("{:?}", meta.created().ok())
    }
}
pub fn snapshot(path: &Path) -> Result<Snapshot, String> {
    let mut out = Snapshot::new();
    let mut bytes = 0u64;
    if !path.try_exists().map_err(persistence)? {
        return Ok(out);
    }
    for entry in walkdir::WalkDir::new(path)
        .follow_links(false)
        .sort_by_file_name()
    {
        let entry = entry.map_err(persistence)?;
        let meta = std::fs::symlink_metadata(entry.path()).map_err(persistence)?;
        if meta.file_type().is_symlink() || (!meta.is_file() && !meta.is_dir()) {
            return Err(conflict("Unsupported filesystem entry"));
        }
        bytes = bytes.saturating_add(if meta.is_file() { meta.len() } else { 0 });
        if bytes > 64 * 1024 * 1024 || out.len() >= 10000 {
            return Err("LIMIT: Agent operation exceeds 64 MiB or 10,000 entries".into());
        }
        let data = if meta.is_file() {
            Some(STANDARD.encode(std::fs::read(entry.path()).map_err(persistence)?))
        } else {
            None
        };
        let fingerprint = data
            .as_ref()
            .map(|s| blocks::hash(s))
            .unwrap_or_else(|| "directory".into());
        out.insert(
            entry
                .path()
                .strip_prefix(path)
                .map_err(persistence)?
                .to_string_lossy()
                .into(),
            Entry {
                data,
                fingerprint,
                identity: physical_id(&meta),
            },
        );
    }
    Ok(out)
}
fn same(a: &Snapshot, b: &Snapshot, identity: bool) -> bool {
    a.len() == b.len()
        && a.iter().all(|(p, e)| {
            b.get(p).is_some_and(|other| {
                e.fingerprint == other.fingerprint
                    && e.data.is_some() == other.data.is_some()
                    && (!identity || e.identity == other.identity)
            })
        })
}
fn file_snapshot(text: &str) -> Snapshot {
    let data = STANDARD.encode(text.as_bytes());
    BTreeMap::from([(
        String::new(),
        Entry {
            fingerprint: blocks::hash(&data),
            data: Some(data),
            identity: String::new(),
        },
    )])
}
pub fn capture(
    c: &Connection,
    scope: &Scope,
    tool: &str,
    source: &str,
    destination: Option<String>,
    old: &str,
    new: &str,
) -> Result<Mutation, String> {
    validate(&scope.root, Path::new(source))?;
    let before = snapshot(Path::new(source))?;
    let creating = matches!(tool, "create_note" | "create_folder");
    if creating && !before.is_empty() {
        return Err(conflict("Destination already exists"));
    }
    if !creating && before.is_empty() {
        return Err(conflict("Source no longer exists"));
    }
    if !creating && tool != "move_folder" && !same(&before, &file_snapshot(old), false) {
        return Err(conflict("Source changed while preparing preview"));
    }
    let mut destination_before = Snapshot::new();
    if let Some(dest) = &destination {
        validate(&scope.root, Path::new(dest))?;
        if Path::new(dest).starts_with(source) || Path::new(source).starts_with(dest) {
            return Err(conflict("Overlapping move paths"));
        }
        destination_before = snapshot(Path::new(dest))?;
        if !destination_before.is_empty() {
            return Err(conflict("Destination already exists"));
        }
    }
    let after = match tool {
        "delete_note" => Snapshot::new(),
        "create_folder" => BTreeMap::from([(
            String::new(),
            Entry {
                data: None,
                fingerprint: "directory".into(),
                identity: String::new(),
            },
        )]),
        "rename_note" | "move_folder" => before.clone(),
        _ => file_snapshot(new),
    };
    let mut identities = BTreeMap::new();
    for rel in before.keys() {
        let path = if rel.is_empty() {
            PathBuf::from(source)
        } else {
            Path::new(source).join(rel)
        };
        let id: Option<String> = c
            .query_row(
                "SELECT id FROM knowledge_notes WHERE vault_id=?1 AND path=?2 AND deleted=0",
                params![scope.vault_id, path.to_string_lossy()],
                |r| r.get(0),
            )
            .optional()
            .map_err(persistence)?;
        if let Some(id) = id {
            identities.insert(path.to_string_lossy().into(), id);
        }
    }
    let mut parents = vec![];
    let mut parent = Path::new(destination.as_deref().unwrap_or(source)).parent();
    while let Some(p) = parent {
        if p.exists() {
            break;
        }
        validate(&scope.root, p)?;
        parents.push(p.to_string_lossy().into());
        parent = p.parent();
    }
    let staging = if destination.is_none() && tool != "create_folder" {
        Some(
            Path::new(source)
                .with_file_name(format!(".prism-recovery-{}", uuid::Uuid::new_v4()))
                .to_string_lossy()
                .into_owned(),
        )
    } else {
        None
    };
    Ok(Mutation {
        tool: tool.into(),
        source: source.into(),
        destination,
        before,
        destination_before,
        after,
        identities,
        parents,
        post_identities: BTreeMap::new(),
        staging,
        undo_post: None,
    })
}

/// Captures a staged editor upload as the same journaled edit operation used by
/// ordinary note changes. Revisions are checked before reading either file;
/// capture/apply then verify source content and filesystem identity again.
pub fn capture_file(
    c: &Connection,
    scope: &Scope,
    tool: &str,
    source: &str,
    destination: Option<String>,
    staged: &Path,
    expected_revision: &str,
) -> Result<Mutation, String> {
    validate(&scope.root, Path::new(source))?;
    validate(&scope.root, staged)?;
    if super::note_io::revision(Path::new(source))? != expected_revision {
        return Err(conflict("Note changed since the save began"));
    }
    let old = std::fs::read_to_string(source).map_err(persistence)?;
    let new = std::fs::read_to_string(staged).map_err(persistence)?;
    if super::note_io::revision(Path::new(source))? != expected_revision {
        return Err(conflict("Note changed while the save was being staged"));
    }
    capture(c, scope, tool, source, destination, &old, &new)
}

pub(crate) fn verify(
    scope: &Scope,
    m: &Mutation,
    undo: bool,
    identities: bool,
) -> Result<(), String> {
    validate(&scope.root, Path::new(&m.source))?;
    if let Some(dest) = &m.destination {
        validate(&scope.root, Path::new(dest))?;
    }
    let expected = if undo {
        if m.destination.is_some() {
            &m.destination_before
        } else {
            &m.after
        }
    } else {
        &m.before
    };
    if !same(&snapshot(Path::new(&m.source))?, expected, identities) {
        return Err(conflict("Source changed since review"));
    }
    if let Some(dest) = &m.destination {
        if !same(
            &snapshot(Path::new(dest))?,
            if undo {
                &m.after
            } else {
                &m.destination_before
            },
            identities,
        ) {
            return Err(conflict("Destination changed since review"));
        }
    }
    Ok(())
}
pub fn atomic_write(path: &Path, bytes: &[u8], create: bool) -> Result<(), String> {
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("PERSISTENCE: missing parent")?)
            .map_err(persistence)?;
    temp.write_all(bytes).map_err(persistence)?;
    temp.as_file().sync_all().map_err(persistence)?;
    if create {
        temp.persist_noclobber(path).map_err(persistence)?;
    } else {
        temp.persist(path).map_err(persistence)?;
    }
    Ok(())
}
fn remove_tree(path: &Path, expected: &Snapshot) -> Result<(), String> {
    // Explicit entries only: never recursively delete an unexpected external file.
    let mut paths: Vec<_> = expected.iter().collect();
    paths.sort_by_key(|(p, _)| std::cmp::Reverse(Path::new(p).components().count()));
    for (rel, e) in paths {
        let p = if rel.is_empty() {
            path.to_path_buf()
        } else {
            path.join(rel)
        };
        if e.data.is_some() {
            std::fs::remove_file(p).map_err(persistence)?;
        } else {
            std::fs::remove_dir(p).map_err(persistence)?;
        }
    }
    Ok(())
}
// Atomic no-replace moves prevent a destination created by an external editor
// between validation and publication from being overwritten.
fn move_exclusive(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::os::unix::ffi::OsStrExt;
        let from = std::ffi::CString::new(from.as_os_str().as_bytes()).map_err(persistence)?;
        let to = std::ffi::CString::new(to.as_os_str().as_bytes()).map_err(persistence)?;
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result != 0 {
            return Err(persistence(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        std::fs::rename(from, to).map_err(persistence)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (from, to);
        Err("PERSISTENCE: exclusive rename unsupported on this platform".into())
    }
}
fn suppress(m: &Mutation) {
    use crate::engine::indexer::{suppress_self_write, SELF_WRITE_MASK_MS};
    for root in std::iter::once(&m.source)
        .chain(m.destination.iter())
        .chain(m.staging.iter())
    {
        suppress_self_write(Path::new(root), SELF_WRITE_MASK_MS);
        for rel in m.before.keys().chain(m.after.keys()) {
            suppress_self_write(&Path::new(root).join(rel), SELF_WRITE_MASK_MS);
        }
    }
}
fn identities(
    c: &Connection,
    scope: &Scope,
    m: &Mutation,
) -> Result<BTreeMap<String, String>, String> {
    let root = m.destination.as_deref().unwrap_or(&m.source);
    let mut stmt=c.prepare("SELECT path,id FROM knowledge_notes WHERE vault_id=?1 AND deleted=0 AND (path=?2 OR instr(path,?2||'/')=1)").map_err(persistence)?;
    let result = stmt
        .query_map(params![scope.vault_id, root], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(persistence)?
        .collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(persistence)?;
    Ok(result)
}
fn publish(scope: &Scope, m: &Mutation, undo: bool) -> Result<(), String> {
    verify(scope, m, undo, true)?;
    suppress(m);
    let source = Path::new(&m.source);
    if !undo {
        for parent in m.parents.iter().rev() {
            std::fs::create_dir(parent).map_err(persistence)?;
        }
    }
    if let Some(dest) = &m.destination {
        let (from, to) = if undo {
            (Path::new(dest), source)
        } else {
            (source, Path::new(dest))
        };
        if to.exists() {
            return Err(conflict("Move destination appeared"));
        }
        move_exclusive(from, to)?;
    } else {
        let (before, after) = if undo {
            (&m.after, &m.before)
        } else {
            (&m.before, &m.after)
        };
        // Keep the actual displaced file until metadata is durable. An external
        // race is detected against this staged version, which remains recoverable.
        let stage = m
            .staging
            .as_ref()
            .map(|p| if undo { format!("{p}-undo") } else { p.clone() });
        if before.get("").is_some_and(|e| e.data.is_some()) {
            let stage = stage
                .as_deref()
                .ok_or("RECOVERY_REQUIRED: missing staging path")?;
            validate(&scope.root, Path::new(stage))?;
            move_exclusive(source, Path::new(stage))?;
            if !same(&snapshot(Path::new(stage))?, before, true) {
                return Err(format!(
                    "RECOVERY_REQUIRED: external race; displaced content retained at {stage}"
                ));
            }
        }
        if after.is_empty() {
            if before.get("").is_some_and(|e| e.data.is_none()) {
                remove_tree(source, before)?;
            }
        } else if let Some(data) = after.get("").and_then(|e| e.data.as_ref()) {
            atomic_write(source, &STANDARD.decode(data).map_err(persistence)?, true)?;
        } else {
            std::fs::create_dir(source).map_err(persistence)?;
        }
    }
    if undo {
        for parent in &m.parents {
            match std::fs::remove_dir(parent) {
                Ok(()) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                    ) => {}
                Err(e) => return Err(persistence(e)),
            }
        }
    }
    Ok(())
}
fn set_state(c: &Connection, id: &str, state: &str, error: Option<&str>) -> Result<(), String> {
    c.execute(
        "UPDATE knowledge_operations SET state=?2,error=?3 WHERE id=?1",
        params![id, state, error],
    )
    .map_err(persistence)?;
    Ok(())
}
fn persist_payload(c: &Connection, id: &str, m: &Mutation) -> Result<(), String> {
    c.execute(
        "UPDATE knowledge_operations SET payload=?2 WHERE id=?1",
        params![id, serde_json::to_string(m).map_err(persistence)?],
    )
    .map_err(persistence)?;
    Ok(())
}

/// Rebuild derived metadata idempotently after publication; keep history and IDs.
fn reconcile(c: &Connection, scope: &Scope, m: &Mutation, undo: bool) -> Result<(), String> {
    if let Some(dest) = &m.destination {
        let (old, new) = if undo {
            (dest.as_str(), m.source.as_str())
        } else {
            (m.source.as_str(), dest.as_str())
        };
        if m.tool == "move_folder" {
            crate::db::rename_folder_paths(c, old, new)?;
        } else {
            // One deferred-FK transaction moves canonical and legacy path keys together.
            let tx = c.unchecked_transaction().map_err(persistence)?;
            tx.execute_batch("PRAGMA defer_foreign_keys=ON")
                .map_err(persistence)?;
            for (table, col) in [
                ("knowledge_notes", "path"),
                ("knowledge_embedding_provenance", "path"),
                ("notes", "id"),
                ("notes", "path"),
                ("aliases", "note_id"),
                ("tags", "note_id"),
                ("embeddings", "note_id"),
                ("block_embeddings", "note_id"),
                ("backlinks", "source_path"),
                ("backlinks", "target_path"),
                ("links", "source"),
                ("links", "target"),
                ("denied_links", "note_path"),
                ("note_history_base", "note_path"),
                ("note_history_deltas", "note_path"),
            ] {
                tx.execute(
                    &format!("UPDATE {table} SET {col}=?2 WHERE {col}=?1"),
                    params![old, new],
                )
                .map_err(persistence)?;
            }
            tx.commit().map_err(persistence)?;
        }
    }
    let target = m.destination.as_deref().unwrap_or(&m.source);
    let roots = if m.destination.is_some() {
        vec![m.source.as_str(), target]
    } else {
        vec![target]
    };
    for root in roots {
        let live = snapshot(Path::new(root))?;
        let mut stmt=c.prepare("SELECT path FROM knowledge_notes WHERE vault_id=?1 AND (path=?2 OR instr(path,?2||'/')=1) AND deleted=0").map_err(persistence)?;
        let indexed = stmt
            .query_map(params![scope.vault_id, root], |r| r.get::<_, String>(0))
            .map_err(persistence)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(persistence)?;
        drop(stmt);
        for path in indexed {
            if !Path::new(&path).exists() {
                super::remove(c, &path)?;
                c.execute("DELETE FROM notes WHERE id=?1", [&path])
                    .map_err(persistence)?;
                c.execute(
                    "DELETE FROM backlinks WHERE source_path=?1 OR target_path=?1",
                    [&path],
                )
                .map_err(persistence)?;
                c.execute("DELETE FROM links WHERE source=?1 OR target=?1", [&path])
                    .map_err(persistence)?;
            }
        }
        for (rel, e) in live {
            let path = if rel.is_empty() {
                PathBuf::from(root)
            } else {
                Path::new(root).join(rel)
            };
            if e.data.is_none()
                || !path
                    .extension()
                    .is_some_and(|s| s.eq_ignore_ascii_case("md"))
            {
                continue;
            }
            let data = STANDARD.decode(e.data.unwrap()).map_err(persistence)?;
            let text = String::from_utf8(data).map_err(persistence)?;
            let path = path.to_string_lossy();
            super::sync(c, &scope.vault_id, &path, &text)?;
            let title = Path::new(path.as_ref())
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy();
            crate::db::upsert_note(
                c,
                &path,
                &title,
                &path,
                &crate::watcher::extract_aliases(&text),
            )?;
            crate::db::sync_note_tags(c, &path, &text)?;
            crate::db::update_links_flat(c, &path, &crate::db::extract_applied_links(&text))?;
            crate::db::history::record_note_version(c, &path, &text)?;
        }
    }
    Ok(())
}
pub fn apply(c: &Connection, scope: &Scope, m: &Mutation) -> Result<String, String> {
    apply_named(c, scope, m, &uuid::Uuid::new_v4().to_string())
}
pub(crate) fn verify_approval(c: &Connection, scope: &Scope, m: &Mutation) -> Result<(), String> {
    verify(scope, m, false, true)?;
    for (path, id) in &m.identities {
        let actual: Option<String> = c
            .query_row(
                "SELECT id FROM knowledge_notes WHERE vault_id=?1 AND path=?2 AND deleted=0",
                params![scope.vault_id, path],
                |r| r.get(0),
            )
            .optional()
            .map_err(persistence)?;
        if actual.as_ref() != Some(id) {
            return Err(conflict("Note identity changed"));
        }
    }
    if m.tool == "create_note"
        && c.query_row(
            "SELECT EXISTS(SELECT 1 FROM knowledge_notes WHERE vault_id=?1 AND path=?2)",
            params![scope.vault_id, m.source],
            |r| r.get::<_, bool>(0),
        )
        .map_err(persistence)?
    {
        return Err(conflict("Destination note identity appeared"));
    }
    Ok(())
}
pub(crate) fn apply_named(
    c: &Connection,
    scope: &Scope,
    m: &Mutation,
    id: &str,
) -> Result<String, String> {
    verify_approval(c, scope, m)?;
    let tx = c.unchecked_transaction().map_err(persistence)?;
    tx.execute("INSERT INTO knowledge_operations(id,vault_id,tool,state,payload) VALUES (?1,?2,?3,'prepared',?4)",params![id,scope.vault_id,m.tool,serde_json::to_string(m).map_err(persistence)?]).map_err(persistence)?;
    // Save history preimages exactly once, in the journal's transaction, before
    // filesystem publication. Recovery only appends the observed final version.
    for (relative, entry) in &m.before {
        let path = if relative.is_empty() {
            PathBuf::from(&m.source)
        } else {
            Path::new(&m.source).join(relative)
        };
        if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            if let Some(data) = &entry.data {
                let bytes = STANDARD.decode(data).map_err(persistence)?;
                let text = std::str::from_utf8(&bytes).map_err(persistence)?;
                crate::db::history::record_note_version(&tx, &path.to_string_lossy(), text)
                    .map_err(persistence)?;
            }
        }
    }
    tx.commit().map_err(persistence)?;
    complete(c, scope, &id, m.clone(), false)?;
    Ok(id.to_string())
}
fn verify_staging(m: &Mutation, undo: bool) -> Result<(), String> {
    if let Some(stage) = &m.staging {
        let stage = if undo {
            format!("{stage}-undo")
        } else {
            stage.clone()
        };
        let expected = if undo { &m.after } else { &m.before };
        if Path::new(&stage).exists() && !same(&snapshot(Path::new(&stage))?, expected, true) {
            return Err(format!(
                "RECOVERY_REQUIRED: displaced file changed; preserved at {stage}"
            ));
        }
    }
    Ok(())
}
type PublishedState = (Snapshot, Snapshot);
fn observe(m: &Mutation) -> Result<PublishedState, String> {
    Ok((
        snapshot(Path::new(&m.source))?,
        match &m.destination {
            Some(path) => snapshot(Path::new(path))?,
            None => Snapshot::new(),
        },
    ))
}
fn verify_observed(m: &Mutation, observed: &PublishedState) -> Result<(), String> {
    let current = observe(m)?;
    if !same(&current.0, &observed.0, true) || !same(&current.1, &observed.1, true) {
        return Err("RECOVERY_REQUIRED: Files changed during metadata reconciliation; recorded versions retained".into());
    }
    Ok(())
}
fn complete(
    c: &Connection,
    scope: &Scope,
    id: &str,
    mut m: Mutation,
    undo: bool,
) -> Result<(), String> {
    let result = (|| {
        publish(scope, &m, undo)?;
        // Freeze the published filesystem state before indexing. Never absorb
        // a concurrent external edit into the operation's recorded postimage.
        let observed = observe(&m)?;
        verify(scope, &m, !undo, false)?;
        verify_observed(&m, &observed)?;
        if !undo {
            m.after = if m.destination.is_some() {
                observed.1.clone()
            } else {
                observed.0.clone()
            };
            persist_payload(c, id, &m)?;
        }
        set_state(
            c,
            id,
            if undo { "undo_published" } else { "published" },
            None,
        )?;
        reconcile(c, scope, &m, undo)?;
        verify_staging(&m, undo)?;
        verify_observed(&m, &observed)?;
        if !undo {
            m.post_identities = identities(c, scope, &m)?;
            persist_payload(c, id, &m)?;
        }
        if undo {
            m.undo_post = Some(observed.0.clone());
            persist_payload(c, id, &m)?;
        }
        set_state(c, id, if undo { "undone" } else { "applied" }, None)
    })();
    if let Err(error) = result {
        set_state(
            c,
            id,
            if undo {
                "undo_recovery_required"
            } else {
                "recovery_required"
            },
            Some(&error),
        )?;
        return Err(format!("RECOVERY_REQUIRED: Operation {id}: {error}"));
    }
    Ok(())
}
pub(crate) fn check_undo(c: &Connection, scope: &Scope, id: &str) -> Result<Mutation, String> {
    let (state, json): (String, String) = c
        .query_row(
            "SELECT state,payload FROM knowledge_operations WHERE id=?1 AND vault_id=?2",
            params![id, scope.vault_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(persistence)?;
    if state != "applied" {
        return Err(conflict("Operation is not available for undo"));
    }
    let m: Mutation = serde_json::from_str(&json).map_err(persistence)?;
    verify(scope, &m, true, true)?;
    if m.tool == "delete_note" {
        for (path, id) in &m.identities {
            let current: Option<String> = c
                .query_row(
                    "SELECT id FROM knowledge_notes WHERE vault_id=?1 AND path=?2",
                    params![scope.vault_id, path],
                    |r| r.get(0),
                )
                .optional()
                .map_err(persistence)?;
            if current.as_ref() != Some(id) {
                return Err(conflict("Deleted note identity changed"));
            }
        }
    }
    if identities(c, scope, &m)? != m.post_identities {
        return Err(conflict("Post-operation note identity changed"));
    }
    Ok(m)
}
pub fn undo(c: &Connection, scope: &Scope, id: &str) -> Result<Mutation, String> {
    let m = check_undo(c, scope, id)?;
    set_state(c, id, "undo_prepared", None)?;
    complete(c, scope, id, m.clone(), true)?;
    Ok(m)
}
/// Restart recovery only reconciles known published outcomes; it never repeats a write.
pub fn recover(c: &Connection, scope: &Scope) -> Result<(), String> {
    let mut stmt=c.prepare("SELECT id,state,payload FROM knowledge_operations WHERE vault_id=?1 AND state NOT IN ('applied','undone','aborted','recovery_required','undo_recovery_required')").map_err(persistence)?;
    let rows = stmt
        .query_map([&scope.vault_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(persistence)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(persistence)?;
    drop(stmt);
    for (id, state, json) in rows {
        let mut m: Mutation = serde_json::from_str(&json).map_err(persistence)?;
        let undo = state.starts_with("undo");
        if let Err(error) = verify_staging(&m, undo) {
            set_state(
                c,
                &id,
                if undo {
                    "undo_recovery_required"
                } else {
                    "recovery_required"
                },
                Some(&error),
            )?;
            continue;
        }
        let recorded_identity = !undo && m.after.values().all(|entry| !entry.identity.is_empty());
        if verify(scope, &m, !undo, recorded_identity).is_ok() {
            let observed = observe(&m)?;
            let reconciled = (|| {
                verify(scope, &m, !undo, recorded_identity)?;
                reconcile(c, scope, &m, undo)?;
                verify_observed(&m, &observed)?;
                verify_staging(&m, undo)
            })();
            match reconciled {
                Ok(()) => {
                    if !undo {
                        m.post_identities = identities(c, scope, &m)?;
                        m.after = if m.destination.is_some() {
                            observed.1.clone()
                        } else {
                            observed.0.clone()
                        };
                        persist_payload(c, &id, &m)?;
                    }
                    if undo {
                        m.undo_post = Some(observed.0.clone());
                        persist_payload(c, &id, &m)?;
                    }
                    set_state(c, &id, if undo { "undone" } else { "applied" }, None)?;
                }
                Err(e) => set_state(
                    c,
                    &id,
                    if undo {
                        "undo_recovery_required"
                    } else {
                        "recovery_required"
                    },
                    Some(&e),
                )?,
            }
        } else if verify(scope, &m, undo, true).is_ok() {
            set_state(c, &id, if undo { "applied" } else { "aborted" }, None)?;
        } else {
            set_state(
                c,
                &id,
                if undo {
                    "undo_recovery_required"
                } else {
                    "recovery_required"
                },
                Some("Filesystem differs from both recorded states; recovery data retained"),
            )?;
        }
    }
    Ok(())
}
pub fn recheck(c: &Connection, scope: &Scope, id: &str) -> Result<(), String> {
    let state: String = c
        .query_row(
            "SELECT state FROM knowledge_operations WHERE id=?1 AND vault_id=?2",
            params![id, scope.vault_id],
            |r| r.get(0),
        )
        .map_err(persistence)?;
    if !matches!(
        state.as_str(),
        "recovery_required" | "undo_recovery_required"
    ) {
        return Err(conflict("Operation does not require recovery"));
    }
    set_state(
        c,
        id,
        if state.starts_with("undo") {
            "undo_published"
        } else {
            "published"
        },
        None,
    )?;
    recover(c, scope)
}
pub fn newest_for_path(c: &Connection, scope: &Scope, path: &str) -> Result<String, String> {
    c.query_row("SELECT id FROM knowledge_operations WHERE vault_id=?1 AND state='applied' AND COALESCE(json_extract(payload,'$.destination'),json_extract(payload,'$.source'))=?2 ORDER BY rowid DESC LIMIT 1",params![scope.vault_id,path],|r|r.get(0)).optional().map_err(persistence)?.ok_or_else(||conflict("No journaled operation is available; legacy history cannot be safely undone"))
}
pub fn list(c: &Connection, scope: &Scope) -> Result<Vec<OperationView>, String> {
    recover(c, scope)?;
    let mut stmt=c.prepare("SELECT id,tool,state,payload,error FROM knowledge_operations WHERE vault_id=?1 ORDER BY rowid DESC LIMIT 100").map_err(persistence)?;
    let rows = stmt
        .query_map([&scope.vault_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(persistence)?;
    rows.map(|row| {
        let (id, tool, state, json, error) = row.map_err(persistence)?;
        let m: Mutation = serde_json::from_str(&json).map_err(persistence)?;
        Ok(OperationView {
            id,
            tool,
            note_path: m.destination.unwrap_or(m.source),
            undo_available: state == "applied",
            state,
            error,
        })
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, crate::db::Database, Scope) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let db = crate::db::Database::open(":memory:").unwrap();
        let vault_id = super::super::vault(&db.conn, &root).unwrap();
        (
            dir,
            db,
            Scope {
                vault_id,
                root,
                generation: "test".into(),
            },
        )
    }
    fn note(c: &Connection, s: &Scope, name: &str, text: &str) -> String {
        let p = s.root.join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, text).unwrap();
        super::super::sync(c, &s.vault_id, &p.to_string_lossy(), text).unwrap();
        p.to_string_lossy().into()
    }
    #[test]
    fn streamed_save_capture_is_journaled_and_undoable_across_thresholds() {
        for size in [128 * 1024, 2 * 1024 * 1024] {
            let (_dir, db, s) = fixture();
            let path = note(&db.conn, &s, "a.md", "before");
            let staged = s.root.join(".prism/recovery/uploads/staged");
            std::fs::create_dir_all(staged.parent().unwrap()).unwrap();
            let text = "x".repeat(size);
            std::fs::write(&staged, &text).unwrap();
            let revision = super::super::note_io::revision(Path::new(&path)).unwrap();
            let mutation = capture_file(
                &db.conn,
                &s,
                "edit_note",
                &path,
                None,
                &staged,
                &revision,
            )
            .unwrap();
            let id = apply(&db.conn, &s, &mutation).unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
            undo(&db.conn, &s, &id).unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "before");
        }
    }
    #[test]
    fn recovery_does_not_bless_a_replaced_postimage() {
        let (_dir, db, s) = fixture();
        let p = note(&db.conn, &s, "a.md", "before");
        let m = capture(&db.conn, &s, "edit_note", &p, None, "before", "after").unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_sync BEFORE UPDATE ON knowledge_notes BEGIN SELECT RAISE(FAIL,'injected'); END").unwrap();
        assert!(apply(&db.conn, &s, &m).is_err());
        let id: String = db
            .conn
            .query_row("SELECT id FROM knowledge_operations", [], |r| r.get(0))
            .unwrap();
        atomic_write(Path::new(&p), b"after", false).unwrap();
        db.conn.execute_batch("DROP TRIGGER fail_sync").unwrap();
        recheck(&db.conn, &s, &id).unwrap();
        assert_eq!(list(&db.conn, &s).unwrap()[0].state, "recovery_required");
    }
    #[test]
    fn reconciliation_cannot_adopt_external_content_as_the_agent_postimage() {
        let (_dir, db, s) = fixture();
        let p = note(&db.conn, &s, "a.md", "before");
        let m = capture(&db.conn, &s, "edit_note", &p, None, "before", "after").unwrap();
        publish(&s, &m, false).unwrap();
        let observed = observe(&m).unwrap();
        std::fs::write(&p, "external while indexing").unwrap();
        assert!(verify_observed(&m, &observed)
            .unwrap_err()
            .starts_with("RECOVERY_REQUIRED:"));
        assert_eq!(
            observed.0.get("").unwrap().data.as_deref(),
            Some(STANDARD.encode("after").as_str())
        );
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            "external while indexing"
        );
    }
    #[test]
    fn compatibility_lookup_is_not_limited_to_the_display_page() {
        let (_dir, db, s) = fixture();
        let p = note(&db.conn, &s, "a.md", "before");
        let m = capture(&db.conn, &s, "edit_note", &p, None, "before", "after").unwrap();
        let id = apply(&db.conn, &s, &m).unwrap();
        for i in 0..101 {
            db.conn.execute("INSERT INTO knowledge_operations(id,vault_id,tool,state,payload) VALUES(?1,?2,'edit_note','aborted',?3)",params![format!("other-{i}"),s.vault_id,serde_json::to_string(&m).unwrap()]).unwrap();
        }
        assert!(!list(&db.conn, &s).unwrap().iter().any(|o| o.id == id));
        assert_eq!(newest_for_path(&db.conn, &s, &p).unwrap(), id);
    }
    #[test]
    fn interrupted_undo_reconciles_and_missing_sources_conflict() {
        let (_dir, db, s) = fixture();
        let p = note(&db.conn, &s, "a.md", "before");
        let m = capture(&db.conn, &s, "edit_note", &p, None, "before", "after").unwrap();
        let moved = s.root.join("moved.md");
        std::fs::rename(&p, &moved).unwrap();
        assert!(apply(&db.conn, &s, &m).is_err());
        std::fs::rename(moved, &p).unwrap();
        let id = apply(&db.conn, &s, &m).unwrap();
        let json: String = db
            .conn
            .query_row(
                "SELECT payload FROM knowledge_operations WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        let m: Mutation = serde_json::from_str(&json).unwrap();
        set_state(&db.conn, &id, "undo_prepared", None).unwrap();
        publish(&s, &m, true).unwrap();
        recover(&db.conn, &s).unwrap();
        assert_eq!(list(&db.conn, &s).unwrap()[0].state, "undone");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "before");
        assert!(undo(&db.conn, &s, &id).is_err());
    }
    #[test]
    fn stale_approvals_and_competing_writes_are_rejected() {
        let (_dir, db, s) = fixture();
        let p = note(&db.conn, &s, "a.md", "before");
        let m = capture(&db.conn, &s, "edit_note", &p, None, "before", "after").unwrap();
        std::fs::write(&p, "external edit").unwrap();
        assert!(apply(&db.conn, &s, &m)
            .unwrap_err()
            .starts_with("CONFLICT:"));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "external edit");
        let m = capture(
            &db.conn,
            &s,
            "edit_note",
            &p,
            None,
            "external edit",
            "after",
        )
        .unwrap();
        apply(&db.conn, &s, &m).unwrap();
        assert!(apply(&db.conn, &s, &m).is_err());
    }
    #[test]
    fn content_operations_restore_exact_preimages_and_ids() {
        for tool in [
            "edit_note",
            "add_tag",
            "remove_tag",
            "add_wikilink",
            "format_note",
            "delete_note",
        ] {
            let (_dir, db, s) = fixture();
            let p = note(&db.conn, &s, "a.md", "before 🦀");
            let original: String = db
                .conn
                .query_row("SELECT id FROM knowledge_notes WHERE path=?1", [&p], |r| {
                    r.get(0)
                })
                .unwrap();
            let m = capture(&db.conn, &s, tool, &p, None, "before 🦀", "after").unwrap();
            let id = apply(&db.conn, &s, &m).unwrap();
            recover(&db.conn, &s).unwrap();
            undo(&db.conn, &s, &id).unwrap();
            assert_eq!(std::fs::read_to_string(&p).unwrap(), "before 🦀");
            assert_eq!(
                db.conn
                    .query_row(
                        "SELECT id FROM knowledge_notes WHERE path=?1 AND deleted=0",
                        [&p],
                        |r| r.get::<_, String>(0)
                    )
                    .unwrap(),
                original
            );
            assert!(undo(&db.conn, &s, &id).is_err());
        }
    }
    #[test]
    fn create_and_folder_inverses_refuse_changed_contents() {
        for tool in ["create_note", "create_folder"] {
            let (_dir, db, s) = fixture();
            let p = s
                .root
                .join(if tool == "create_note" {
                    "new.md"
                } else {
                    "folder"
                })
                .to_string_lossy()
                .into_owned();
            let m = capture(&db.conn, &s, tool, &p, None, "", "new").unwrap();
            let id = apply(&db.conn, &s, &m).unwrap();
            if tool == "create_folder" {
                std::fs::write(Path::new(&p).join("user.md"), "user").unwrap();
            } else {
                std::fs::write(&p, "user edit").unwrap();
            }
            assert!(undo(&db.conn, &s, &id)
                .unwrap_err()
                .starts_with("CONFLICT:"));
        }
    }
    #[test]
    fn move_roundtrips_retain_note_identity_and_protect_destinations() {
        for folder in [false, true] {
            let (_dir, db, s) = fixture();
            let p = note(
                &db.conn,
                &s,
                if folder { "from/a.md" } else { "from.md" },
                "original",
            );
            let note_id: String = db
                .conn
                .query_row("SELECT id FROM knowledge_notes WHERE path=?1", [&p], |r| {
                    r.get(0)
                })
                .unwrap();
            let src = if folder {
                s.root.join("from").to_string_lossy().into_owned()
            } else {
                p.clone()
            };
            let dst = s
                .root
                .join(if folder { "to" } else { "to.md" })
                .to_string_lossy()
                .into_owned();
            let m = capture(
                &db.conn,
                &s,
                if folder { "move_folder" } else { "rename_note" },
                &src,
                Some(dst.clone()),
                if folder { "" } else { "original" },
                "",
            )
            .unwrap();
            let id = apply(&db.conn, &s, &m).unwrap();
            undo(&db.conn, &s, &id).unwrap();
            assert_eq!(std::fs::read_to_string(&p).unwrap(), "original");
            assert_eq!(
                db.conn
                    .query_row("SELECT id FROM knowledge_notes WHERE path=?1", [p], |r| {
                        r.get::<_, String>(0)
                    })
                    .unwrap(),
                note_id
            );
        }
    }
    #[test]
    fn interrupted_publication_reconciles_without_repeating_side_effects() {
        let (_dir, db, s) = fixture();
        let p = note(&db.conn, &s, "a.md", "before");
        let m = capture(&db.conn, &s, "edit_note", &p, None, "before", "after").unwrap();
        for (id, publish_first) in [("pre", false), ("post", true)] {
            db.conn.execute("INSERT INTO knowledge_operations(id,vault_id,tool,state,payload) VALUES (?1,?2,'edit_note','prepared',?3)",params![id,s.vault_id,serde_json::to_string(&m).unwrap()]).unwrap();
            if publish_first {
                publish(&s, &m, false).unwrap();
            }
            recover(&db.conn, &s).unwrap();
            let state: String = db
                .conn
                .query_row(
                    "SELECT state FROM knowledge_operations WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(state, if publish_first { "applied" } else { "aborted" });
        }
        undo(&db.conn, &s, "post").unwrap();
        assert_eq!(std::fs::read_to_string(p).unwrap(), "before");
    }
    #[test]
    fn indexing_failure_retains_durable_recovery_data() {
        let (_dir, db, s) = fixture();
        let p = note(&db.conn, &s, "a.md", "before");
        let m = capture(&db.conn, &s, "edit_note", &p, None, "before", "after").unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_sync BEFORE UPDATE ON knowledge_notes BEGIN SELECT RAISE(FAIL,'injected'); END;").unwrap();
        assert!(apply(&db.conn, &s, &m)
            .unwrap_err()
            .starts_with("RECOVERY_REQUIRED:"));
        let payload: String = db
            .conn
            .query_row("SELECT payload FROM knowledge_operations", [], |r| r.get(0))
            .unwrap();
        assert!(payload.contains(&STANDARD.encode("before")));
        assert_eq!(std::fs::read_to_string(p).unwrap(), "after");
    }
    #[test]
    fn completed_operations_survive_database_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let path = root.join("index.db");
        let (scope, id, p) = {
            let db = crate::db::Database::open(path.to_str().unwrap()).unwrap();
            let scope = Scope {
                vault_id: super::super::vault(&db.conn, &root).unwrap(),
                root: root.clone(),
                generation: "old".into(),
            };
            let p = note(&db.conn, &scope, "a.md", "original");
            let m = capture(
                &db.conn,
                &scope,
                "edit_note",
                &p,
                None,
                "original",
                "edited",
            )
            .unwrap();
            let id = apply(&db.conn, &scope, &m).unwrap();
            (scope, id, p)
        };
        let db = crate::db::Database::open(path.to_str().unwrap()).unwrap();
        assert!(list(&db.conn, &scope)
            .unwrap()
            .iter()
            .any(|o| o.id == id && o.undo_available));
        undo(&db.conn, &scope, &id).unwrap();
        assert_eq!(std::fs::read_to_string(p).unwrap(), "original");
    }
    #[test]
    fn creations_can_be_undone_and_folder_changes_block_the_entire_inverse() {
        for tool in ["create_note", "create_folder"] {
            let (_dir, db, s) = fixture();
            let p = s
                .root
                .join(if tool == "create_note" {
                    "new.md"
                } else {
                    "folder"
                })
                .to_string_lossy()
                .into_owned();
            let m = capture(&db.conn, &s, tool, &p, None, "", "new").unwrap();
            let id = apply(&db.conn, &s, &m).unwrap();
            undo(&db.conn, &s, &id).unwrap();
            assert!(!Path::new(&p).exists());
        }
        let (_dir, db, s) = fixture();
        note(&db.conn, &s, "from/a.md", "original");
        let from = s.root.join("from").to_string_lossy().into_owned();
        let to = s.root.join("to").to_string_lossy().into_owned();
        let m = capture(&db.conn, &s, "move_folder", &from, Some(to.clone()), "", "").unwrap();
        let id = apply(&db.conn, &s, &m).unwrap();
        std::fs::write(Path::new(&to).join("unexpected.md"), "user").unwrap();
        assert!(undo(&db.conn, &s, &id).is_err());
        assert!(!Path::new(&from).exists());
        assert!(Path::new(&to).join("a.md").exists());
    }
    #[test]
    fn journal_failure_prevents_filesystem_publication_and_recovery_is_explicit() {
        let (_dir, db, s) = fixture();
        let p = note(&db.conn, &s, "a.md", "before");
        let m = capture(&db.conn, &s, "edit_note", &p, None, "before", "after").unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_journal BEFORE INSERT ON knowledge_operations BEGIN SELECT RAISE(FAIL,'injected'); END").unwrap();
        assert!(apply(&db.conn, &s, &m)
            .unwrap_err()
            .starts_with("PERSISTENCE:"));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "before");
        db.conn.execute_batch("DROP TRIGGER fail_journal; CREATE TRIGGER fail_sync BEFORE UPDATE ON knowledge_notes BEGIN SELECT RAISE(FAIL,'injected'); END").unwrap();
        assert!(apply(&db.conn, &s, &m).is_err());
        let id: String = db
            .conn
            .query_row("SELECT id FROM knowledge_operations", [], |r| r.get(0))
            .unwrap();
        db.conn.execute_batch("DROP TRIGGER fail_sync").unwrap();
        recover(&db.conn, &s).unwrap();
        assert!(!list(&db.conn, &s).unwrap()[0].undo_available);
        recheck(&db.conn, &s, &id).unwrap();
        assert!(list(&db.conn, &s).unwrap()[0].undo_available);
        undo(&db.conn, &s, &id).unwrap();
        assert_eq!(std::fs::read_to_string(p).unwrap(), "before");
    }
    #[test]
    fn occupied_destinations_and_changed_stable_identities_conflict() {
        let (_dir, db, s) = fixture();
        let p = note(&db.conn, &s, "a.md", "before");
        let dest = s.root.join("b.md").to_string_lossy().into_owned();
        let m = capture(
            &db.conn,
            &s,
            "rename_note",
            &p,
            Some(dest.clone()),
            "before",
            "",
        )
        .unwrap();
        std::fs::write(&dest, "user").unwrap();
        assert!(apply(&db.conn, &s, &m).is_err());
        let m = capture(&db.conn, &s, "edit_note", &p, None, "before", "after").unwrap();
        let id = apply(&db.conn, &s, &m).unwrap();
        db.conn
            .execute("UPDATE knowledge_notes SET deleted=1 WHERE path=?1", [&p])
            .unwrap();
        assert!(undo(&db.conn, &s, &id).is_err());
        assert_eq!(std::fs::read_to_string(p).unwrap(), "after");
    }
    #[test]
    fn external_race_versions_are_retained_and_cannot_be_silently_reconciled() {
        let (_dir, db, s) = fixture();
        let p = note(&db.conn, &s, "a.md", "before");
        let m = capture(&db.conn, &s, "edit_note", &p, None, "before", "after").unwrap();
        db.conn.execute("INSERT INTO knowledge_operations(id,vault_id,tool,state,payload) VALUES('race',?1,'edit_note','prepared',?2)",params![s.vault_id,serde_json::to_string(&m).unwrap()]).unwrap();
        publish(&s, &m, false).unwrap();
        let staged = m.staging.as_ref().unwrap();
        std::fs::write(staged, "late external edit").unwrap();
        recover(&db.conn, &s).unwrap();
        assert_eq!(list(&db.conn, &s).unwrap()[0].state, "recovery_required");
        assert_eq!(
            std::fs::read_to_string(staged).unwrap(),
            "late external edit"
        );
        assert!(undo(&db.conn, &s, "race").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_and_replaced_files_are_rejected() {
        let (_dir, db, s) = fixture();
        let p = note(&db.conn, &s, "a.md", "before");
        let m = capture(&db.conn, &s, "edit_note", &p, None, "before", "after").unwrap();
        atomic_write(Path::new(&p), b"before", false).unwrap();
        assert!(apply(&db.conn, &s, &m).is_err());
        let link = s.root.join("link.md");
        std::os::unix::fs::symlink(&p, &link).unwrap();
        assert!(validate(&s.root, &link).is_err());
    }
}

pub(crate) fn check_restored(c: &Connection, scope: &Scope, id: &str) -> Result<(), String> {
    let json:String=c.query_row("SELECT payload FROM knowledge_operations WHERE id=?1 AND vault_id=?2 AND state='undone'",params![id,scope.vault_id],|r|r.get(0)).map_err(persistence)?;
    let m: Mutation = serde_json::from_str(&json).map_err(persistence)?;
    let expected = m
        .undo_post
        .as_ref()
        .ok_or("RECOVERY_REQUIRED: Restored filesystem identity is unavailable")?;
    validate(&scope.root, Path::new(&m.source))?;
    if !same(&snapshot(Path::new(&m.source))?, expected, true) {
        return Err(conflict(
            "Restored note changed before batch reconciliation",
        ));
    }
    Ok(())
}

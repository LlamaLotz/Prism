//! Vault-scoped service boundary. Path-based IPC remains a compatibility layer.
pub mod blocks;
pub mod gateway;
pub mod jobs;
pub mod models;
pub mod schema;
pub mod search;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct KnowledgeRuntime {
    pub active: Mutex<Option<Scope>>,
    pub embeddings: std::sync::Arc<
        Mutex<Option<Result<std::sync::Arc<crate::engine::embeddings::EmbeddingEngine>, String>>>,
    >,
    pub embed_lock: std::sync::Arc<Mutex<()>>,
    pub http: std::sync::OnceLock<reqwest::Client>,
    pub approvals: Mutex<HashMap<String, models::Approval>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub vault_id: String,
    pub root: PathBuf,
    pub generation: String,
}

pub fn activate(app: &tauri::AppHandle, root: &Path) -> Result<Scope, String> {
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let state = app.state::<KnowledgeRuntime>();
    let mut active = state.active.lock().map_err(|_| "Runtime unavailable")?;
    if let Some(s) = active.as_ref().filter(|s| s.root == root) {
        return Ok(s.clone());
    }
    let conn = crate::db::init_db(app)?;
    let id = vault(&conn, &root)?;
    let scope = Scope {
        vault_id: id,
        root,
        generation: uuid::Uuid::new_v4().to_string(),
    };
    *active = Some(scope.clone());
    drop(active);
    *state.embeddings.lock().unwrap() = None;
    state.approvals.lock().unwrap().clear();
    Ok(scope)
}
pub fn current(app: &tauri::AppHandle) -> Result<Scope, String> {
    app.state::<KnowledgeRuntime>()
        .active
        .lock()
        .map_err(|_| "Runtime unavailable")?
        .clone()
        .ok_or("Open a vault first".into())
}
pub fn vault(conn: &Connection, root: &Path) -> Result<String, String> {
    let root = root.to_string_lossy();
    conn.execute(
        "INSERT OR IGNORE INTO knowledge_vaults(id,root) VALUES (?1,?2)",
        params![uuid::Uuid::new_v4().to_string(), root],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id FROM knowledge_vaults WHERE root=?1",
        [root.as_ref()],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
pub fn sync_file(app: &tauri::AppHandle, path: &Path, content: &str) -> Result<(), String> {
    let scope = current(app)?;
    let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !canonical.starts_with(&scope.root) {
        return Err("Note is outside the active vault".into());
    }
    let conn = crate::db::init_db(app)?;
    let (id, changed) = sync(
        &conn,
        &scope.vault_id,
        &canonical.to_string_lossy(),
        content,
    )?;
    if changed {
        emit(app, &conn, &scope.vault_id, "note_changed", &id)?;
    }
    Ok(())
}

pub fn sync(
    conn: &Connection,
    vault_id: &str,
    path: &str,
    content: &str,
) -> Result<(String, bool), String> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let digest = blocks::hash(content);
    let title = Path::new(path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let existing: Option<(String, String, i64, String)> = tx
        .query_row(
            "SELECT id,hash,deleted,title FROM knowledge_notes WHERE path=?1 AND vault_id=?2",
            params![path, vault_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((id, old, deleted, old_title)) = &existing {
        if old == &digest && *deleted == 0 && old_title == title.as_ref() {
            return Ok((id.clone(), false));
        }
    }
    let title_changed = existing
        .as_ref()
        .map_or(true, |e| e.3 != title.as_ref() || e.2 != 0);
    let id = match existing {
        Some((id, _, _, _)) => id,
        None => {
            // Only infer a move when exactly one absent file has this exact content.
            let mut stmt = tx
                .prepare("SELECT id,path FROM knowledge_notes WHERE vault_id=?1 AND hash=?2")
                .map_err(|e| e.to_string())?;
            let candidates = stmt
                .query_map(params![vault_id, digest], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            if candidates.len() == 1 && !Path::new(&candidates[0].1).exists() {
                candidates[0].0.clone()
            } else {
                uuid::Uuid::new_v4().to_string()
            }
        }
    };
    tx.execute("INSERT INTO knowledge_notes(id,vault_id,path,title,hash) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET path=excluded.path,title=excluded.title,hash=excluded.hash,deleted=0,revision=revision+1,updated_at=unixepoch()",params![id,vault_id,path,title,digest]).map_err(|e|e.to_string())?;
    let mut stmt=tx.prepare("SELECT id,anchor,text,kind,heading_path FROM knowledge_blocks WHERE note_id=?1 AND deleted=0 ORDER BY ordinal").map_err(|e|e.to_string())?;
    let old = stmt
        .query_map([&id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    let parsed = blocks::parse(content);
    let mut matched: Vec<Option<usize>> = vec![None; parsed.len()];
    let mut used = HashSet::new();
    let key = |anchor: &Option<String>, text: &str| match anchor {
        Some(a) => format!("anchor:{a}"),
        None => format!("text:{text}"),
    };
    let mut old_keys: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, b) in old.iter().enumerate() {
        old_keys.entry(key(&b.1, &b.2)).or_default().push(i);
    }
    let mut counts: HashMap<String, usize> = HashMap::new();
    for b in &parsed {
        *counts.entry(key(&b.anchor, &b.text)).or_default() += 1;
    }
    for (i, b) in parsed.iter().enumerate() {
        let k = key(&b.anchor, &b.text);
        if let Some(candidates) = old_keys.get(&k) {
            if candidates.len() == 1 && counts[&k] == 1 {
                matched[i] = Some(candidates[0]);
                used.insert(candidates[0]);
            }
        }
    }
    // An edited block keeps identity only when two unchanged adjacent blocks bracket
    // exactly one old and new block of the same kind and heading context.
    for i in 1..parsed.len().saturating_sub(1) {
        if matched[i].is_some() || parsed[i].anchor.is_some() {
            continue;
        }
        if let (Some(left), Some(right)) = (matched[i - 1], matched[i + 1]) {
            if right == left + 2
                && !used.contains(&(left + 1))
                && old[left + 1].1.is_none()
                && old[left + 1].3 == parsed[i].kind
                && old[left + 1].4 == serde_json::to_string(&parsed[i].heading_path).unwrap()
            {
                matched[i] = Some(left + 1);
                used.insert(left + 1);
            }
        }
    }
    let removed: Vec<_> = old
        .iter()
        .enumerate()
        .filter(|(i, _)| !used.contains(i))
        .map(|(_, b)| b.0.clone())
        .collect();
    let mut changed = removed.clone();
    for (i, b) in parsed.iter().enumerate() {
        if let Some(j) = matched[i] {
            if title_changed
                || old[j].2 != b.text
                || old[j].3 != b.kind
                || old[j].4 != serde_json::to_string(&b.heading_path).unwrap()
            {
                changed.push(old[j].0.clone());
            }
        }
    }
    let changed_json = serde_json::to_string(&changed).unwrap();
    tx.execute("DELETE FROM knowledge_fts WHERE rowid IN (SELECT fts_rowid FROM knowledge_blocks WHERE note_id=?1 AND id IN (SELECT value FROM json_each(?2)))",params![id,changed_json]).map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM knowledge_fts WHERE rowid=(SELECT empty_fts_rowid FROM knowledge_notes WHERE id=?1)",[&id]).map_err(|e|e.to_string())?;
    tx.execute(
        "UPDATE knowledge_notes SET empty_fts_rowid=NULL WHERE id=?1",
        [&id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("UPDATE knowledge_blocks SET deleted=1,fts_rowid=NULL WHERE note_id=?1 AND id IN (SELECT value FROM json_each(?2))",params![id,serde_json::to_string(&removed).unwrap()]).map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM knowledge_edges WHERE source=?1 AND source_block IN (SELECT value FROM json_each(?2))",params![id,changed_json]).map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM knowledge_chunk_blocks WHERE note_id=?1", [&id])
        .map_err(|e| e.to_string())?;
    let wiki = regex::Regex::new(r"\[\[([^\[\]]+)\]\]").unwrap();
    for (i, b) in parsed.iter().enumerate() {
        let bid = matched[i]
            .map(|j| old[j].0.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if matched[i].is_some_and(|j| {
            !title_changed
                && old[j].2 == b.text
                && old[j].3 == b.kind
                && old[j].4 == serde_json::to_string(&b.heading_path).unwrap()
        }) {
            tx.execute("UPDATE knowledge_blocks SET ordinal=?2,start_line=?3,end_line=?4 WHERE id=?1 AND (ordinal!=?2 OR start_line!=?3 OR end_line!=?4)",params![bid,i as i64,b.start_line as i64,b.end_line as i64]).map_err(|e|e.to_string())?;
            tx.execute(
                "UPDATE knowledge_edges SET start_line=?2 WHERE source_block=?1 AND start_line!=?2",
                params![bid, b.start_line as i64],
            )
            .map_err(|e| e.to_string())?;
            continue;
        }
        let bh = blocks::hash(&b.text);
        let heading = serde_json::to_string(&b.heading_path).unwrap();
        tx.execute("INSERT INTO knowledge_blocks(id,note_id,anchor,text,kind,heading_path,hash,ordinal,start_line,end_line) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET text=excluded.text,kind=excluded.kind,heading_path=excluded.heading_path,hash=excluded.hash,ordinal=excluded.ordinal,start_line=excluded.start_line,end_line=excluded.end_line,deleted=0,updated_at=unixepoch()",params![bid,id,b.anchor,b.text,b.kind,heading,bh,i as i64,b.start_line as i64,b.end_line as i64]).map_err(|e|e.to_string())?;
        if b.kind != "code" {
            for capture in wiki.captures_iter(&b.text) {
                let target = capture[1].split('|').next().unwrap_or("").trim();
                let (target, anchor) = target
                    .split_once("#^")
                    .map(|(n, a)| (n, Some(a)))
                    .unwrap_or((target, None));
                tx.execute("INSERT OR IGNORE INTO knowledge_edges(source,source_block,target_ref,target_anchor,start_line) VALUES (?1,?2,?3,?4,?5)",params![id,bid,if target.is_empty(){title.as_ref()}else{target},anchor,b.start_line as i64]).map_err(|e|e.to_string())?;
            }
        }
        tx.execute(
            "INSERT INTO knowledge_fts(block_id,note_id,title,text) VALUES (?1,?2,?3,?4)",
            params![bid, id, title, b.text],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE knowledge_blocks SET fts_rowid=?2 WHERE id=?1",
            params![bid, tx.last_insert_rowid()],
        )
        .map_err(|e| e.to_string())?;
    }
    if parsed.is_empty() {
        tx.execute(
            "INSERT INTO knowledge_fts(block_id,note_id,title,text) VALUES (NULL,?1,?2,'')",
            params![id, title],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE knowledge_notes SET empty_fts_rowid=?2 WHERE id=?1",
            params![id, tx.last_insert_rowid()],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE knowledge_vaults SET revision=revision+1 WHERE id=?1",
        [vault_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok((id, true))
}
pub fn move_path(conn: &Connection, old: &str, new: &str) -> Result<(), String> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE knowledge_notes SET path=?1,revision=revision+1 WHERE path=?2",
        params![new, old],
    )
    .map_err(|e| e.to_string())?;
    tx.execute_batch("PRAGMA defer_foreign_keys=ON")
        .map_err(|e| e.to_string())?;
    for table in ["note_history_base", "note_history_deltas", "denied_links"] {
        tx.execute(
            &format!("UPDATE {table} SET note_path=?1 WHERE note_path=?2"),
            params![new, old],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE knowledge_embedding_provenance SET path=?1 WHERE path=?2",
        params![new, old],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
pub fn remove(conn: &Connection, path: &str) -> Result<(), String> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_fts WHERE note_id IN (SELECT id FROM knowledge_notes WHERE path=?1)",
        [path],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("UPDATE knowledge_blocks SET fts_rowid=NULL WHERE note_id IN (SELECT id FROM knowledge_notes WHERE path=?1)",[path]).map_err(|e|e.to_string())?;
    tx.execute(
        "UPDATE knowledge_notes SET deleted=1,empty_fts_rowid=NULL,revision=revision+1 WHERE path=?1",
        [path],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub sequence: i64,
    pub vault_id: String,
    pub kind: String,
    pub entity_id: String,
}
pub fn emit(
    app: &tauri::AppHandle,
    c: &Connection,
    vault: &str,
    kind: &str,
    id: &str,
) -> Result<(), String> {
    c.execute(
        "INSERT INTO knowledge_events(vault_id,kind,entity_id) VALUES (?1,?2,?3)",
        params![vault, kind, id],
    )
    .map_err(|e| e.to_string())?;
    app.emit(
        "knowledge-event",
        RuntimeEvent {
            sequence: c.last_insert_rowid(),
            vault_id: vault.into(),
            kind: kind.into(),
            entity_id: id.into(),
        },
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn knowledge_snapshot(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let s = current(&app)?;
    let c = crate::db::init_db(&app)?;
    let revision: i64 = c
        .query_row(
            "SELECT revision FROM knowledge_vaults WHERE id=?1",
            [&s.vault_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let sequence: i64 = c
        .query_row(
            "SELECT coalesce(max(sequence),0) FROM knowledge_events WHERE vault_id=?1",
            [&s.vault_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"scope":s,"revision":revision,"sequence":sequence}))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        schema::migrate(&c).unwrap();
        vault(&c, Path::new("/vault")).unwrap();
        c
    }
    fn ids(c: &Connection) -> Vec<String> {
        let mut s = c
            .prepare("SELECT id FROM knowledge_blocks WHERE deleted=0 ORDER BY ordinal")
            .unwrap();
        s.query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }
    #[test]
    fn identity_survives_reorder_and_bounded_edit() {
        let c = setup();
        let v = vault(&c, Path::new("/vault")).unwrap();
        sync(&c, &v, "/vault/a.md", "First\n\nMiddle\n\nLast").unwrap();
        let a = ids(&c);
        sync(&c, &v, "/vault/a.md", "First\n\nMiddle edited\n\nLast").unwrap();
        assert_eq!(a, ids(&c));
        sync(&c, &v, "/vault/a.md", "Last\n\nFirst\n\nMiddle edited").unwrap();
        let b = ids(&c);
        assert_eq!(b, vec![a[2].clone(), a[0].clone(), a[1].clone()]);
    }
    #[test]
    fn duplicates_are_not_silently_retargeted() {
        let c = setup();
        let v = vault(&c, Path::new("/vault")).unwrap();
        sync(&c, &v, "/vault/a.md", "Same\n\nSame").unwrap();
        let a = ids(&c);
        sync(&c, &v, "/vault/a.md", "Same\n\nOther").unwrap();
        assert!(ids(&c).iter().all(|b| !a.contains(b)));
    }
}

pub fn dictionary(conn: &Connection, vault_id: &str) -> Result<Vec<(String, String)>, String> {
    let mut stmt=conn.prepare("SELECT path,title FROM knowledge_notes WHERE vault_id=?1 AND deleted=0 UNION SELECT a.note_id,a.alias FROM aliases a JOIN knowledge_notes n ON n.path=a.note_id WHERE n.vault_id=?1 AND n.deleted=0 ORDER BY 2").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([vault_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}
pub fn validate_path(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    let scope = current(app)?;
    let mut ancestor = path;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("Path has no existing parent")?;
    }
    if !std::fs::canonicalize(ancestor)
        .map_err(|e| e.to_string())?
        .starts_with(&scope.root)
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Path is outside the active vault".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBlock {
    pub id: String,
    pub note_id: String,
    pub text: String,
    pub kind: String,
    pub heading_path: serde_json::Value,
    pub anchor: Option<String>,
    pub hash: String,
    pub ordinal: i64,
    pub start_line: i64,
    pub end_line: i64,
    pub source_id: Option<String>,
    pub source_page: Option<i64>,
    pub source_bbox: Option<String>,
    pub updated_at: i64,
}
#[tauri::command]
pub fn get_knowledge_blocks(
    app: tauri::AppHandle,
    note_id: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<KnowledgeBlock>, String> {
    let scope = current(&app)?;
    let c = crate::db::init_db(&app)?;
    let mut st=c.prepare("SELECT b.id,b.note_id,b.text,b.kind,b.heading_path,b.anchor,b.hash,b.ordinal,b.start_line,b.end_line,b.source_id,b.source_page,b.source_bbox,b.updated_at FROM knowledge_blocks b JOIN knowledge_notes n ON n.id=b.note_id WHERE n.vault_id=?1 AND (n.id=?2 OR n.path=?2) AND n.deleted=0 AND b.deleted=0 ORDER BY b.ordinal LIMIT ?3 OFFSET ?4").map_err(|e|e.to_string())?;
    let rows = st
        .query_map(
            params![
                scope.vault_id,
                note_id,
                limit.clamp(1, 100) as i64,
                offset as i64
            ],
            |r| {
                Ok(KnowledgeBlock {
                    id: r.get(0)?,
                    note_id: r.get(1)?,
                    text: r.get(2)?,
                    kind: r.get(3)?,
                    heading_path: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                    anchor: r.get(5)?,
                    hash: r.get(6)?,
                    ordinal: r.get(7)?,
                    start_line: r.get(8)?,
                    end_line: r.get(9)?,
                    source_id: r.get(10)?,
                    source_page: r.get(11)?,
                    source_bbox: r.get(12)?,
                    updated_at: r.get(13)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}
#[cfg(test)]
mod incremental_tests {
    use super::*;
    #[test]
    fn unchanged_blocks_keep_their_fts_rows_and_deleted_notes_can_return() {
        let c = Connection::open_in_memory().unwrap();
        schema::migrate(&c).unwrap();
        let v = vault(&c, Path::new("/v")).unwrap();
        sync(&c, &v, "/v/n.md", "First\n\nMiddle\n\nLast").unwrap();
        let first: i64 = c
            .query_row(
                "SELECT fts_rowid FROM knowledge_blocks WHERE text='First'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        sync(&c, &v, "/v/n.md", "First\n\nEdited middle\n\nLast").unwrap();
        assert_eq!(
            first,
            c.query_row(
                "SELECT fts_rowid FROM knowledge_blocks WHERE text='First'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM knowledge_fts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
        remove(&c, "/v/n.md").unwrap();
        sync(&c, &v, "/v/n.md", "First\n\nEdited middle\n\nLast").unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM knowledge_fts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }
    #[test]
    fn parallel_index_writers_keep_consistent_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.db");
        let c = Connection::open(&path).unwrap();
        schema::migrate(&c).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL").unwrap();
        let v = vault(&c, Path::new("/v")).unwrap();
        let handles: Vec<_> = (0..4)
            .map(|worker| {
                let path = path.clone();
                let v = v.clone();
                std::thread::spawn(move || {
                    let c = Connection::open(path).unwrap();
                    c.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
                    for n in 0..20 {
                        sync(
                            &c,
                            &v,
                            &format!("/v/{worker}-{n}.md"),
                            &format!("Unique {worker} {n}"),
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(
            c.query_row("SELECT count(*) FROM knowledge_notes", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            80
        );
    }
}

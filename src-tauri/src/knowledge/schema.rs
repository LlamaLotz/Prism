//! Additive runtime schema. Legacy tables remain readable by existing clients.
use rusqlite::Connection;
use std::sync::Mutex;
static MIGRATION: Mutex<()> = Mutex::new(());

pub fn migrate(conn: &Connection) -> Result<(), String> {
    let _guard = MIGRATION.lock().map_err(|_| "Migration lock unavailable")?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if version > 1 {
        return Err("This database was created by a newer Prism version".into());
    }
    if version == 1 {
        return Ok(());
    }
    // SQLite backup includes committed WAL pages; copying just the main file does not.
    if let Some(path) = conn.path().filter(|p| !p.is_empty() && *p != ":memory:") {
        let backup = format!("{path}.before-runtime-{}.db", uuid::Uuid::new_v4());
        conn.backup(rusqlite::DatabaseName::Main, &backup, None)
            .map_err(|e| format!("Cannot back up index: {e}"))?;
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    tx.execute_batch("PRAGMA user_version = 1")
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

const SCHEMA: &str = r#"
CREATE TABLE knowledge_vaults(id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE knowledge_notes(
 id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES knowledge_vaults(id),
 path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 deleted INTEGER NOT NULL DEFAULT 0, empty_fts_rowid INTEGER, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE INDEX knowledge_notes_vault ON knowledge_notes(vault_id, deleted, path);
CREATE TABLE knowledge_blocks(
 id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES knowledge_notes(id), anchor TEXT,
 text TEXT NOT NULL, kind TEXT NOT NULL, heading_path TEXT NOT NULL, hash TEXT NOT NULL,
 ordinal INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
 source_id TEXT, source_page INTEGER, source_bbox TEXT, fts_rowid INTEGER, deleted INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE INDEX knowledge_blocks_note ON knowledge_blocks(note_id, deleted, ordinal);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(block_id UNINDEXED, note_id UNINDEXED, title, text, tokenize='unicode61');
CREATE TABLE knowledge_edges(source TEXT NOT NULL, source_block TEXT NOT NULL, target_ref TEXT NOT NULL, target_anchor TEXT, start_line INTEGER NOT NULL, PRIMARY KEY(source_block,target_ref,target_anchor));
CREATE INDEX knowledge_edges_source ON knowledge_edges(source);
CREATE TABLE knowledge_embedding_provenance(path TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY(path,kind));
CREATE TABLE knowledge_chunk_blocks(
 note_id TEXT NOT NULL, chunk_id TEXT NOT NULL, block_id TEXT NOT NULL REFERENCES knowledge_blocks(id),
 input_hash TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY(note_id,chunk_id,block_id));
CREATE TABLE knowledge_jobs(
 id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, kind TEXT NOT NULL, dedup TEXT NOT NULL,
 priority INTEGER NOT NULL, state TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
 payload TEXT NOT NULL, dependencies TEXT NOT NULL DEFAULT '[]',
 cpu_budget INTEGER NOT NULL DEFAULT 1, gpu_budget INTEGER NOT NULL DEFAULT 0,
 memory_estimate INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE UNIQUE INDEX knowledge_jobs_active ON knowledge_jobs(vault_id,dedup) WHERE state IN ('queued','running','waiting_for_approval');
CREATE TABLE knowledge_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, vault_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE INDEX knowledge_events_vault ON knowledge_events(vault_id,sequence);
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_is_additive_and_repeatable() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE history(value TEXT); INSERT INTO history VALUES ('keep')")
            .unwrap();
        migrate(&c).unwrap();
        migrate(&c).unwrap();
        assert_eq!(
            c.query_row("SELECT value FROM history", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "keep"
        );
        assert!(c
            .execute(
                "INSERT INTO knowledge_fts VALUES ('b','n','Title','unopened content')",
                []
            )
            .is_ok());
    }
    #[test]
    fn failed_schema_rolls_back() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE knowledge_blocks(id TEXT)")
            .unwrap();
        assert!(migrate(&c).is_err());
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(c.prepare("SELECT * FROM knowledge_vaults").is_err());
    }
}

#[cfg(test)]
mod backup_tests {
    use super::*;
    #[test]
    fn backup_contains_committed_wal_and_original_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.db");
        let c = Connection::open(&path).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE history(value TEXT); INSERT INTO history VALUES ('precious history');").unwrap();
        migrate(&c).unwrap();
        let backup = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.to_string_lossy().contains("before-runtime"))
            .unwrap();
        let b = Connection::open(backup).unwrap();
        assert_eq!(
            b.query_row("SELECT value FROM history", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "precious history"
        );
        assert_eq!(
            b.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

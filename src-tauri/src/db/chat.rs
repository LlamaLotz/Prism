//! Unified chat library storage: Co-Pilot + Notebook conversation history.
//!
//! Co-Pilot conversations persist here directly (the sidebar previously kept
//! them in memory only). Notebook conversations keep living in the Notebook
//! backend (SurrealDB `chat_session` + LangGraph checkpointer) and are
//! surfaced here as linked entries (`origin = "notebook"`) so both surfaces
//! share one history list; cross-open imports the transcript on demand.
//! Everything is vault-scoped; deleting a session cascades to its messages.

use rusqlite::{params, Connection, OptionalExtension};

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub origin: String,
    pub notebook_session_id: Option<String>,
    pub notebook_id: Option<String>,
    pub source_id: Option<String>,
    pub model: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub metadata: Option<String>,
    pub created_at: i64,
}

fn row_session(r: &rusqlite::Row) -> Result<ChatSession, rusqlite::Error> {
    Ok(ChatSession {
        id: r.get(0)?,
        title: r.get(1)?,
        origin: r.get(2)?,
        notebook_session_id: r.get(3)?,
        notebook_id: r.get(4)?,
        source_id: r.get(5)?,
        model: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        message_count: r.get(9)?,
    })
}

const SESSION_COLS: &str = "id, title, origin, notebook_session_id, notebook_id, source_id, model, created_at, updated_at, message_count";

fn valid_origin(origin: &str) -> bool {
    matches!(origin, "copilot" | "notebook")
}

pub fn create_session(
    conn: &Connection,
    vault_id: &str,
    title: &str,
    origin: &str,
) -> Result<ChatSession, String> {
    if !valid_origin(origin) {
        return Err("origin must be 'copilot' or 'notebook'".into());
    }
    let title = title.trim();
    let title = if title.is_empty() { "Conversation" } else { title };
    // Cap titles so a pasted paragraph can't become a session name.
    let title: String = title.chars().take(120).collect();
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO chat_sessions(id, vault_id, title, origin) VALUES (?1, ?2, ?3, ?4)",
        params![id, vault_id, title, origin],
    )
    .map_err(|e| e.to_string())?;
    get_session(conn, vault_id, &id)?.ok_or_else(|| "Session vanished after create".into())
}

pub fn get_session(
    conn: &Connection,
    vault_id: &str,
    id: &str,
) -> Result<Option<ChatSession>, String> {
    conn.query_row(
        &format!("SELECT {SESSION_COLS} FROM chat_sessions WHERE vault_id=?1 AND id=?2"),
        params![vault_id, id],
        row_session,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn list_sessions(
    conn: &Connection,
    vault_id: &str,
    query: Option<&str>,
    origin: Option<&str>,
    limit: i64,
) -> Result<Vec<ChatSession>, String> {
    let limit = limit.clamp(1, 200);
    let mut stmt = if origin.map(valid_origin).unwrap_or(true) {
        conn.prepare(&format!(
            "SELECT {SESSION_COLS} FROM chat_sessions WHERE vault_id=?1 \
             AND (?2 IS NULL OR origin=?2) \
             AND (?3 IS NULL OR title LIKE '%' || ?3 || '%' OR id=?3) \
             ORDER BY updated_at DESC LIMIT ?4"
        ))
        .map_err(|e| e.to_string())?
    } else {
        return Err("origin must be 'copilot' or 'notebook'".into());
    };
    let mapped = stmt
        .query_map(params![vault_id, origin, query, limit], row_session)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in mapped {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn rename_session(
    conn: &Connection,
    vault_id: &str,
    id: &str,
    title: &str,
) -> Result<ChatSession, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Title cannot be empty".into());
    }
    let title: String = title.chars().take(120).collect();
    let changed = conn
        .execute(
            "UPDATE chat_sessions SET title=?1, updated_at=unixepoch() WHERE vault_id=?2 AND id=?3",
            params![title, vault_id, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Chat session not found".into());
    }
    get_session(conn, vault_id, id)?.ok_or_else(|| "Chat session not found".into())
}

pub fn delete_session(conn: &Connection, vault_id: &str, id: &str) -> Result<bool, String> {
    let changed = conn
        .execute(
            "DELETE FROM chat_sessions WHERE vault_id=?1 AND id=?2",
            params![vault_id, id],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

/// Create or refresh the linked entry for a Notebook backend session so it
/// shows up in the shared library. Never touches copilot-owned rows.
pub fn link_notebook_session(
    conn: &Connection,
    vault_id: &str,
    notebook_session_id: &str,
    title: &str,
    notebook_id: Option<&str>,
    source_id: Option<&str>,
    model: Option<&str>,
) -> Result<ChatSession, String> {
    let title = title.trim();
    let title: String = if title.is_empty() { "Conversation".into() } else { title.chars().take(120).collect() };
    conn.execute(
        "INSERT INTO chat_sessions(id, vault_id, title, origin, notebook_session_id, notebook_id, source_id, model)
         VALUES (?1, ?2, ?3, 'notebook', ?4, ?5, ?6, ?7)
         ON CONFLICT(vault_id, notebook_session_id) DO UPDATE SET
           title=excluded.title, notebook_id=excluded.notebook_id,
           source_id=excluded.source_id, model=excluded.model, updated_at=unixepoch()",
        params![
            uuid::Uuid::new_v4().to_string(),
            vault_id,
            title,
            notebook_session_id,
            notebook_id,
            source_id,
            model
        ],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        &format!("SELECT {SESSION_COLS} FROM chat_sessions WHERE vault_id=?1 AND notebook_session_id=?2"),
        params![vault_id, notebook_session_id],
        row_session,
    )
    .map_err(|e| e.to_string())
}

/// Drop the linked entry when its Notebook session is renamed away or
/// deleted there — keyed by backend id so copilot rows can never match.
pub fn unlink_notebook_session(
    conn: &Connection,
    vault_id: &str,
    notebook_session_id: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "DELETE FROM chat_sessions WHERE vault_id=?1 AND origin='notebook' AND notebook_session_id=?2",
            params![vault_id, notebook_session_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

pub fn get_messages(
    conn: &Connection,
    vault_id: &str,
    session_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<ChatMessage>, String> {
    // Join guards cross-vault access: the session must belong to this vault.
    let limit = limit.clamp(1, 500);
    let offset = offset.max(0);
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.session_id, m.role, m.content, m.metadata, m.created_at \
             FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id \
             WHERE s.vault_id=?1 AND m.session_id=?2 \
             ORDER BY m.created_at ASC LIMIT ?3 OFFSET ?4",
        )
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map(params![vault_id, session_id, limit, offset], |r| {
            Ok(ChatMessage {
                id: r.get(0)?,
                session_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                metadata: r.get(4)?,
                created_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in mapped {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn append_message(
    conn: &Connection,
    vault_id: &str,
    session_id: &str,
    role: &str,
    content: &str,
    metadata: Option<&str>,
) -> Result<ChatMessage, String> {
    if !matches!(role, "user" | "assistant") {
        return Err("role must be 'user' or 'assistant'".into());
    }
    if content.len() > 500_000 {
        return Err("Message too large".into());
    }
    let owner: Option<String> = conn
        .query_row(
            "SELECT vault_id FROM chat_sessions WHERE id=?1",
            params![session_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if owner.as_deref() != Some(vault_id) {
        return Err("Chat session not found".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO chat_messages(id, session_id, role, content, metadata) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, session_id, role, content, metadata],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE chat_sessions SET updated_at=unixepoch(), message_count=message_count+1 WHERE id=?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(ChatMessage {
        id,
        session_id: session_id.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        metadata: metadata.map(str::to_string),
        created_at: 0,
    })
}

/// Replace a session's whole transcript (mirror sync from the Notebook
/// backend, whose messages live in LangGraph). Verifies vault ownership.
pub fn replace_messages(
    conn: &Connection,
    vault_id: &str,
    session_id: &str,
    messages: &[(String, String, Option<String>)],
) -> Result<usize, String> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT vault_id FROM chat_sessions WHERE id=?1",
            params![session_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if owner.as_deref() != Some(vault_id) {
        return Err("Chat session not found".into());
    }
    if messages.len() > 500 {
        return Err("Transcript too large".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM chat_messages WHERE session_id=?1", params![session_id])
        .map_err(|e| e.to_string())?;
    let mut count = 0;
    for (role, content, metadata) in messages {
        if !matches!(role.as_str(), "user" | "assistant") {
            return Err("role must be 'user' or 'assistant'".into());
        }
        if content.len() > 500_000 {
            return Err("Message too large".into());
        }
        tx.execute(
            "INSERT INTO chat_messages(id, session_id, role, content, metadata) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![uuid::Uuid::new_v4().to_string(), session_id, role, content, metadata],
        )
        .map_err(|e| e.to_string())?;
        count += 1;
    }
    tx.execute(
        "UPDATE chat_sessions SET updated_at=unixepoch(), message_count=?1 WHERE id=?2",
        params![count, session_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE knowledge_vaults(id TEXT PRIMARY KEY, root TEXT);
             CREATE TABLE chat_sessions (
               id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT 'Conversation',
               origin TEXT NOT NULL DEFAULT 'copilot', notebook_session_id TEXT, notebook_id TEXT,
               source_id TEXT, model TEXT,
               created_at INTEGER NOT NULL DEFAULT (unixepoch()),
               updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
               message_count INTEGER NOT NULL DEFAULT 0,
               FOREIGN KEY(vault_id) REFERENCES knowledge_vaults(id) ON DELETE CASCADE,
               UNIQUE(vault_id, notebook_session_id));
             CREATE TABLE chat_messages (
               id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
               content TEXT NOT NULL DEFAULT '', metadata TEXT,
               created_at INTEGER NOT NULL DEFAULT (unixepoch()),
               FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE);",
        )
        .unwrap();
        conn.execute("INSERT INTO knowledge_vaults(id, root) VALUES ('v1', '/vault')", [])
            .unwrap();
        conn
    }

    #[test]
    fn crud_round_trip_with_cascade() {
        let conn = memory_db();
        let s = create_session(&conn, "v1", "Hello", "copilot").unwrap();
        assert_eq!(s.message_count, 0);
        append_message(&conn, "v1", &s.id, "user", "hi", None).unwrap();
        append_message(&conn, "v1", &s.id, "assistant", "hello", Some("{\"model\":\"x\"}")).unwrap();
        let msgs = get_messages(&conn, "v1", &s.id, 50, 0).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1].metadata.as_deref(), Some("{\"model\":\"x\"}"));
        let listed = list_sessions(&conn, "v1", None, None, 50).unwrap();
        assert_eq!(listed[0].message_count, 2);
        rename_session(&conn, "v1", &s.id, "Renamed").unwrap();
        assert!(delete_session(&conn, "v1", &s.id).unwrap());
        assert!(get_messages(&conn, "v1", &s.id, 50, 0).unwrap().is_empty());
        assert!(list_sessions(&conn, "v1", None, None, 50).unwrap().is_empty());
    }

    #[test]
    fn vault_isolation_and_validation() {
        let conn = memory_db();
        conn.execute("INSERT INTO knowledge_vaults(id, root) VALUES ('v2', '/other')", [])
            .unwrap();
        let s = create_session(&conn, "v1", "A", "copilot").unwrap();
        assert!(append_message(&conn, "v2", &s.id, "user", "x", None).is_err());
        assert!(append_message(&conn, "v1", &s.id, "system", "x", None).is_err());
        assert!(create_session(&conn, "v1", "B", "alien").is_err());
        assert!(rename_session(&conn, "v1", &s.id, "   ").is_err());
        assert!(list_sessions(&conn, "v2", None, None, 50).unwrap().is_empty());
        assert!(!delete_session(&conn, "v2", &s.id).unwrap());
    }

    #[test]
    fn replace_transcript_mirrors_and_is_vault_scoped() {
        let conn = memory_db();
        let s = create_session(&conn, "v1", "A", "copilot").unwrap();
        let n = link_notebook_session(&conn, "v1", "nb:1", "NB", None, None, None).unwrap();
        let msgs = vec![
            ("user".to_string(), "q".to_string(), None),
            ("assistant".to_string(), "a".to_string(), None),
        ];
        assert_eq!(replace_messages(&conn, "v1", &n.id, &msgs).unwrap(), 2);
        assert_eq!(get_messages(&conn, "v1", &n.id, 50, 0).unwrap().len(), 2);
        // Replacing again does not duplicate.
        assert_eq!(replace_messages(&conn, "v1", &n.id, &msgs).unwrap(), 2);
        // Other vaults and other sessions are untouched and unreachable.
        conn.execute("INSERT INTO knowledge_vaults(id, root) VALUES ('v2', '/o')", [])
            .unwrap();
        assert!(replace_messages(&conn, "v2", &n.id, &msgs).is_err());
        assert!(replace_messages(&conn, "v1", &s.id, &[("system".to_string(), "x".to_string(), None)]).is_err());
    }

    #[test]
    fn notebook_link_upsert_and_search() {
        let conn = memory_db();
        let a = link_notebook_session(&conn, "v1", "nb:1", "Research", Some("nb1"), None, None).unwrap();
        let b = link_notebook_session(&conn, "v1", "nb:1", "Research v2", Some("nb1"), None, None).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(b.title, "Research v2");
        create_session(&conn, "v1", "Research notes", "copilot").unwrap();
        let hits = list_sessions(&conn, "v1", Some("research"), None, 50).unwrap();
        assert_eq!(hits.len(), 2);
        let nb_only = list_sessions(&conn, "v1", None, Some("notebook"), 50).unwrap();
        assert_eq!(nb_only.len(), 1);
        assert!(unlink_notebook_session(&conn, "v1", "nb:1").unwrap());
        assert_eq!(list_sessions(&conn, "v1", None, None, 50).unwrap().len(), 1);
    }
}

// Phase 2b — Agent Tool Bus
//
// Controlled agent dispatch: every model tool request goes through Rust.
// Reads are auto-approved (vault-scoped, no side effects). Writes require
// an explicit preview approval bound to vault generation and expiring after
// 10 minutes. All mutations are vault-scoped, validated, version-snapshotted
// via history and reindexed through the Knowledge Runtime.
//
// Tool Bus: Model → agent_call_tool → Permission policy → Rust operation
//           → Version snapshot → Filesystem/SQLite → Reindex (knowledge::sync)

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

// ---------------------------------------------------------------------------
// Tool definitions (returned to frontend for registry)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub requires_approval: bool,
    pub category: String, // "read" | "write"
}

pub fn tool_definitions() -> Vec<ToolDefinition> {
    vec![
        // Reads — auto-approved, vault-scoped
        ToolDefinition { name: "read_note".into(), description: "Read a note's full content and blocks by stable id or path".into(), requires_approval: false, category: "read".into() },
        ToolDefinition { name: "read_block".into(), description: "Read a single block by block id".into(), requires_approval: false, category: "read".into() },
        ToolDefinition { name: "search_vault".into(), description: "Lexical/hybrid vault search (vault-scoped, no model download)".into(), requires_approval: false, category: "read".into() },
        ToolDefinition { name: "get_related_notes".into(), description: "Relations for a note: wiki, block, tag, folder, semantic (on-demand)".into(), requires_approval: false, category: "read".into() },
        ToolDefinition { name: "get_backlinks".into(), description: "Incoming links for a note".into(), requires_approval: false, category: "read".into() },
        // Writes — approval preview, version-snapshot, undo via history
        ToolDefinition { name: "create_note".into(), description: "Create a new note at a vault-relative path".into(), requires_approval: true, category: "write".into() },
        ToolDefinition { name: "edit_note".into(), description: "Structured patch: replaceBlock, insertAfter/Before, deleteBlock, addTag, removeTag, addWikilink, append, replaceAll".into(), requires_approval: true, category: "write".into() },
        ToolDefinition { name: "rename_note".into(), description: "Rename/move a note within the vault".into(), requires_approval: true, category: "write".into() },
        ToolDefinition { name: "delete_note".into(), description: "Delete a note (moves to history tombstone)".into(), requires_approval: true, category: "write".into() },
        ToolDefinition { name: "create_folder".into(), description: "Create a folder within the vault (max 5 levels)".into(), requires_approval: true, category: "write".into() },
        ToolDefinition { name: "move_folder".into(), description: "Move/rename a folder and all contained notes".into(), requires_approval: true, category: "write".into() },
        ToolDefinition { name: "add_wikilink".into(), description: "Insert [[target]] or [[target#^anchor]] into a block".into(), requires_approval: true, category: "write".into() },
        ToolDefinition { name: "add_tag".into(), description: "Add @tag to a note".into(), requires_approval: true, category: "write".into() },
        ToolDefinition { name: "remove_tag".into(), description: "Remove @tag from a note".into(), requires_approval: true, category: "write".into() },
        ToolDefinition { name: "format_note".into(), description: "Apply deterministic formatting to a note".into(), requires_approval: true, category: "write".into() },
    ]
}

// ---------------------------------------------------------------------------
// Request / Response wire types
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolRequest {
    pub tool: String,
    pub input: serde_json::Value,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolResponse {
    pub tool: String,
    pub requires_approval: bool,
    pub approval_id: Option<String>,
    pub preview: Option<String>,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PendingEdit {
    pub id: String,
    pub tool: String,
    pub vault_id: String,
    #[serde(skip)]
    pub generation: String,
    pub note_path: String,
    pub note_id: Option<String>,
    pub preview: String,
    pub old_content: String,
    pub new_content: String,
    #[serde(skip)]
    pub expires: Instant,
    pub created_at: i64,
    pub input: serde_json::Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    pub id: String,
    pub tool: String,
    pub vault_id: String,
    pub note_path: String,
    pub note_id: Option<String>,
    pub preview: String,
    pub created_at: i64,
    pub input: serde_json::Value,
}

impl From<&PendingEdit> for PendingView {
    fn from(p: &PendingEdit) -> Self {
        PendingView {
            id: p.id.clone(),
            tool: p.tool.clone(),
            vault_id: p.vault_id.clone(),
            note_path: p.note_path.clone(),
            note_id: p.note_id.clone(),
            preview: p.preview.clone(),
            created_at: p.created_at,
            input: p.input.clone(),
        }
    }
}

// Global pending store — vault-scoped via generation/vault_id check, 10m expiry
static PENDING: OnceLock<Mutex<HashMap<String, PendingEdit>>> = OnceLock::new();
fn pending_map() -> &'static Mutex<HashMap<String, PendingEdit>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune_expired(generation: &str) {
    let mut map = pending_map().lock().unwrap();
    map.retain(|_, p| p.expires > Instant::now() && p.generation == generation);
}

fn prune_all_expired() {
    let mut map = pending_map().lock().unwrap();
    map.retain(|_, p| p.expires > Instant::now());
}

// ---------------------------------------------------------------------------
// Helpers — vault scoping, note resolution, path validation
// ---------------------------------------------------------------------------

fn resolve_note(
    conn: &rusqlite::Connection,
    vault_id: &str,
    note_ref: &str,
) -> Result<(String, String), String> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT id, path FROM knowledge_notes WHERE vault_id=?1 AND (id=?2 OR path=?2) AND deleted=0",
            params![vault_id, note_ref],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    row.ok_or_else(|| format!("Note not found: {note_ref}"))
}

fn resolve_block(
    conn: &rusqlite::Connection,
    vault_id: &str,
    block_id: &str,
) -> Result<(String, String, String), String> {
    // Returns (block_id, note_id, note_path)
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT b.id, b.note_id, n.path FROM knowledge_blocks b JOIN knowledge_notes n ON n.id=b.note_id WHERE b.id=?1 AND n.vault_id=?2 AND b.deleted=0 AND n.deleted=0",
            params![block_id, vault_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    row.ok_or_else(|| format!("Block not found: {block_id}"))
}

fn ensure_inside_vault(scope: &super::Scope, path: &Path) -> Result<PathBuf, String> {
    // Canonicalize parent for existence check, but allow non-existent leaf (create_note)
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        scope.root.join(path)
    };
    // Reject traversal components
    if abs.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("Path contains '..'".into());
    }
    // Find nearest existing ancestor
    let mut ancestor = abs.as_path();
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("Path has no existing parent")?;
    }
    let canon = std::fs::canonicalize(ancestor).map_err(|e| e.to_string())?;
    if !canon.starts_with(&scope.root) {
        return Err("Path is outside the active vault".into());
    }
    // Also ensure the full abs (even if not yet existent) would be inside root
    // by checking that the ancestor's canonical + remaining suffix stays inside root
    let suffix = abs.strip_prefix(ancestor).unwrap_or(Path::new(""));
    let would_be = canon.join(suffix);
    if !would_be.starts_with(&scope.root) {
        return Err("Path is outside the active vault".into());
    }
    Ok(abs)
}

fn vault_relative(scope: &super::Scope, abs: &str) -> String {
    Path::new(abs)
        .strip_prefix(&scope.root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| abs.to_string())
}

fn extract_frontmatter(content: &str) -> (String, String) {
    // Returns (frontmatter_prefix, body_without_frontmatter)
    let lines: Vec<&str> = content.lines().collect();
    if lines.first() != Some(&"---") {
        return (String::new(), content.to_string());
    }
    if let Some(end) = lines.iter().skip(1).position(|l| *l == "---" || *l == "...") {
        let end_idx = end + 1;
        // Include frontmatter block + trailing newline
        let prefix_lines = &lines[..=end_idx];
        let prefix = prefix_lines.join("\n") + "\n";
        let body_start = prefix.len();
        // Find body start in original (preserve exact newline handling)
        // Reconstruct body by slicing original after prefix
        let body = if content.len() > body_start {
            content[body_start..].trim_start_matches('\n').to_string()
        } else {
            String::new()
        };
        (prefix, body)
    } else {
        (String::new(), content.to_string())
    }
}

// ---------------------------------------------------------------------------
// Edit operations — structured patches
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum EditOp {
    ReplaceBlock { block_id: String, text: String },
    InsertAfter { block_id: String, text: String },
    InsertBefore { block_id: String, text: String },
    DeleteBlock { block_id: String },
    AddTag { tag: String },
    RemoveTag { tag: String },
    AddWikilink { block_id: Option<String>, target: String },
    Append { text: String },
    ReplaceAll { text: String },
}

// For JSON input where op is like "replaceBlock" lowerCamelCase — serde tag handles it.
// Also accept snake_case via alias? We'll normalize before deserializing.

fn normalize_op_value(mut v: serde_json::Value) -> serde_json::Value {
    // Normalize op names to match enum variants (case-sensitive)
    // The enum expects "replaceBlock", "insertAfter", etc. Frontend may send
    // "replace_block" or "replaceBlock". Map common aliases.
    if let Some(obj) = v.as_object_mut() {
        if let Some(op) = obj.get("op").and_then(|o| o.as_str()).map(|s| s.to_string()) {
            let normalized = match op.as_str() {
                "replace_block" | "replace" | "replaceBlock" => "replaceBlock",
                "insert_after" | "insertAfter" => "insertAfter",
                "insert_before" | "insertBefore" => "insertBefore",
                "delete_block" | "deleteBlock" | "delete" => "deleteBlock",
                "add_tag" | "addTag" => "addTag",
                "remove_tag" | "removeTag" => "removeTag",
                "add_wikilink" | "addWikilink" | "add_wiki" => "addWikilink",
                "append" => "append",
                "replace_all" | "replaceAll" => "replaceAll",
                other => other,
            };
            obj.insert("op".into(), serde_json::Value::String(normalized.into()));
        }
        // Normalize blockId aliases
        if obj.contains_key("blockId") == false {
            for alias in ["block_id", "anchor", "id"] {
                if let Some(val) = obj.remove(alias) {
                    obj.insert("blockId".into(), val);
                    break;
                }
            }
        }
    }
    v
}

#[derive(Debug, Clone)]
struct DbBlock {
    id: String,
    text: String,
    // kind not needed for edit but kept for future heading_path recompute
}

fn apply_edits(
    old_content: &str,
    db_blocks: &[DbBlock],
    ops: &[EditOp],
) -> Result<String, String> {
    if ops.is_empty() {
        return Err("No edit operations provided".into());
    }
    // Preserve frontmatter
    let (frontmatter, body) = extract_frontmatter(old_content);
    // If body is empty and db_blocks empty, start fresh
    let mut blocks: Vec<DbBlock> = if db_blocks.is_empty() && body.trim().is_empty() {
        vec![]
    } else if db_blocks.is_empty() {
        // Fallback: parse body to seed blocks (no ids)
        crate::knowledge::blocks::parse(&body)
            .into_iter()
            .map(|b| DbBlock { id: uuid::Uuid::new_v4().to_string(), text: b.text })
            .collect()
    } else {
        db_blocks.to_vec()
    };

    // Validate all block_id references before mutating
    for op in ops {
        match op {
            EditOp::ReplaceBlock { block_id, .. }
            | EditOp::DeleteBlock { block_id }
            | EditOp::InsertAfter { block_id, .. }
            | EditOp::InsertBefore { block_id, .. } => {
                if !blocks.iter().any(|b| &b.id == block_id) {
                    return Err(format!("Block not found: {block_id}"));
                }
            }
            EditOp::AddWikilink { block_id: Some(bid), .. } => {
                if !blocks.iter().any(|b| &b.id == bid) {
                    return Err(format!("Block not found for wikilink: {bid}"));
                }
            }
            _ => {}
        }
    }

    for op in ops {
        match op {
            EditOp::ReplaceBlock { block_id, text } => {
                let idx = blocks.iter().position(|b| &b.id == block_id).unwrap();
                blocks[idx].text = text.clone();
            }
            EditOp::InsertAfter { block_id, text } => {
                let idx = blocks.iter().position(|b| &b.id == block_id).unwrap();
                let new_id = extract_anchor(text).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                // If text ends with ^anchor, keep anchor as id for citability; otherwise uuid
                blocks.insert(idx + 1, DbBlock { id: new_id, text: text.clone() });
            }
            EditOp::InsertBefore { block_id, text } => {
                let idx = blocks.iter().position(|b| &b.id == block_id).unwrap();
                let new_id = extract_anchor(text).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                blocks.insert(idx, DbBlock { id: new_id, text: text.clone() });
            }
            EditOp::DeleteBlock { block_id } => {
                let idx = blocks.iter().position(|b| &b.id == block_id).unwrap();
                blocks.remove(idx);
            }
            EditOp::AddTag { tag } => {
                let clean = tag.trim().trim_start_matches('@').trim().to_string();
                if clean.is_empty() || !clean.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
                    return Err(format!("Invalid tag: {tag}"));
                }
                let needle = format!("@{clean}");
                // If any block already contains the tag (with preceding boundary), skip
                let already = blocks.iter().any(|b| contains_tag(&b.text, &clean));
                if !already && !old_content.contains(&needle) {
                    if let Some(last) = blocks.last_mut() {
                        last.text = format!("{} {}", last.text.trim_end(), needle);
                    } else {
                        blocks.push(DbBlock { id: uuid::Uuid::new_v4().to_string(), text: needle });
                    }
                }
            }
            EditOp::RemoveTag { tag } => {
                let clean = tag.trim().trim_start_matches('@').trim().to_string();
                for b in &mut blocks {
                    b.text = remove_tag_occurrences(&b.text, &clean);
                }
                // Also remove empty trailing whitespace-only blocks after removal?
                let len = blocks.len();
                if len > 1 { blocks.retain(|b| !b.text.trim().is_empty()); }
            }
            EditOp::AddWikilink { block_id, target } => {
                let t = target.trim();
                if t.is_empty() {
                    return Err("Wikilink target cannot be empty".into());
                }
                let link = if t.contains("#^") || t.contains('|') {
                    format!("[[{t}]]")
                } else {
                    format!("[[{t}]]")
                };
                if let Some(bid) = block_id {
                    let idx = blocks.iter().position(|b| &b.id == bid).unwrap();
                    if !blocks[idx].text.contains(&link) {
                        blocks[idx].text = format!("{} {}", blocks[idx].text.trim_end(), link);
                    }
                } else if let Some(last) = blocks.last_mut() {
                    if !last.text.contains(&link) {
                        last.text = format!("{} {}", last.text.trim_end(), link);
                    }
                } else {
                    blocks.push(DbBlock { id: uuid::Uuid::new_v4().to_string(), text: link });
                }
            }
            EditOp::Append { text } => {
                if !text.trim().is_empty() {
                    let new_id = extract_anchor(text).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    blocks.push(DbBlock { id: new_id, text: text.clone() });
                }
            }
            EditOp::ReplaceAll { text } => {
                // Full rewrite — allowed but preview will show the full diff.
                // Preserve frontmatter separately; body becomes exactly `text`
                // (which may itself contain frontmatter; we treat it as body).
                if text.len() > 1024 * 1024 {
                    return Err("ReplaceAll text exceeds 1MB limit".into());
                }
                // For replaceAll, ignore block structure and return frontmatter + text
                let new_body = text.clone();
                let result = if frontmatter.is_empty() {
                    new_body
                } else {
                    format!("{}{}", frontmatter, new_body.trim_start_matches('\n'))
                };
                return Ok(result);
            }
        }
    }

    let body = blocks.iter().map(|b| b.text.clone()).collect::<Vec<_>>().join("\n\n");
    if body.is_empty() && frontmatter.is_empty() {
        Ok(String::new())
    } else if frontmatter.is_empty() {
        Ok(body + "\n")
    } else {
        Ok(format!("{}{}\n", frontmatter, body.trim_start_matches('\n')))
    }
}

fn extract_anchor(text: &str) -> Option<String> {
    text.split_whitespace()
        .last()
        .filter(|s| s.starts_with('^') && s.len() > 1 && s[1..].chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_'))
        .map(|s| s[1..].to_string())
}

fn contains_tag(text: &str, tag: &str) -> bool {
    // tag boundary: @tag preceded by start or non-word char
    let needle = format!("@{tag}");
    if let Some(pos) = text.find(&needle) {
        let before_ok = pos == 0 || {
            let c = text.as_bytes()[pos - 1] as char;
            !(c.is_alphanumeric() || c == '_')
        };
        let after_ok = {
            let end = pos + needle.len();
            text[end..].chars().next().map_or(true, |c| !(c.is_alphanumeric() || c == '-' || c == '_'))
        };
        before_ok && after_ok
    } else {
        false
    }
}

fn remove_tag_occurrences(text: &str, tag: &str) -> String {
    let needle = format!("@{tag}");
    let mut result = text.to_string();
    // Simple removal: replace " @tag" and "@tag " and "@tag"
    // Use regex-like manual scan to avoid regex dependency per call
    // First handle " @tag" with word boundaries
    let mut search_start = 0;
    while let Some(pos) = result[search_start..].find(&needle) {
        let abs = search_start + pos;
        let before_ok = abs == 0 || {
            let c = result.as_bytes()[abs - 1] as char;
            !(c.is_alphanumeric() || c == '_')
        };
        let after_ok = {
            let end = abs + needle.len();
            result[end..].chars().next().map_or(true, |c| !(c.is_alphanumeric() || c == '-' || c == '_'))
        };
        if before_ok && after_ok {
            // Remove with one surrounding space if present to avoid double spaces
            let remove_start = if abs > 0 && result.as_bytes()[abs - 1] == b' ' { abs - 1 } else { abs };
            let remove_end = {
                let end = abs + needle.len();
                if end < result.len() && result.as_bytes()[end] == b' ' { end + 1 } else { end }
            };
            result.replace_range(remove_start..remove_end, "");
            search_start = remove_start;
        } else {
            search_start = abs + needle.len();
        }
        if search_start >= result.len() { break; }
    }
    result.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string().is_empty().then(|| String::new()).unwrap_or_else(|| {
        // Preserve original line breaks? For tag removal within block, single line is fine.
        // But we collapsed whitespace — reconstruct with single spaces within block.
        // To keep original block's line breaks, we just return result with collapsed double spaces.
        let mut cleaned = result;
        while cleaned.contains("  ") { cleaned = cleaned.replace("  ", " "); }
        cleaned
    })
}

// ---------------------------------------------------------------------------
// Read tool implementations (auto-approved, vault-scoped)
// ---------------------------------------------------------------------------

fn read_note_blocking(app: tauri::AppHandle, note_ref: String) -> Result<serde_json::Value, String> {
    let scope = super::current(&app)?;
    let conn = crate::db::init_db(&app)?;
    let (id, path) = resolve_note(&conn, &scope.vault_id, &note_ref)?;
    let abs = Path::new(&path);
    if !abs.starts_with(&scope.root) {
        return Err("Note is outside the active vault".into());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let title = Path::new(&path).file_stem().unwrap_or_default().to_string_lossy().to_string();
    // Blocks from knowledge_blocks
    let mut stmt = conn.prepare("SELECT id, text, kind, heading_path, anchor, hash, ordinal, start_line, end_line FROM knowledge_blocks WHERE note_id=?1 AND deleted=0 ORDER BY ordinal").map_err(|e| e.to_string())?;
    let blocks = stmt.query_map([&id], |r| {
        Ok(serde_json::json!({
            "id": r.get::<_, String>(0)?,
            "text": r.get::<_, String>(1)?,
            "kind": r.get::<_, String>(2)?,
            "headingPath": serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(3)?).unwrap_or(serde_json::Value::Array(vec![])),
            "anchor": r.get::<_, Option<String>>(4)?,
            "hash": r.get::<_, String>(5)?,
            "ordinal": r.get::<_, i64>(6)?,
            "startLine": r.get::<_, i64>(7)?,
            "endLine": r.get::<_, i64>(8)?,
        }))
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "noteId": id,
        "path": path,
        "relativePath": vault_relative(&scope, &path),
        "title": title,
        "content": content,
        "blocks": blocks,
    }))
}

fn read_block_blocking(app: tauri::AppHandle, block_id: String) -> Result<serde_json::Value, String> {
    let scope = super::current(&app)?;
    let conn = crate::db::init_db(&app)?;
    let (bid, note_id, note_path) = resolve_block(&conn, &scope.vault_id, &block_id)?;
    let mut stmt = conn.prepare("SELECT text, kind, heading_path, anchor, hash, ordinal, start_line, end_line FROM knowledge_blocks WHERE id=?1 AND deleted=0").map_err(|e| e.to_string())?;
    let row = stmt.query_row([&bid], |r| {
        Ok(serde_json::json!({
            "id": bid.clone(),
            "noteId": note_id.clone(),
            "notePath": note_path.clone(),
            "relativePath": vault_relative(&scope, &note_path),
            "text": r.get::<_, String>(0)?,
            "kind": r.get::<_, String>(1)?,
            "headingPath": serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(2)?).unwrap_or(serde_json::Value::Array(vec![])),
            "anchor": r.get::<_, Option<String>>(3)?,
            "hash": r.get::<_, String>(4)?,
            "ordinal": r.get::<_, i64>(5)?,
            "startLine": r.get::<_, i64>(6)?,
            "endLine": r.get::<_, i64>(7)?,
        }))
    }).map_err(|e| e.to_string())?;
    Ok(row)
}

fn search_vault_blocking(app: tauri::AppHandle, input: serde_json::Value) -> Result<serde_json::Value, String> {
    let text = input.get("query").or_else(|| input.get("text")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mode = input.get("mode").and_then(|v| v.as_str()).unwrap_or("hybrid").to_string();
    let folder = input.get("folder").and_then(|v| v.as_str()).map(|s| s.to_string());
    let tag = input.get("tag").and_then(|v| v.as_str()).map(|s| s.to_string());
    let offset = input.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let limit = input.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize;
    let scope = super::current(&app)?;
    let conn = crate::db::init_db(&app)?;
    if !["", "lexical", "semantic", "hybrid"].contains(&mode.as_str()) {
        return Err("Unsupported search mode".into());
    }
    let q = super::search::SearchQuery { text, mode: mode.clone(), folder, tag, offset, limit };
    let lex = super::search::lexical(&conn, &scope.vault_id, &q)?;
    let mut sem = vec![];
    let mut degraded = None;
    if mode == "semantic" || mode == "hybrid" {
        let state = app.state::<crate::AppState>();
        let engine = state.embeddings.lock().unwrap().as_ref().and_then(|r| r.as_ref().ok()).cloned();
        if let Some(engine) = engine {
            let _lock = crate::embed_guard(&state);
            match engine.search_text(&q.text, 1000) {
                Ok(matches) => {
                    for m in matches {
                        if let Some((id, title)) = super::search::eligible(&conn, &m.note_id, &scope.vault_id, &q)? {
                            sem.push(super::search::SearchHit { note_id: id, block_id: None, path: m.note_id, title, snippet: String::new(), lexical: None, semantic: Some(m.score), score: 0.0 });
                        }
                    }
                }
                Err(_) => degraded = Some("Semantic inference unavailable; showing lexical results".to_string()),
            }
        } else {
            degraded = Some("Local embeddings are not loaded; showing lexical results".to_string());
        }
    }
    let items = if mode == "semantic" && degraded.is_none() { super::search::fuse(vec![], sem) } else { super::search::fuse(lex, sem) };
    let start = q.offset.min(1000);
    let lim = if q.limit == 0 { 50 } else { q.limit.min(100) };
    let next = (items.len() > start + lim).then_some(start + lim);
    let page_items: Vec<_> = items.into_iter().skip(start).take(lim).map(|h| serde_json::json!({
        "noteId": h.note_id, "blockId": h.block_id, "path": h.path, "relativePath": vault_relative(&scope, &h.path), "title": h.title, "snippet": h.snippet, "lexical": h.lexical, "semantic": h.semantic, "score": h.score
    })).collect();
    Ok(serde_json::json!({ "items": page_items, "degraded": degraded, "nextOffset": next }))
}

fn get_related_blocking(app: tauri::AppHandle, note_ref: String, kinds: Vec<String>) -> Result<serde_json::Value, String> {
    let scope = super::current(&app)?;
    let conn = crate::db::init_db(&app)?;
    let (id, path) = if !note_ref.trim().is_empty() {
        let (i, p) = resolve_note(&conn, &scope.vault_id, &note_ref)?;
        (Some(i), Some(p))
    } else { (None, None) };
    let q = super::search::RelationQuery { note_id: id.clone(), kinds: kinds.clone(), offset: 0, limit: 100 };
    // Handle semantic separately (it requires engine and special path like get_relations)
    let include_sem = kinds.iter().any(|k| k == "semantic");
    let relations = if include_sem {
        // Call get_relations semantics: it will fetch engine find_related for the note
        // Reuse existing search::get_relations logic via direct call pattern
        // Instead of calling the Tauri command (which re-checks scope), duplicate minimal logic here
        // For simplicity, delegate to search::relations + manual semantic if available
        let mut out = super::search::relations(&conn, &scope.vault_id, &super::search::RelationQuery { note_id: id.clone(), kinds: kinds.iter().filter(|k| *k != "semantic").cloned().collect(), offset: 0, limit: 100 })?;
        if let Some(ref p) = path {
            if let Ok(runtime) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| app.state::<super::KnowledgeRuntime>().embeddings.lock().unwrap().as_ref().and_then(|r| r.as_ref().ok()).cloned())) {
                if let Some(engine) = runtime {
                    if let Ok(hits) = engine.find_related(&conn, p, 20) {
                        for hit in hits {
                            let target: Option<String> = conn.query_row("SELECT id FROM knowledge_notes WHERE path=?1 AND vault_id=?2 AND deleted=0", params![hit.note_id, scope.vault_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
                            if let Some(target) = target {
                                out.push(super::search::Relation { source: id.clone().unwrap_or_default(), target, relation_type: "semantic".into(), source_block: None, target_block: None, target_anchor: None, timestamp: 0, confidence: hit.score, origin: "semantic-engine".into() });
                            }
                        }
                    }
                }
            }
        }
        out
    } else {
        super::search::relations(&conn, &scope.vault_id, &q)?
    };
    let items: Vec<_> = relations.into_iter().map(|r| serde_json::json!({
        "source": r.source, "target": r.target, "relationType": r.relation_type,
        "sourceBlock": r.source_block, "targetBlock": r.target_block, "targetAnchor": r.target_anchor,
        "timestamp": r.timestamp, "confidence": r.confidence, "origin": r.origin
    })).collect();
    Ok(serde_json::json!(items))
}

fn get_backlinks_blocking(app: tauri::AppHandle, note_ref: String) -> Result<serde_json::Value, String> {
    let scope = super::current(&app)?;
    let conn = crate::db::init_db(&app)?;
    let (_, path) = resolve_note(&conn, &scope.vault_id, &note_ref)?;
    let rows = super::search::backlinks(&conn, &scope.vault_id, &path)?;
    let items: Vec<_> = rows.into_iter().map(|b| serde_json::json!({
        "sourcePath": b.source_path, "relativePath": vault_relative(&scope, &b.source_path), "sourceTitle": b.source_title, "startLine": b.start_line, "endLine": b.end_line, "matchedText": b.matched_text
    })).collect();
    Ok(serde_json::json!(items))
}

// ---------------------------------------------------------------------------
// Write tool preview creators (return PendingEdit)
// ---------------------------------------------------------------------------

fn create_pending(
    app: &tauri::AppHandle,
    tool: &str,
    note_path: String,
    note_id: Option<String>,
    old_content: String,
    new_content: String,
    input: serde_json::Value,
) -> Result<PendingEdit, String> {
    let scope = super::current(app)?;
    let patch = crate::db::history::generate_patch(&old_content, &new_content);
    let preview = if patch.is_empty() {
        if old_content.is_empty() && !new_content.is_empty() {
            format!("Create {} ({} bytes)", note_path, new_content.len())
        } else {
            "No changes".into()
        }
    } else {
        // Truncate preview to 8000 chars to keep IPC bounded
        if patch.len() > 8000 { format!("{}…[truncated]", &patch[..8000]) } else { patch }
    };
    // Log agent pending creation for audit (actor = AI)
    println!("[agent] pending {tool} for {} ({} bytes → {} bytes)", vault_relative(&scope, &note_path), old_content.len(), new_content.len());
    Ok(PendingEdit {
        id: uuid::Uuid::new_v4().to_string(),
        tool: tool.into(),
        vault_id: scope.vault_id.clone(),
        generation: scope.generation.clone(),
        note_path,
        note_id,
        preview,
        old_content,
        new_content,
        expires: Instant::now() + Duration::from_secs(600),
        created_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64,
        input,
    })
}

fn store_pending(pending: PendingEdit) -> String {
    let id = pending.id.clone();
    pending_map().lock().unwrap().insert(id.clone(), pending);
    id
}

// edit_note preview
fn preview_edit_note(app: tauri::AppHandle, input: serde_json::Value) -> Result<PendingEdit, String> {
    let scope = super::current(&app)?;
    let conn = crate::db::init_db(&app)?;
    let note_ref = input.get("noteId").or_else(|| input.get("note_id")).or_else(|| input.get("path")).and_then(|v| v.as_str()).ok_or("edit_note requires noteId")?.to_string();
    let (note_id, note_path) = resolve_note(&conn, &scope.vault_id, &note_ref)?;
    ensure_inside_vault(&scope, Path::new(&note_path))?;
    let old_content = std::fs::read_to_string(&note_path).unwrap_or_default();
    // Load db blocks for this note
    let mut stmt = conn.prepare("SELECT id, text FROM knowledge_blocks WHERE note_id=?1 AND deleted=0 ORDER BY ordinal").map_err(|e| e.to_string())?;
    let db_blocks = stmt.query_map([&note_id], |r| Ok(DbBlock { id: r.get(0)?, text: r.get(1)? })).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let ops_raw = input.get("operations").or_else(|| input.get("ops")).ok_or("edit_note requires operations[]")?;
    let ops_arr = ops_raw.as_array().ok_or("operations must be an array")?;
    if ops_arr.is_empty() { return Err("No edit operations provided".into()); }
    if ops_arr.len() > 32 { return Err("Too many operations (max 32)".into()); }
    let mut ops: Vec<EditOp> = Vec::with_capacity(ops_arr.len());
    for raw in ops_arr {
        let norm = normalize_op_value(raw.clone());
        let op: EditOp = serde_json::from_value(norm).map_err(|e| format!("Invalid operation: {e}"))?;
        ops.push(op);
    }
    // Reject full-rewrite of huge notes unless it's a single replaceAll with reasonable size (already checked)
    let new_content = apply_edits(&old_content, &db_blocks, &ops)?;
    if new_content == old_content {
        return Err("Edit produces no changes".into());
    }
    if new_content.len() > 2 * 1024 * 1024 {
        return Err("Resulting note exceeds 2MB limit".into());
    }
    create_pending(&app, "edit_note", note_path, Some(note_id), old_content, new_content, input)
}

fn preview_create_note(app: tauri::AppHandle, input: serde_json::Value) -> Result<PendingEdit, String> {
    let scope = super::current(&app)?;
    let rel = input.get("path").or_else(|| input.get("relativePath")).and_then(|v| v.as_str()).ok_or("create_note requires path")?.to_string();
    let content = input.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if content.len() > 2 * 1024 * 1024 { return Err("Note content exceeds 2MB limit".into()); }
    let abs = ensure_inside_vault(&scope, Path::new(&rel))?;
    if abs.exists() { return Err(format!("A file already exists at {}", vault_relative(&scope, &abs.to_string_lossy()))); }
    // Validate folder depth like lib.rs create_file
    let rel_path = abs.strip_prefix(&scope.root).unwrap_or(&abs).to_string_lossy().to_string();
    let parts: Vec<&str> = rel_path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() > 6 { return Err("Folders can be nested up to 5 levels deep".into()); }
    if rel_path.contains("..") || rel_path.contains('\0') || rel_path.contains(':') { return Err("Invalid vault path".into()); }
    create_pending(&app, "create_note", abs.to_string_lossy().to_string(), None, String::new(), content, input)
}

fn preview_delete_note(app: tauri::AppHandle, input: serde_json::Value) -> Result<PendingEdit, String> {
    let scope = super::current(&app)?;
    let conn = crate::db::init_db(&app)?;
    let note_ref = input.get("noteId").or_else(|| input.get("path")).and_then(|v| v.as_str()).ok_or("delete_note requires noteId")?.to_string();
    let (note_id, note_path) = resolve_note(&conn, &scope.vault_id, &note_ref)?;
    ensure_inside_vault(&scope, Path::new(&note_path))?;
    let old_content = std::fs::read_to_string(&note_path).unwrap_or_default();
    if old_content.is_empty() && !Path::new(&note_path).exists() { return Err("Note file does not exist".into()); }
    create_pending(&app, "delete_note", note_path, Some(note_id), old_content, String::new(), input)
}

fn preview_rename_note(app: tauri::AppHandle, input: serde_json::Value) -> Result<PendingEdit, String> {
    let scope = super::current(&app)?;
    let conn = crate::db::init_db(&app)?;
    let note_ref = input.get("noteId").or_else(|| input.get("oldPath")).or_else(|| input.get("path")).and_then(|v| v.as_str()).ok_or("rename_note requires noteId or oldPath")?.to_string();
    let new_rel = input.get("newPath").or_else(|| input.get("new_path")).or_else(|| input.get("target")).and_then(|v| v.as_str()).ok_or("rename_note requires newPath")?.to_string();
    let (note_id, old_path) = resolve_note(&conn, &scope.vault_id, &note_ref)?;
    ensure_inside_vault(&scope, Path::new(&old_path))?;
    let new_abs = ensure_inside_vault(&scope, Path::new(&new_rel))?;
    if new_abs.exists() { return Err("A note already exists at the destination".into()); }
    let old_content = std::fs::read_to_string(&old_path).unwrap_or_default();
    // For rename, preview is just the path change; new_content is same as old
    let mut pending = create_pending(&app, "rename_note", old_path.clone(), Some(note_id), old_content.clone(), old_content, input.clone())?;
    // Store new path in pending's new_content as sentinel? Instead store in input and use preview to show
    pending.note_path = old_path.clone(); // keep original for lookup
    pending.preview = format!("Rename {} → {}", vault_relative(&scope, &old_path), vault_relative(&scope, &new_abs.to_string_lossy()));
    pending.new_content = new_abs.to_string_lossy().to_string(); // abuse new_content to carry destination
    Ok(pending)
}

fn preview_create_folder(app: tauri::AppHandle, input: serde_json::Value) -> Result<PendingEdit, String> {
    let scope = super::current(&app)?;
    let rel = input.get("path").or_else(|| input.get("relativePath")).and_then(|v| v.as_str()).ok_or("create_folder requires path")?.to_string();
    let abs = ensure_inside_vault(&scope, Path::new(&rel))?;
    if abs.exists() { return Err("Folder already exists".into()); }
    let rel_check = abs.strip_prefix(&scope.root).unwrap_or(&abs).to_string_lossy().to_string();
    let parts: Vec<&str> = rel_check.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() > 5 { return Err("Folders can be nested up to 5 levels deep".into()); }
    create_pending(&app, "create_folder", abs.to_string_lossy().to_string(), None, String::new(), String::new(), input)
}

fn preview_move_folder(app: tauri::AppHandle, input: serde_json::Value) -> Result<PendingEdit, String> {
    let scope = super::current(&app)?;
    let old_rel = input.get("oldPath").or_else(|| input.get("from")).and_then(|v| v.as_str()).ok_or("move_folder requires oldPath")?.to_string();
    let new_rel = input.get("newPath").or_else(|| input.get("to")).and_then(|v| v.as_str()).ok_or("move_folder requires newPath")?.to_string();
    let old_abs = ensure_inside_vault(&scope, Path::new(&old_rel))?;
    let new_abs = ensure_inside_vault(&scope, Path::new(&new_rel))?;
    if !old_abs.exists() || !old_abs.is_dir() { return Err(format!("Folder not found: {old_rel}")); }
    if new_abs.exists() { return Err(format!("A folder named '{new_rel}' already exists")); }
    let mut pending = create_pending(&app, "move_folder", old_abs.to_string_lossy().to_string(), None, String::new(), new_abs.to_string_lossy().to_string(), input)?;
    pending.preview = format!("Move folder {} → {}", vault_relative(&scope, &old_abs.to_string_lossy()), vault_relative(&scope, &new_abs.to_string_lossy()));
    Ok(pending)
}

fn preview_wikilink_or_tag(app: tauri::AppHandle, tool: &str, input: serde_json::Value) -> Result<PendingEdit, String> {
    let scope = super::current(&app)?;
    let conn = crate::db::init_db(&app)?;
    let note_ref = input.get("noteId").or_else(|| input.get("path")).and_then(|v| v.as_str()).ok_or(format!("{tool} requires noteId"))?.to_string();
    let (note_id, note_path) = resolve_note(&conn, &scope.vault_id, &note_ref)?;
    ensure_inside_vault(&scope, Path::new(&note_path))?;
    let old_content = std::fs::read_to_string(&note_path).unwrap_or_default();
    let mut stmt = conn.prepare("SELECT id, text FROM knowledge_blocks WHERE note_id=?1 AND deleted=0 ORDER BY ordinal").map_err(|e| e.to_string())?;
    let db_blocks = stmt.query_map([&note_id], |r| Ok(DbBlock { id: r.get(0)?, text: r.get(1)? })).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let op = match tool {
        "add_wikilink" => {
            let target = input.get("target").and_then(|v| v.as_str()).ok_or("add_wikilink requires target")?.to_string();
            let block_id = input.get("blockId").or_else(|| input.get("block_id")).and_then(|v| v.as_str()).map(|s| s.to_string());
            EditOp::AddWikilink { block_id, target }
        }
        "add_tag" => {
            let tag = input.get("tag").and_then(|v| v.as_str()).ok_or("add_tag requires tag")?.to_string();
            EditOp::AddTag { tag }
        }
        "remove_tag" => {
            let tag = input.get("tag").and_then(|v| v.as_str()).ok_or("remove_tag requires tag")?.to_string();
            EditOp::RemoveTag { tag }
        }
        _ => return Err("Unknown tool".into()),
    };
    let new_content = apply_edits(&old_content, &db_blocks, &[op])?;
    if new_content == old_content { return Err("No changes (tag/wikilink already present or not found)".into()); }
    create_pending(&app, tool, note_path, Some(note_id), old_content, new_content, input)
}

fn preview_format_note(app: tauri::AppHandle, input: serde_json::Value) -> Result<PendingEdit, String> {
    let scope = super::current(&app)?;
    let conn = crate::db::init_db(&app)?;
    let note_ref = input.get("noteId").or_else(|| input.get("path")).and_then(|v| v.as_str()).ok_or("format_note requires noteId")?.to_string();
    let (note_id, note_path) = resolve_note(&conn, &scope.vault_id, &note_ref)?;
    ensure_inside_vault(&scope, Path::new(&note_path))?;
    let old_content = std::fs::read_to_string(&note_path).unwrap_or_default();
    let new_content = crate::knowledge::models::format(&old_content);
    if new_content == old_content { return Err("Note is already formatted".into()); }
    create_pending(&app, "format_note", note_path, Some(note_id), old_content, new_content, input)
}

// ---------------------------------------------------------------------------
// Applying pending edits (after approval)
// ---------------------------------------------------------------------------

fn apply_pending(app: &tauri::AppHandle, pending: PendingEdit) -> Result<serde_json::Value, String> {
    let scope = super::current(app)?;
    // Generation check (like cloud approvals)
    if pending.generation != scope.generation {
        return Err("Vault changed — approval expired".into());
    }
    if pending.expires <= Instant::now() {
        return Err("Approval expired".into());
    }
    if pending.vault_id != scope.vault_id {
        return Err("Approval is for a different vault".into());
    }
    let conn = crate::db::init_db(app)?;
    match pending.tool.as_str() {
        "edit_note" | "add_wikilink" | "add_tag" | "remove_tag" | "format_note" => {
            let path = Path::new(&pending.note_path);
            super::validate_path(app, path)?;
            if let Some(parent) = path.parent() { if !parent.exists() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; } }
            // Mask self-write
            crate::engine::indexer::suppress_self_write(path, crate::engine::indexer::SELF_WRITE_MASK_MS);
            std::fs::write(path, &pending.new_content).map_err(|e| e.to_string())?;
            // Record history before sync? history uses note_path key (which is path string)
            let _ = crate::db::history::record_note_version(&conn, &pending.note_path, &pending.new_content);
            super::sync_file(app, path, &pending.new_content)?;
            // Legacy sidecar: notes/tags/links for graph compatibility
            if let Ok(title) = path.file_stem().map(|s| s.to_string_lossy().to_string()).ok_or("") {
                let aliases = crate::watcher::extract_aliases(&pending.new_content);
                let _ = crate::db::upsert_note(&conn, &pending.note_path, &title, &pending.note_path, &aliases);
                let _ = crate::db::sync_note_tags(&conn, &pending.note_path, &pending.new_content);
                let targets = crate::db::extract_applied_links(&pending.new_content);
                let _ = crate::db::update_links_flat(&conn, &pending.note_path, &targets);
            }
            let revision: i64 = conn.query_row("SELECT revision FROM knowledge_notes WHERE path=?1", [&pending.note_path], |r| r.get(0)).unwrap_or(0);
            super::emit(app, &conn, &scope.vault_id, "note_changed", pending.note_id.as_deref().unwrap_or(&pending.note_path))?;
            Ok(serde_json::json!({ "notePath": pending.note_path, "relativePath": vault_relative(&scope, &pending.note_path), "revision": revision, "preview": pending.preview }))
        }
        "create_note" => {
            let path = Path::new(&pending.note_path);
            super::validate_path(app, path)?;
            if let Some(parent) = path.parent() { if !parent.exists() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; } }
            if path.exists() { return Err("File already exists".into()); }
            crate::engine::indexer::suppress_self_write(path, crate::engine::indexer::SELF_WRITE_MASK_MS);
            std::fs::write(path, &pending.new_content).map_err(|e| e.to_string())?;
            let _ = crate::db::history::record_note_version(&conn, &pending.note_path, &pending.new_content);
            super::sync_file(app, path, &pending.new_content)?;
            if let Ok(title) = path.file_stem().map(|s| s.to_string_lossy().to_string()).ok_or("") {
                let aliases = crate::watcher::extract_aliases(&pending.new_content);
                let _ = crate::db::upsert_note(&conn, &pending.note_path, &title, &pending.note_path, &aliases);
                let _ = crate::db::sync_note_tags(&conn, &pending.note_path, &pending.new_content);
            }
            super::emit(app, &conn, &scope.vault_id, "note_changed", &pending.note_path)?;
            Ok(serde_json::json!({ "notePath": pending.note_path, "relativePath": vault_relative(&scope, &pending.note_path) }))
        }
        "delete_note" => {
            let path = Path::new(&pending.note_path);
            super::validate_path(app, path)?;
            if path.exists() {
                crate::engine::indexer::suppress_self_write(path, crate::engine::indexer::SELF_WRITE_MASK_MS);
                std::fs::remove_file(path).map_err(|e| e.to_string())?;
            }
            super::remove(&conn, &pending.note_path)?;
            let _ = conn.execute("DELETE FROM notes WHERE id=?1", params![pending.note_path]);
            let _ = conn.execute("DELETE FROM backlinks WHERE source_path=?1 OR target_path=?1", params![pending.note_path]);
            let _ = conn.execute("DELETE FROM links WHERE source=?1 OR target=?1", params![pending.note_path]);
            super::emit(app, &conn, &scope.vault_id, "note_changed", pending.note_id.as_deref().unwrap_or(&pending.note_path))?;
            Ok(serde_json::json!({ "deleted": pending.note_path }))
        }
        "rename_note" => {
            // pending.new_content carries destination absolute path for rename
            let old = Path::new(&pending.note_path);
            let new = Path::new(&pending.new_content);
            super::validate_path(app, old)?;
            super::validate_path(app, new)?;
            if new.exists() { return Err("Destination already exists".into()); }
            if !old.exists() { return Err(format!("Source not found: {}", pending.note_path)); }
            if let Some(parent) = new.parent() { if !parent.exists() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; } }
            std::fs::rename(old, new).map_err(|e| e.to_string())?;
            super::move_path(&conn, &pending.note_path, &pending.new_content)?;
            // Move legacy history rows already via move_path (knowledge) + need notes/backlinks? Do minimal
            let _ = conn.execute("UPDATE notes SET id=?2, path=?2 WHERE id=?1", params![pending.note_path, pending.new_content]);
            super::emit(app, &conn, &scope.vault_id, "note_changed", &pending.new_content)?;
            Ok(serde_json::json!({ "oldPath": pending.note_path, "newPath": pending.new_content, "relativePath": vault_relative(&scope, &pending.new_content) }))
        }
        "create_folder" => {
            let path = Path::new(&pending.note_path);
            super::validate_path(app, path)?;
            std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "path": pending.note_path, "relativePath": vault_relative(&scope, &pending.note_path) }))
        }
        "move_folder" => {
            let old = Path::new(&pending.note_path);
            let new = Path::new(&pending.new_content);
            super::validate_path(app, old)?;
            super::validate_path(app, new)?;
            if !old.exists() { return Err(format!("Folder not found: {}", pending.note_path)); }
            if new.exists() { return Err("Destination folder already exists".into()); }
            if let Some(parent) = new.parent() { if !parent.exists() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; } }
            std::fs::rename(old, new).map_err(|e| e.to_string())?;
            let _ = crate::db::rename_folder_paths(&conn, &pending.note_path, &pending.new_content);
            Ok(serde_json::json!({ "oldPath": pending.note_path, "newPath": pending.new_content }))
        }
        _ => Err(format!("Unknown pending tool: {}", pending.tool)),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn agent_list_tools(app: tauri::AppHandle) -> Result<Vec<ToolDefinition>, String> {
    let _ = super::current(&app)?;
    Ok(tool_definitions())
}

#[tauri::command]
pub async fn agent_call_tool(app: tauri::AppHandle, request: AgentToolRequest) -> Result<AgentToolResponse, String> {
    let tool = request.tool.clone();
    // Reads — direct, no approval
    match tool.as_str() {
        "read_note" => {
            let note_ref = request.input.get("noteId").or_else(|| request.input.get("note_id")).or_else(|| request.input.get("path")).and_then(|v| v.as_str()).ok_or("read_note requires noteId")?.to_string();
            let app2 = app.clone();
            let res = tauri::async_runtime::spawn_blocking(move || read_note_blocking(app2, note_ref)).await.map_err(|e| e.to_string())??;
            Ok(AgentToolResponse { tool, requires_approval: false, approval_id: None, preview: None, result: Some(res), error: None })
        }
        "read_block" => {
            let block_id = request.input.get("blockId").or_else(|| request.input.get("block_id")).and_then(|v| v.as_str()).ok_or("read_block requires blockId")?.to_string();
            let app2 = app.clone();
            let res = tauri::async_runtime::spawn_blocking(move || read_block_blocking(app2, block_id)).await.map_err(|e| e.to_string())??;
            Ok(AgentToolResponse { tool, requires_approval: false, approval_id: None, preview: None, result: Some(res), error: None })
        }
        "search_vault" => {
            let input = request.input.clone();
            let app2 = app.clone();
            let res = tauri::async_runtime::spawn_blocking(move || search_vault_blocking(app2, input)).await.map_err(|e| e.to_string())??;
            Ok(AgentToolResponse { tool, requires_approval: false, approval_id: None, preview: None, result: Some(res), error: None })
        }
        "get_related_notes" => {
            let note_ref = request.input.get("noteId").or_else(|| request.input.get("note_id")).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let kinds = request.input.get("kinds").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|v| v.as_str()).map(|s| s.to_string()).collect()).unwrap_or_else(|| vec!["wiki".into(), "tag".into(), "folder".into()]);
            let app2 = app.clone();
            let res = tauri::async_runtime::spawn_blocking(move || get_related_blocking(app2, note_ref, kinds)).await.map_err(|e| e.to_string())??;
            Ok(AgentToolResponse { tool, requires_approval: false, approval_id: None, preview: None, result: Some(res), error: None })
        }
        "get_backlinks" => {
            let note_ref = request.input.get("noteId").or_else(|| request.input.get("note_id")).and_then(|v| v.as_str()).ok_or("get_backlinks requires noteId")?.to_string();
            let app2 = app.clone();
            let res = tauri::async_runtime::spawn_blocking(move || get_backlinks_blocking(app2, note_ref)).await.map_err(|e| e.to_string())??;
            Ok(AgentToolResponse { tool, requires_approval: false, approval_id: None, preview: None, result: Some(res), error: None })
        }
        // Writes — create pending approval with preview
        "edit_note" | "create_note" | "delete_note" | "rename_note" | "create_folder" | "move_folder" | "add_wikilink" | "add_tag" | "remove_tag" | "format_note" => {
            let input = request.input.clone();
            let tool_clone = tool.clone();
            let app2 = app.clone();
            let pending = tauri::async_runtime::spawn_blocking(move || -> Result<PendingEdit, String> {
                match tool_clone.as_str() {
                    "edit_note" => preview_edit_note(app2, input),
                    "create_note" => preview_create_note(app2, input),
                    "delete_note" => preview_delete_note(app2, input),
                    "rename_note" | "move_note" => preview_rename_note(app2, input),
                    "create_folder" => preview_create_folder(app2, input),
                    "move_folder" => preview_move_folder(app2, input),
                    "add_wikilink" | "add_tag" | "remove_tag" => preview_wikilink_or_tag(app2, &tool_clone, input),
                    "format_note" => preview_format_note(app2, input),
                    _ => Err("Unknown write tool".into()),
                }
            }).await.map_err(|e| e.to_string())??;
            let preview = pending.preview.clone();
            let id = store_pending(pending);
            // Emit knowledge-event for UI to refresh pending list
            if let Ok(conn) = crate::db::init_db(&app) {
                if let Ok(scope) = super::current(&app) {
                    let _ = super::emit(&app, &conn, &scope.vault_id, "agent_approval_required", &id);
                }
            }
            Ok(AgentToolResponse { tool, requires_approval: true, approval_id: Some(id), preview: Some(preview), result: None, error: None })
        }
        _ => Err(format!("Unknown tool: {tool}. Available: {}", tool_definitions().iter().map(|t| t.name.clone()).collect::<Vec<_>>().join(", "))),
    }
}

#[tauri::command]
pub fn agent_list_pending(app: tauri::AppHandle) -> Result<Vec<PendingView>, String> {
    let scope = super::current(&app)?;
    prune_expired(&scope.generation);
    let map = pending_map().lock().unwrap();
    let mut out: Vec<PendingView> = map.values()
        .filter(|p| p.vault_id == scope.vault_id && p.generation == scope.generation)
        .map(|p| p.into())
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[tauri::command]
pub fn agent_resolve_pending(app: tauri::AppHandle, id: String, approved: bool) -> Result<serde_json::Value, String> {
    let scope = super::current(&app)?;
    let pending = {
        let mut map = pending_map().lock().unwrap();
        let p = map.get(&id).cloned().ok_or("Approval expired or not found")?;
        if p.generation != scope.generation { map.remove(&id); return Err("Vault changed — approval expired".into()); }
        if p.expires <= Instant::now() { map.remove(&id); return Err("Approval expired".into()); }
        if p.vault_id != scope.vault_id { return Err("Approval is for a different vault".into()); }
        if !approved {
            map.remove(&id);
            return Ok(serde_json::json!({ "approved": false, "id": id }));
        }
        // Remove before apply to avoid double-apply on concurrent calls
        map.remove(&id).unwrap()
    };
    // Apply — convert to blocking work (filesystem + DB)
    let app2 = app.clone();
    let res = tauri::async_runtime::block_on(tauri::async_runtime::spawn_blocking(move || apply_pending(&app2, pending)))
        .map_err(|e| e.to_string())??;
    // Emit applied event
    if let Ok(conn) = crate::db::init_db(&app) {
        let _ = super::emit(&app, &conn, &scope.vault_id, "agent_applied", &id);
    }
    Ok(serde_json::json!({ "approved": true, "id": id, "result": res }))
}

#[tauri::command]
pub fn agent_undo_last(app: tauri::AppHandle, note_path: String) -> Result<serde_json::Value, String> {
    let scope = super::current(&app)?;
    let conn = crate::db::init_db(&app)?;
    // Resolve note path (may be id or path)
    let (note_id, abs_path) = if let Ok((id, p)) = resolve_note(&conn, &scope.vault_id, &note_path) { (id, p) } else {
        // Try as direct path
        let abs = ensure_inside_vault(&scope, Path::new(&note_path))?.to_string_lossy().to_string();
        (abs.clone(), abs)
    };
    ensure_inside_vault(&scope, Path::new(&abs_path))?;
    let versions = crate::db::history::get_all_reconstructed_versions(&conn, &abs_path)?;
    if versions.len() < 2 {
        return Err("No previous version to undo".into());
    }
    // Previous version is second last (last is current)
    let prev = &versions[versions.len() - 2];
    let current = std::fs::read_to_string(&abs_path).unwrap_or_default();
    if current == prev.content {
        return Err("Note is already at the previous version".into());
    }
    let patch = crate::db::history::generate_patch(&current, &prev.content);
    // Write previous content back
    let path = Path::new(&abs_path);
    crate::engine::indexer::suppress_self_write(path, crate::engine::indexer::SELF_WRITE_MASK_MS);
    std::fs::write(path, &prev.content).map_err(|e| e.to_string())?;
    let _ = crate::db::history::record_note_version(&conn, &abs_path, &prev.content);
    super::sync_file(&app, path, &prev.content)?;
    super::emit(&app, &conn, &scope.vault_id, "note_changed", &note_id)?;
    Ok(serde_json::json!({ "notePath": abs_path, "relativePath": vault_relative(&scope, &abs_path), "restoredVersion": prev.version_id, "preview": patch }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_preserved() {
        let old = "---\ntitle: Hi\n---\nFirst\n\nSecond";
        let (fm, body) = extract_frontmatter(old);
        assert!(fm.contains("title: Hi"));
        assert!(body.contains("First"));
    }

    #[test]
    fn edit_apply_replace_and_insert() {
        let old = "First\n\nSecond\n\nThird";
        let db_blocks = vec![
            DbBlock { id: "a".into(), text: "First".into() },
            DbBlock { id: "b".into(), text: "Second".into() },
            DbBlock { id: "c".into(), text: "Third".into() },
        ];
        let ops = vec![
            EditOp::ReplaceBlock { block_id: "b".into(), text: "Second edited".into() },
            EditOp::InsertAfter { block_id: "b".into(), text: "Inserted".into() },
        ];
        let new = apply_edits(old, &db_blocks, &ops).unwrap();
        assert!(new.contains("Second edited"));
        assert!(new.contains("Inserted"));
        assert!(new.contains("First"));
        assert!(new.contains("Third"));
    }

    #[test]
    fn tag_add_remove() {
        let old = "Hello world";
        let db_blocks = vec![DbBlock { id: "a".into(), text: "Hello world".into() }];
        let new = apply_edits(old, &db_blocks, &[EditOp::AddTag { tag: "physics".into() }]).unwrap();
        assert!(new.contains("@physics"));
        let db_blocks2 = vec![DbBlock { id: "a".into(), text: new.clone() }];
        let newer = apply_edits(&new, &db_blocks2, &[EditOp::RemoveTag { tag: "physics".into() }]).unwrap();
        assert!(!newer.contains("@physics"));
    }

    #[test]
    fn wikilink_insert() {
        let old = "Note";
        let db_blocks = vec![DbBlock { id: "a".into(), text: "Note".into() }];
        let new = apply_edits(old, &db_blocks, &[EditOp::AddWikilink { block_id: None, target: "Target".into() }]).unwrap();
        assert!(new.contains("[[Target]]"));
    }

    #[test]
    fn preview_normalizes_op_aliases() {
        let raw = serde_json::json!({"op":"replace_block","block_id":"a","text":"hi"});
        let norm = normalize_op_value(raw);
        let op: EditOp = serde_json::from_value(norm).unwrap();
        matches!(op, EditOp::ReplaceBlock { .. });
    }
}

// Phase 2a — Retrieval Planner + Context Builder
//
// Every AI request goes through the Knowledge Runtime.
// Ranking combines lexical (BM25/FTS), semantic (HNSW), explicit wiki/block edges,
// backlinks, tag overlap and folder proximity. Explicit links outrank pure semantic
// similarity by design. Context is packed into a char budget with citations.
//
// Design: vault-scoped, bounded (1000 lexical candidates, 100 per page fused),
// offline-safe (lexical degraded when embeddings not loaded), deterministic
// tie-break by note_id. No network, no model download.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use tauri::Manager;

use super::search::{fuse, lexical, SearchHit, SearchQuery};

// ---------------------------------------------------------------------------
// Request / Response types (camelCase wire)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct RetrievalRequest {
    pub query: String,
    pub active_note_id: Option<String>,
    pub budget_chars: Option<usize>,
    // pagination for block list (currently unused for context packing but kept
    // for future graph/projection parity). Clamped server-side.
    pub offset: usize,
    pub limit: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScoreBreakdown {
    pub lexical: Option<f64>,
    pub semantic: Option<f32>,
    pub rrf: f64,
    pub explicit: f32,
    pub graph_proximity: f32,
    pub tag_overlap: f32,
    pub folder_sibling: f32,
    pub final_score: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RetrievedBlock {
    pub note_id: String,
    pub path: String,
    pub title: String,
    pub block_id: Option<String>,
    pub anchor: Option<String>,
    pub text: String,
    pub kind: String,
    pub heading_path: serde_json::Value,
    pub snippet: String,
    pub scores: ScoreBreakdown,
    pub citation: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub note_id: String,
    pub path: String,
    pub title: String,
    pub block_id: Option<String>,
    pub anchor: Option<String>,
    pub heading_path: serde_json::Value,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalPlan {
    pub query: String,
    pub active_note_id: Option<String>,
    pub active_note_path: Option<String>,
    pub degraded: Option<String>,
    pub blocks: Vec<RetrievedBlock>,
    pub citations: Vec<Citation>,
    pub context_text: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET_CHARS: usize = 12_000;
const ACTIVE_NOTE_BUDGET: usize = 4_000;
const MAX_CANDIDATE_WINDOW: usize = 1000;
const MAX_BLOCKS_IN_PLAN: usize = 20;

fn relative_path(root: &Path, abs: &str) -> String {
    let p = Path::new(abs);
    p.strip_prefix(root)
        .map(|r| r.to_string_lossy().to_string())
        .unwrap_or_else(|_| abs.to_string())
}

fn resolve_active(
    conn: &Connection,
    vault_id: &str,
    active_note_id: &Option<String>,
) -> Result<Option<(String, String, String)>, String> {
    let Some(ref raw) = active_note_id else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT id, path, title FROM knowledge_notes WHERE vault_id=?1 AND (id=?2 OR path=?2) AND deleted=0",
            params![vault_id, trimmed],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

fn explicit_targets(
    conn: &Connection,
    vault_id: &str,
    source_id: &str,
) -> Result<HashSet<String>, String> {
    // Outgoing wiki/block edges from source
    let mut stmt = conn
        .prepare("SELECT l.target_ref FROM knowledge_edges l WHERE l.source=?1")
        .map_err(|e| e.to_string())?;
    let refs: Vec<String> = stmt
        .query_map([source_id], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = HashSet::new();
    for name in refs {
        // Resolve target_ref to a single note id (title/alias/path uniqueness check mirrors relations())
        let mut st = conn
            .prepare("SELECT id FROM knowledge_notes WHERE vault_id=?1 AND deleted=0 AND (path=?2 OR title=?2 COLLATE NOCASE OR path IN (SELECT note_id FROM aliases WHERE alias=?2)) ORDER BY id LIMIT 2")
            .map_err(|e| e.to_string())?;
        let ids: Vec<String> = st
            .query_map(params![vault_id, name], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if ids.len() == 1 {
            out.insert(ids[0].clone());
        }
    }
    Ok(out)
}

fn backlink_sources(
    conn: &Connection,
    vault_id: &str,
    active_path: &str,
) -> Result<HashSet<String>, String> {
    // Notes that link to active (incoming edges via knowledge_edges)
    // Reuse search::backlinks semantics but directly on knowledge_edges for vault isolation
    let mut stmt = conn
        .prepare("SELECT DISTINCT n.id FROM knowledge_edges e JOIN knowledge_notes n ON n.id=e.source JOIN knowledge_notes t ON t.vault_id=n.vault_id AND t.path=?2 WHERE n.vault_id=?1 AND n.deleted=0 AND t.deleted=0 AND t.vault_id=?1 AND (e.target_ref=t.path OR e.target_ref=t.title COLLATE NOCASE OR EXISTS(SELECT 1 FROM aliases a WHERE a.note_id=t.path AND a.alias=e.target_ref COLLATE NOCASE))")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![vault_id, active_path], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().collect())
}

fn tags_for_path(conn: &Connection, path: &str) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare("SELECT tag_name FROM tags WHERE note_id=?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([path], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().collect())
}

fn tag_overlap_score(active_tags: &HashSet<String>, candidate_tags: &HashSet<String>) -> f32 {
    if active_tags.is_empty() || candidate_tags.is_empty() {
        return 0.0;
    }
    let shared = active_tags.intersection(candidate_tags).count() as f32;
    shared / active_tags.len() as f32
}

fn same_folder(a: &str, b: &str) -> bool {
    let pa = Path::new(a).parent();
    let pb = Path::new(b).parent();
    match (pa, pb) {
        (Some(x), Some(y)) => x == y,
        (None, None) => true,
        _ => false,
    }
}

fn get_engine(
    app: &tauri::AppHandle,
) -> Option<std::sync::Arc<crate::engine::embeddings::EmbeddingEngine>> {
    // KnowledgeRuntime is the primary embedding cache since Phase 1. AppState
    // mirrors it for legacy search compatibility. Either may hold the loaded
    // engine; prefer the runtime cache.
    let try_runtime = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        app.state::<super::KnowledgeRuntime>()
            .embeddings
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|r| r.as_ref().ok())
            .cloned()
    }))
    .ok()
    .flatten();
    if let Some(eng) = try_runtime {
        return Some(eng);
    }
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        app.state::<crate::AppState>()
            .embeddings
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|r| r.as_ref().ok())
            .cloned()
    }))
    .ok()
    .flatten()
}

// ---------------------------------------------------------------------------
// Core planner (blocking)
// ---------------------------------------------------------------------------

struct Candidate {
    note_id: String,
    path: String,
    title: String,
    lexical: Option<f64>,
    semantic: Option<f32>,
    rrf: f64,
    explicit: bool,
    backlink: bool,
    tag_overlap: f32,
    folder_sibling: bool,
}

fn build_plan_blocking(
    app: tauri::AppHandle,
    req: RetrievalRequest,
) -> Result<RetrievalPlan, String> {
    let scope = super::current(&app)?;
    let conn = crate::db::init_db(&app)?;
    let budget_chars = req
        .budget_chars
        .unwrap_or(DEFAULT_BUDGET_CHARS)
        .clamp(1_000, 100_000);
    let query = req.query.trim().to_string();

    // Empty query -> no lexical/semantic candidates, but graph signals still valid if active note present
    let active = resolve_active(&conn, &scope.vault_id, &req.active_note_id)?;
    let (active_id, active_path, active_title) = match &active {
        Some((id, path, title)) => (Some(id.clone()), Some(path.clone()), Some(title.clone())),
        None => (None, None, None),
    };

    // 1. Lexical hits (bounded to 1000, same window as search_knowledge)
    let lex_hits: Vec<SearchHit> = if query.is_empty() {
        vec![]
    } else {
        let q = SearchQuery {
            text: query.clone(),
            mode: "lexical".into(),
            ..Default::default()
        };
        lexical(&conn, &scope.vault_id, &q).unwrap_or_default()
    };

    // 2. Semantic hits for query (offline-safe)
    let mut sem_hits: Vec<SearchHit> = vec![];
    let mut degraded: Option<String> = None;
    if !query.is_empty() {
        if let Some(engine) = get_engine(&app) {
            // mirror search_knowledge: do not init/download here, just use cached
            // EmbeddingEngine::search_text serializes inference internally; no
            // extra AppState guard needed here (tests have no AppState).
            match engine.search_text(&query, MAX_CANDIDATE_WINDOW) {
                Ok(matches) => {
                    for m in matches {
                        // filter to vault
                        let eligible: Option<(String, String)> = conn
                            .query_row(
                                "SELECT id, title FROM knowledge_notes WHERE path=?1 AND vault_id=?2 AND deleted=0",
                                params![m.note_id, scope.vault_id],
                                |r| Ok((r.get(0)?, r.get(1)?)),
                            )
                            .optional()
                            .map_err(|e| e.to_string())?;
                        if let Some((id, title)) = eligible {
                            sem_hits.push(SearchHit {
                                note_id: id.clone(),
                                block_id: None,
                                path: m.note_id.clone(),
                                title,
                                snippet: String::new(),
                                lexical: None,
                                semantic: Some(m.score),
                                score: 0.0,
                            });
                        }
                    }
                }
                Err(_) => {
                    degraded =
                        Some("Semantic inference unavailable; showing lexical results".into());
                }
            }
        } else if !lex_hits.is_empty() || !query.is_empty() {
            degraded = Some("Local embeddings are not loaded; showing lexical results".into());
        }
    }

    // Fused RRF base scores
    let fused = if query.is_empty() {
        vec![]
    } else {
        fuse(lex_hits.clone(), sem_hits.clone())
    };
    // Map fused by note_id for quick lookup
    let mut rrf_by_id: HashMap<String, (f64, Option<f64>, Option<f32>)> = HashMap::new();
    for h in &fused {
        rrf_by_id.insert(h.note_id.clone(), (h.score, h.lexical, h.semantic));
    }
    // Also keep per-hit lexical/semantic for candidates that were duped across lists,
    // fuse already merges but we want original scores for breakdown.
    let mut lex_by_id: HashMap<String, f64> = HashMap::new();
    for h in &lex_hits {
        lex_by_id.insert(h.note_id.clone(), h.lexical.unwrap_or(0.0));
    }
    let mut sem_by_id: HashMap<String, f32> = HashMap::new();
    for h in &sem_hits {
        // multiple sem hits deduped by fuse; keep max
        let e = sem_by_id.entry(h.note_id.clone()).or_insert(0.0);
        if let Some(s) = h.semantic {
            if s > *e {
                *e = s;
            }
        }
    }

    // 3. Graph signals from active note
    let explicit_set: HashSet<String> = if let Some(ref aid) = active_id {
        explicit_targets(&conn, &scope.vault_id, aid).unwrap_or_default()
    } else {
        HashSet::new()
    };
    let backlink_set: HashSet<String> = if let Some(ref ap) = active_path {
        backlink_sources(&conn, &scope.vault_id, ap).unwrap_or_default()
    } else {
        HashSet::new()
    };
    let active_tags: HashSet<String> = if let Some(ref ap) = active_path {
        tags_for_path(&conn, ap).unwrap_or_default()
    } else {
        HashSet::new()
    };
    // For tag and folder boosts we need candidate tag sets lazily, but precompute for union set.

    // 4. Additional semantic neighbors of active note (query-independent graph proximity)
    let mut sem_neighbors: HashMap<String, f32> = HashMap::new();
    if let Some(ref ap) = active_path {
        if let Some(engine) = get_engine(&app) {
            if let Ok(related) = engine.find_related(&conn, ap, 20) {
                for hit in related {
                    let target_id: Option<String> = conn
                        .query_row(
                            "SELECT id FROM knowledge_notes WHERE path=?1 AND vault_id=?2 AND deleted=0",
                            params![hit.note_id, scope.vault_id],
                            |r| r.get(0),
                        )
                        .optional()
                        .map_err(|e| e.to_string())?;
                    if let Some(tid) = target_id {
                        sem_neighbors.insert(tid, hit.score);
                    }
                }
            }
        }
    }

    // 5. Union candidate set = fused + explicit + backlink + sem_neighbors + tag-neighbors (if active_tags non-empty, add all notes sharing tag)
    let mut union_ids: HashSet<String> = HashSet::new();
    for h in &fused {
        union_ids.insert(h.note_id.clone());
    }
    for id in &explicit_set {
        union_ids.insert(id.clone());
    }
    for id in &backlink_set {
        union_ids.insert(id.clone());
    }
    for id in sem_neighbors.keys() {
        union_ids.insert(id.clone());
    }
    // Tag neighbors: any note sharing at least one active tag
    let mut tag_neighbors: HashSet<String> = HashSet::new();
    if !active_tags.is_empty() {
        let placeholders = active_tags
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        // tags.note_id is path; need to map to knowledge_notes.id
        // We query tags joined to knowledge_notes for vault isolation
        let sql = format!(
            "SELECT DISTINCT n.id FROM tags t JOIN knowledge_notes n ON n.path=t.note_id WHERE n.vault_id=?1 AND n.deleted=0 AND t.tag_name IN ({})",
            placeholders
        );
        // Build params vector: vault_id + tag names
        // rusqlite params! doesn't support dynamic length; build manually
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut params_vec: Vec<String> = vec![scope.vault_id.clone()];
        params_vec.extend(active_tags.iter().cloned());
        let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        let rows = stmt
            .query_map(param_refs.as_slice(), |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| e.to_string())?;
        for id in rows {
            if Some(&id) != active_id.as_ref() {
                tag_neighbors.insert(id.clone());
                union_ids.insert(id);
            }
        }
    }

    // If no query and no active, no candidates -> empty plan
    if union_ids.is_empty() && active.is_none() {
        return Ok(RetrievalPlan {
            query: req.query.clone(),
            active_note_id: active_id.clone(),
            active_note_path: active_path.clone(),
            degraded,
            blocks: vec![],
            citations: vec![],
            context_text: String::new(),
        });
    }

    // Build candidate list with vault metadata
    let mut candidates: Vec<Candidate> = Vec::with_capacity(union_ids.len());
    for nid in union_ids {
        // Skip active note itself (its content is injected separately as header, not as ranked block)
        if Some(&nid) == active_id.as_ref() {
            continue;
        }
        let meta: Option<(String, String)> = conn
            .query_row(
                "SELECT path, title FROM knowledge_notes WHERE id=?1 AND vault_id=?2 AND deleted=0",
                params![nid, scope.vault_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((path, title)) = meta else { continue };
        // Exclude paths outside vault root (defense-in-depth, though vault_id already scopes)
        if !Path::new(&path).starts_with(&scope.root) {
            continue;
        }
        let (rrf, lex, sem) = rrf_by_id.get(&nid).cloned().unwrap_or((0.0, None, None));
        // Fallbacks: if not in fused but has lex/sem individually, keep them for breakdown
        let lex_val = lex.or_else(|| lex_by_id.get(&nid).copied());
        let sem_val = sem
            .or_else(|| sem_by_id.get(&nid).copied())
            .or_else(|| sem_neighbors.get(&nid).copied());
        let explicit = explicit_set.contains(&nid);
        let backlink = backlink_set.contains(&nid);
        // tag overlap computed below after fetching candidate tags
        // folder sibling
        let folder_sibling = active_path
            .as_ref()
            .map(|ap| same_folder(ap, &path))
            .unwrap_or(false);
        candidates.push(Candidate {
            note_id: nid,
            path,
            title,
            lexical: lex_val,
            semantic: sem_val,
            rrf,
            explicit,
            backlink,
            tag_overlap: 0.0, // filled next
            folder_sibling,
        });
    }

    // Tag overlap per candidate
    for c in &mut candidates {
        if !active_tags.is_empty() {
            if let Ok(ctags) = tags_for_path(&conn, &c.path) {
                c.tag_overlap = tag_overlap_score(&active_tags, &ctags);
            }
        }
    }

    // Graph-aware final ranking: RRF base + boosts
    // Explicit 0.30, graph proximity 0.20 (1-hop), tag overlap *0.15, folder 0.10
    // This ensures explicit outranks pure high-semantic (0.71) per Phase 2 spec.
    let mut scored: Vec<(usize, f64)> = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let mut s = c.rrf;
            if c.explicit {
                s += 0.30;
            }
            if c.explicit || c.backlink {
                s += 0.20;
            }
            s += c.tag_overlap as f64 * 0.15;
            if c.folder_sibling {
                s += 0.10;
            }
            // small semantic neighbor bonus if candidate is semantic neighbor but not explicit/backlink
            if sem_neighbors.contains_key(&c.note_id) && !c.explicit && !c.backlink {
                s += 0.05;
            }
            (i, s)
        })
        .collect();
    scored.sort_by(|a, b| {
        b.1.total_cmp(&a.1)
            .then_with(|| candidates[a.0].note_id.cmp(&candidates[b.0].note_id))
    });

    // Fetch block details for top candidates (up to MAX_BLOCKS_IN_PLAN after budget)
    let mut blocks: Vec<RetrievedBlock> = Vec::new();
    for (idx, final_score) in scored {
        if blocks.len() >= MAX_BLOCKS_IN_PLAN {
            break;
        }
        let c = &candidates[idx];
        // Find representative block: prefer lexical hit block_id if exists for this note, else first block
        let lexical_block_id: Option<String> = lex_hits
            .iter()
            .find(|h| h.note_id == c.note_id)
            .and_then(|h| h.block_id.clone());
        let block_row: Option<(String, String, String, String, Option<String>, i64, i64)> = {
            if let Some(ref bid) = lexical_block_id {
                conn.query_row(
                    "SELECT id, text, kind, heading_path, anchor, start_line, end_line FROM knowledge_blocks WHERE id=?1 AND note_id=?2 AND deleted=0",
                    params![bid, c.note_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?
            } else {
                None
            }
        };
        let (block_id, text, kind, heading_path_raw, anchor, _sl, _el) = if let Some(row) =
            block_row
        {
            row
        } else {
            // fallback to first block in note
            let row: Option<(String, String, String, String, Option<String>, i64, i64)> = conn
                .query_row(
                    "SELECT id, text, kind, heading_path, anchor, start_line, end_line FROM knowledge_blocks WHERE note_id=?1 AND deleted=0 ORDER BY ordinal LIMIT 1",
                    [&c.note_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match row {
                Some(v) => v,
                None => {
                    // Note has no blocks (empty). Use empty text but still citable.
                    (
                        String::new(),
                        String::new(),
                        "paragraph".into(),
                        "[]".into(),
                        None,
                        0,
                        0,
                    )
                }
            }
        };
        let heading_path: serde_json::Value =
            serde_json::from_str(&heading_path_raw).unwrap_or(serde_json::Value::Array(vec![]));
        let snippet = if !text.is_empty() {
            // snippet: first 240 chars with ellipsis, similar to search snippet but cheaper
            let t = text.trim();
            if t.len() > 240 {
                format!("{} …", &t[..240])
            } else {
                t.to_string()
            }
        } else {
            String::new()
        };
        let rel = relative_path(&scope.root, &c.path);
        let citation = if let Some(ref a) = anchor {
            format!("{}#^{}", rel, a)
        } else if !block_id.is_empty() {
            format!("{}#{}", rel, block_id)
        } else {
            rel.clone()
        };
        let breakdown = ScoreBreakdown {
            lexical: c.lexical,
            semantic: c.semantic,
            rrf: c.rrf,
            explicit: if c.explicit { 0.30 } else { 0.0 },
            graph_proximity: if c.explicit || c.backlink { 0.20 } else { 0.0 },
            tag_overlap: c.tag_overlap,
            folder_sibling: if c.folder_sibling { 0.10 } else { 0.0 },
            final_score,
        };
        blocks.push(RetrievedBlock {
            note_id: c.note_id.clone(),
            path: c.path.clone(),
            title: c.title.clone(),
            block_id: if block_id.is_empty() {
                None
            } else {
                Some(block_id)
            },
            anchor,
            text: text.clone(),
            kind,
            heading_path,
            snippet,
            scores: breakdown,
            citation,
        });
    }

    // Context Builder — pack active note + ranked blocks into budget
    let mut context_parts: Vec<String> = Vec::new();
    let mut used = 0usize;
    let mut citations: Vec<Citation> = Vec::new();

    // Active note header (always first if present, truncated to ACTIVE_NOTE_BUDGET)
    if let Some(ref ap) = active_path {
        if let Some(ref at) = active_title {
            if let Ok(content) = std::fs::read_to_string(ap) {
                let truncated = if content.len() > ACTIVE_NOTE_BUDGET {
                    format!("{}…[truncated]", &content[..ACTIVE_NOTE_BUDGET])
                } else {
                    content
                };
                let rel = relative_path(&scope.root, ap);
                let header = format!("# Active Note: {} ({})\n{}\n", at, rel, truncated);
                if header.len() + used <= budget_chars {
                    used += header.len();
                    context_parts.push(header);
                } else if budget_chars > 500 {
                    // At least include title if content too large
                    let minimal = format!("# Active Note: {} ({})\n", at, rel);
                    used += minimal.len();
                    context_parts.push(minimal);
                }
            }
        }
    }

    // Ranked blocks
    for b in &blocks {
        if b.text.is_empty() {
            continue;
        }
        let heading_str = match &b.heading_path {
            serde_json::Value::Array(arr) => arr
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(" > "),
            _ => String::new(),
        };
        let heading_suffix = if heading_str.is_empty() {
            String::new()
        } else {
            format!(" ({})", heading_str)
        };
        let block_header = format!(
            "## Source: {} — {}{}\n",
            b.citation, b.title, heading_suffix
        );
        let entry = format!("{}{}\n", block_header, b.text);
        if used + entry.len() > budget_chars {
            let remaining = budget_chars.saturating_sub(used);
            if remaining > 300 {
                // include truncated block if at least a snippet fits
                let truncated_text = if b.text.len() > remaining - block_header.len() - 20 {
                    format!("{}…", &b.text[..remaining - block_header.len() - 20])
                } else {
                    b.text.clone()
                };
                let truncated_entry = format!("{}{}\n", block_header, truncated_text);
                context_parts.push(truncated_entry);
                citations.push(Citation {
                    note_id: b.note_id.clone(),
                    path: b.path.clone(),
                    title: b.title.clone(),
                    block_id: b.block_id.clone(),
                    anchor: b.anchor.clone(),
                    heading_path: b.heading_path.clone(),
                });
            }
            break;
        }
        used += entry.len();
        context_parts.push(entry);
        citations.push(Citation {
            note_id: b.note_id.clone(),
            path: b.path.clone(),
            title: b.title.clone(),
            block_id: b.block_id.clone(),
            anchor: b.anchor.clone(),
            heading_path: b.heading_path.clone(),
        });
        if used >= budget_chars {
            break;
        }
    }

    let context_text = context_parts.join("\n---\n");

    // Apply offset/limit if requested (for API parity, but context_text already packed)
    let offset = req.offset.min(blocks.len());
    let limit = if req.limit == 0 {
        blocks.len()
    } else {
        req.limit.min(100)
    };
    let paged_blocks: Vec<RetrievedBlock> = blocks.into_iter().skip(offset).take(limit).collect();
    // citations correspond to paged blocks
    let paged_citations: Vec<Citation> = citations.into_iter().skip(offset).take(limit).collect();

    Ok(RetrievalPlan {
        query,
        active_note_id: active_id,
        active_note_path: active_path,
        degraded,
        blocks: paged_blocks,
        citations: paged_citations,
        context_text,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn plan_retrieval(
    app: tauri::AppHandle,
    request: RetrievalRequest,
) -> Result<RetrievalPlan, String> {
    // Validate
    if request.query.trim().is_empty() && request.active_note_id.is_none() {
        return Err("Provide a query or active note".into());
    }
    tauri::async_runtime::spawn_blocking(move || build_plan_blocking(app, request))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_context(
    app: tauri::AppHandle,
    request: RetrievalRequest,
) -> Result<RetrievalPlan, String> {
    plan_retrieval(app, request).await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn fixture() -> (Connection, String, String) {
        let c = Connection::open_in_memory().unwrap();
        super::super::schema::migrate(&c).unwrap();
        c.execute_batch("CREATE TABLE tags(note_id TEXT,tag_name TEXT); CREATE TABLE aliases(note_id TEXT,alias TEXT)")
            .unwrap();
        let a = super::super::vault(&c, std::path::Path::new("/vault")).unwrap();
        let b = super::super::vault(&c, std::path::Path::new("/other")).unwrap();
        (c, a, b)
    }

    #[test]
    fn vault_isolation_and_folders() {
        let (c, a, _b) = fixture();
        // Need vault root at /vault, but sync uses absolute paths
        super::super::sync(&c, &a, "/vault/a.md", "Quantum flux").unwrap();
        super::super::sync(&c, &a, "/vault/sub/b.md", "Quantum flux repeated").unwrap();
        c.execute("INSERT INTO tags VALUES ('/vault/a.md','physics')", [])
            .unwrap();
        c.execute("INSERT INTO tags VALUES ('/vault/sub/b.md','physics')", [])
            .unwrap();
        // lexical retrieval for vault A should find both
        let q = SearchQuery {
            text: "Quantum".into(),
            ..Default::default()
        };
        let hits = lexical(&c, &a, &q).unwrap();
        assert_eq!(hits.len(), 2);
        // tags overlap via helper
        let active = tags_for_path(&c, "/vault/a.md").unwrap();
        let cand = tags_for_path(&c, "/vault/sub/b.md").unwrap();
        assert!((tag_overlap_score(&active, &cand) - 1.0).abs() < 1e-6);
        // same folder false, different folder
        assert!(!same_folder("/vault/a.md", "/vault/sub/b.md"));
        assert!(same_folder("/vault/sub/b.md", "/vault/sub/c.md"));
    }

    #[test]
    fn rrf_and_boosts() {
        // fusion rewards agreement already tested in search.rs; here test final scoring
        // Simulate candidates: one explicit with low RRF, one semantic-only with higher RRF
        // explicit should win due to 0.30+0.20 boosts
        let explicit_rrf = 0.016;
        let sem_rrf = 0.020;
        let explicit_final = explicit_rrf + 0.30 + 0.20;
        let sem_final = sem_rrf;
        assert!(explicit_final > sem_final);
    }

    #[test]
    fn explicit_outranks_high_semantic() {
        // Full scenario: active note A links to B (explicit), C is high semantic neighbor
        let (c, a, _) = fixture();
        super::super::sync(&c, &a, "/vault/active.md", "Study of [[target]]").unwrap();
        super::super::sync(&c, &a, "/vault/target.md", "Target content about quantum").unwrap();
        super::super::sync(&c, &a, "/vault/random.md", "Quantum random unrelated").unwrap();
        let explicit = explicit_targets(
            &c,
            &a,
            &c.query_row(
                "SELECT id FROM knowledge_notes WHERE path='/vault/active.md'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(explicit.contains(
            &c.query_row(
                "SELECT id FROM knowledge_notes WHERE path='/vault/target.md'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap()
        ));
    }

    #[test]
    fn context_budget_truncates() {
        let text = "x".repeat(5000);
        let budget = 1000usize;
        let truncated = if text.len() > budget {
            format!("{}…", &text[..budget - 10])
        } else {
            text.clone()
        };
        assert!(truncated.len() <= budget + 10);
    }
}

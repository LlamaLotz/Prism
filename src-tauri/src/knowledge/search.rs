use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::Manager;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchQuery {
    pub text: String,
    pub mode: String,
    pub folder: Option<String>,
    pub tag: Option<String>,
    pub offset: usize,
    pub limit: usize,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub note_id: String,
    pub block_id: Option<String>,
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub lexical: Option<f64>,
    pub semantic: Option<f32>,
    pub score: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub items: Vec<SearchHit>,
    pub degraded: Option<String>,
    pub next_offset: Option<usize>,
}
pub(crate) fn fts_query(text: &str) -> String {
    text.split_whitespace()
        .take(32)
        .map(|s| format!("\"{}\"", s.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}
pub(crate) fn eligible(
    c: &Connection,
    path: &str,
    vault: &str,
    q: &SearchQuery,
) -> Result<Option<(String, String)>, String> {
    c.query_row("SELECT n.id,n.title FROM knowledge_notes n WHERE n.path=?1 AND n.vault_id=?2 AND n.deleted=0 AND (?3 IS NULL OR instr(n.path,rtrim(?3,'/')||'/')=1) AND (?4 IS NULL OR EXISTS(SELECT 1 FROM tags t WHERE t.note_id=n.path AND t.tag_name=?4))",params![path,vault,q.folder,q.tag],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())
}
pub fn lexical(c: &Connection, vault: &str, q: &SearchQuery) -> Result<Vec<SearchHit>, String> {
    if q.text.trim().is_empty() {
        return Ok(vec![]);
    }
    let mut stmt=c.prepare("WITH matches AS MATERIALIZED (SELECT n.id AS note_id,f.block_id,n.path,n.title,snippet(knowledge_fts,3,'','', ' … ',36) AS excerpt,bm25(knowledge_fts,0,0,3,1) AS relevance FROM knowledge_fts f JOIN knowledge_notes n ON n.id=f.note_id WHERE knowledge_fts MATCH ?1 AND n.vault_id=?2 AND n.deleted=0 AND (?3 IS NULL OR instr(n.path,rtrim(?3,'/')||'/')=1) AND (?4 IS NULL OR EXISTS(SELECT 1 FROM tags t WHERE t.note_id=n.path AND t.tag_name=?4))), ranked AS (SELECT *,row_number() OVER (PARTITION BY note_id ORDER BY relevance,block_id) AS block_rank FROM matches) SELECT note_id,block_id,path,title,excerpt,relevance FROM ranked WHERE block_rank=1 ORDER BY relevance,note_id,block_id LIMIT 1000").map_err(|e|e.to_string())?;
    let result = stmt
        .query_map(params![fts_query(&q.text), vault, q.folder, q.tag], |r| {
            Ok(SearchHit {
                note_id: r.get(0)?,
                block_id: r.get(1)?,
                path: r.get(2)?,
                title: r.get(3)?,
                snippet: r.get(4)?,
                lexical: Some(r.get(5)?),
                semantic: None,
                score: 0.0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(result)
}
pub fn fuse(lex: Vec<SearchHit>, sem: Vec<SearchHit>) -> Vec<SearchHit> {
    let mut items: HashMap<String, SearchHit> = HashMap::new();
    for list in [lex, sem] {
        let mut seen = std::collections::HashSet::new();
        let mut rank = 0;
        for mut hit in list {
            if !seen.insert(hit.note_id.clone()) {
                continue;
            }
            rank += 1;
            let contribution = 1.0 / (60.0 + rank as f64);
            if let Some(old) = items.get_mut(&hit.note_id) {
                old.score += contribution;
                if hit.semantic.is_some() {
                    old.semantic = hit.semantic;
                }
            } else {
                hit.score = contribution;
                items.insert(hit.note_id.clone(), hit);
            }
        }
    }
    let mut out: Vec<_> = items.into_values().collect();
    out.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.note_id.cmp(&b.note_id)));
    out
}
#[tauri::command]
pub async fn search_knowledge(
    app: tauri::AppHandle,
    query: SearchQuery,
) -> Result<SearchPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let scope = super::current(&app)?;
        let c = crate::db::init_db(&app)?;
        if !["", "lexical", "semantic", "hybrid"].contains(&query.mode.as_str()) {
            return Err("Unsupported search mode".into());
        }
        let lex = lexical(&c, &scope.vault_id, &query)?;
        let mut sem = vec![];
        let mut degraded = None;
        if query.mode == "semantic" || query.mode == "hybrid" {
            // Search never initializes or downloads a model. Existing background loading is separate.
            let state = app.state::<crate::AppState>();
            let engine = state
                .embeddings
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|r| r.as_ref().ok())
                .cloned();
            if let Some(engine) = engine {
                let _lock = crate::embed_guard(&state);
                match engine.search_text(&query.text, 1000) {
                    Ok(matches) => {
                        for m in matches {
                            if let Some((id, title)) =
                                eligible(&c, &m.note_id, &scope.vault_id, &query)?
                            {
                                sem.push(SearchHit {
                                    note_id: id,
                                    block_id: None,
                                    path: m.note_id,
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
                            Some("Semantic inference unavailable; showing lexical results".into())
                    }
                }
            } else {
                degraded = Some("Local embeddings are not loaded; showing lexical results".into());
            }
        }
        let items = if query.mode == "semantic" && degraded.is_none() {
            fuse(vec![], sem)
        } else {
            fuse(lex, sem)
        };
        let start = query.offset.min(1000);
        let limit = if query.limit == 0 {
            50
        } else {
            query.limit.min(100)
        };
        let next = (items.len() > start + limit).then_some(start + limit);
        Ok(SearchPage {
            items: items.into_iter().skip(start).take(limit).collect(),
            degraded,
            next_offset: next,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RelationQuery {
    pub note_id: Option<String>,
    pub kinds: Vec<String>,
    pub offset: usize,
    pub limit: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub source: String,
    pub target: String,
    pub relation_type: String,
    pub source_block: Option<String>,
    pub target_block: Option<String>,
    pub target_anchor: Option<String>,
    pub timestamp: i64,
    pub confidence: f32,
    pub origin: String,
}
#[tauri::command]
pub fn get_relations(app: tauri::AppHandle, query: RelationQuery) -> Result<Vec<Relation>, String> {
    let scope = super::current(&app)?;
    let c = crate::db::init_db(&app)?;
    let include_semantic = query.kinds.iter().any(|kind| kind == "semantic");
    if !include_semantic {
        return relations(&c, &scope.vault_id, &query);
    }
    let note = query
        .note_id
        .as_ref()
        .ok_or("Semantic relations require a source note")?;
    let (id,path):(String,String)=c.query_row("SELECT id,path FROM knowledge_notes WHERE vault_id=?1 AND (id=?2 OR path=?2) AND deleted=0",params![scope.vault_id,note],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"Source note is unavailable")?;
    let persisted = RelationQuery {
        note_id: Some(id.clone()),
        kinds: query.kinds.clone(),
        offset: 0,
        limit: 500,
    };
    let mut output = relations(&c, &scope.vault_id, &persisted)?;
    let runtime = app.state::<super::KnowledgeRuntime>();
    let engine = runtime
        .embeddings
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|r| r.as_ref().ok())
        .cloned()
        .ok_or("Semantic relations are unavailable until the local embedding model is loaded")?;
    for hit in engine.find_related(&c, &path, 100)? {
        let target: Option<String> = c
            .query_row(
                "SELECT id FROM knowledge_notes WHERE path=?1 AND vault_id=?2 AND deleted=0",
                params![hit.note_id, scope.vault_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(target) = target {
            output.push(Relation {
                source: id.clone(),
                target,
                relation_type: "semantic".into(),
                source_block: None,
                target_block: None,
                target_anchor: None,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                confidence: hit.score,
                origin: "semantic-engine".into(),
            });
        }
    }
    output.sort_by(|a, b| (&a.relation_type, &a.target).cmp(&(&b.relation_type, &b.target)));
    Ok(output
        .into_iter()
        .skip(query.offset.min(500))
        .take(if query.limit == 0 {
            100
        } else {
            query.limit.min(500)
        })
        .collect())
}

pub fn relations(c: &Connection, vault: &str, q: &RelationQuery) -> Result<Vec<Relation>, String> {
    let mut stmt=c.prepare("SELECT n.id,n.path,l.target_ref,l.target_anchor,l.source_block,n.updated_at FROM knowledge_edges l JOIN knowledge_notes n ON n.id=l.source WHERE n.vault_id=?1 AND n.deleted=0 ORDER BY n.id,l.target_ref").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([vault], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let requested = if let Some(ref note) = q.note_id {
        c.query_row(
            "SELECT id FROM knowledge_notes WHERE vault_id=?1 AND (id=?2 OR path=?2)",
            params![vault, note],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .or_else(|| Some(note.clone()))
    } else {
        None
    };
    let mut out = vec![];
    for row in rows {
        let (id, path, name, anchor, source_block, timestamp) = row.map_err(|e| e.to_string())?;
        let targets: Vec<String> = {
            let mut st=c.prepare("SELECT id FROM knowledge_notes WHERE vault_id=?1 AND deleted=0 AND (path=?2 OR title=?2 COLLATE NOCASE OR path IN (SELECT note_id FROM aliases WHERE alias=?2)) ORDER BY id LIMIT 2").map_err(|e|e.to_string())?;
            let v = st
                .query_map(params![vault, name], |r| r.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            v
        };
        let target = if targets.len() == 1 {
            targets[0].clone()
        } else {
            format!("unresolved:{name}")
        };
        if requested
            .as_ref()
            .is_some_and(|n| n != &id && n != &path && n != &target)
        {
            continue;
        }
        let target_block = if let Some(ref anchor) = anchor {
            let mut st=c.prepare("SELECT id FROM knowledge_blocks WHERE note_id=?1 AND anchor=?2 AND deleted=0 LIMIT 2").map_err(|e|e.to_string())?;
            let ids = st
                .query_map(params![target, anchor], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            if ids.len() == 1 {
                Some(ids[0].clone())
            } else {
                None
            }
        } else {
            None
        };
        out.push(Relation {
            source: id,
            target,
            relation_type: if anchor.is_some() { "block" } else { "wiki" }.into(),
            source_block: Some(source_block),
            target_block,
            target_anchor: anchor,
            timestamp,
            confidence: 1.0,
            origin: "indexer".into(),
        });
    }
    for (kind,sql) in [("tag","SELECT n.id,t.tag_name,n.path FROM tags t JOIN knowledge_notes n ON n.path=t.note_id WHERE n.vault_id=?1 AND n.deleted=0"),("folder","SELECT id,path,path FROM knowledge_notes WHERE vault_id=?1 AND deleted=0")] {
 let mut st=c.prepare(sql).map_err(|e|e.to_string())?;let rows=st.query_map([vault],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(|e|e.to_string())?;
 for row in rows{let (source,value,path)=row.map_err(|e|e.to_string())?;if q.note_id.as_ref().is_some_and(|n|n!=&source&&n!=&path){continue;}
 let target=if kind=="folder" {format!("folder:{}",std::path::Path::new(&value).parent().unwrap_or(std::path::Path::new("")).display())}else{format!("tag:{value}")};out.push(Relation{source,target,relation_type:kind.into(),source_block:None,target_block:None,target_anchor:None,timestamp:0,confidence:1.0,origin:"indexer".into()});}
 }
    out.retain(|r| q.kinds.is_empty() || q.kinds.contains(&r.relation_type));
    out.sort_by(|a, b| {
        (&a.source, &a.relation_type, &a.target).cmp(&(&b.source, &b.relation_type, &b.target))
    });
    Ok(out
        .into_iter()
        .skip(q.offset.min(10000))
        .take(if q.limit == 0 { 100 } else { q.limit.min(500) })
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fts_escapes_syntax() {
        assert_eq!(fts_query("OR x:y"), "\"OR\" AND \"x:y\"");
    }
    #[test]
    fn fusion_rewards_agreement() {
        fn hit(id: &str) -> SearchHit {
            SearchHit {
                note_id: id.into(),
                block_id: None,
                path: id.into(),
                title: id.into(),
                snippet: String::new(),
                lexical: None,
                semantic: None,
                score: 0.0,
            }
        }
        let r = fuse(vec![hit("a"), hit("b")], vec![hit("b")]);
        assert_eq!(r[0].note_id, "b");
    }
}

/// Compatibility projection consumed by both existing graph renderers.
pub fn graph(c: &Connection, vault: &str) -> Result<crate::db::GraphPayload, String> {
    let mut stmt = c
        .prepare(
            "SELECT id,title,path FROM knowledge_notes WHERE vault_id=?1 AND deleted=0 ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let entries: Vec<(String, String, String)> = stmt
        .query_map([vault], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let titles: HashMap<_, _> = entries
        .iter()
        .map(|(id, title, _)| (id.clone(), title.clone()))
        .collect();
    let nodes = entries
        .into_iter()
        .map(|(_, title, path)| crate::db::GraphNodeMeta {
            id: path,
            title,
            exists: true,
        })
        .collect();
    let mut stmt=c.prepare("SELECT e.source,e.target_ref FROM knowledge_edges e JOIN knowledge_notes n ON n.id=e.source WHERE n.vault_id=?1 AND n.deleted=0 ORDER BY e.source,e.target_ref").map_err(|e|e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut links = vec![];
    for row in stmt
        .query_map([vault], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
    {
        let (id, target) = row.map_err(|e| e.to_string())?;
        if let Some(source) = titles.get(&id) {
            if seen.insert((source.clone(), target.clone())) {
                links.push(crate::db::GraphLinkMeta {
                    source: source.clone(),
                    target,
                });
            }
        }
    }
    Ok(crate::db::GraphPayload { nodes, links })
}
pub fn backlinks(
    c: &Connection,
    vault: &str,
    path: &str,
) -> Result<Vec<crate::db::BacklinkInfo>, String> {
    let mut stmt=c.prepare("SELECT DISTINCT n.path,n.title,e.start_line FROM knowledge_edges e JOIN knowledge_notes n ON n.id=e.source JOIN knowledge_notes t ON t.vault_id=n.vault_id AND t.path=?2 WHERE n.vault_id=?1 AND n.deleted=0 AND t.deleted=0 AND (e.target_ref=t.path OR e.target_ref=t.title COLLATE NOCASE OR EXISTS(SELECT 1 FROM aliases a WHERE a.note_id=t.path AND a.alias=e.target_ref COLLATE NOCASE)) ORDER BY n.path,e.start_line").map_err(|e|e.to_string())?;
    let out = stmt
        .query_map(params![vault, path], |r| {
            Ok(crate::db::BacklinkInfo {
                source_path: r.get(0)?,
                source_title: r.get(1)?,
                start_line: r.get(2)?,
                end_line: r.get(2)?,
                matched_text: None,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    fn fixture() -> (Connection, String, String) {
        let c = Connection::open_in_memory().unwrap();
        super::super::schema::migrate(&c).unwrap();
        c.execute_batch("CREATE TABLE tags(note_id TEXT,tag_name TEXT); CREATE TABLE aliases(note_id TEXT,alias TEXT)").unwrap();
        let a = super::super::vault(&c, std::path::Path::new("/a")).unwrap();
        let b = super::super::vault(&c, std::path::Path::new("/b")).unwrap();
        (c, a, b)
    }
    #[test]
    fn unopened_notes_filters_deletions_and_vault_isolation() {
        let (c, a, b) = fixture();
        super::super::sync(&c, &a, "/a/one.md", "Quantum information ^anchor").unwrap();
        super::super::sync(&c, &b, "/b/two.md", "Quantum mechanics").unwrap();
        let q = SearchQuery {
            text: "Quantum".into(),
            ..Default::default()
        };
        let found = lexical(&c, &a, &q).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "/a/one.md");
        let q = SearchQuery {
            text: "Quantum".into(),
            tag: Some("physics".into()),
            ..Default::default()
        };
        assert!(lexical(&c, &a, &q).unwrap().is_empty());
        c.execute("INSERT INTO tags VALUES ('/a/one.md','physics')", [])
            .unwrap();
        assert_eq!(lexical(&c, &a, &q).unwrap().len(), 1);
        super::super::remove(&c, "/a/one.md").unwrap();
        assert!(lexical(&c, &a, &q).unwrap().is_empty());
    }
    #[test]
    fn explicit_block_edges_keep_source_and_incoming_links() {
        let (c, a, _) = fixture();
        super::super::sync(&c, &a, "/a/one.md", "[[two#^anchor]]\n\n```\n[[fake]]\n```").unwrap();
        super::super::sync(&c, &a, "/a/two.md", "Target ^anchor").unwrap();
        let edges = relations(
            &c,
            &a,
            &RelationQuery {
                kinds: vec!["block".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(edges.len(), 1);
        assert!(edges[0].source_block.is_some());
        assert_eq!(edges[0].target_anchor.as_deref(), Some("anchor"));
        assert!(edges[0].target_block.is_some());
        let incoming = backlinks(&c, &a, "/a/two.md").unwrap();
        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].source_path, "/a/one.md");
        assert_eq!(graph(&c, &a).unwrap().links.len(), 1);
    }
    #[test]
    #[ignore = "100k-block load fixture; run explicitly"]
    fn hundred_thousand_blocks() {
        let (c, a, _) = fixture();
        for note in 0..100 {
            let text = (0..1000)
                .map(|b| format!("Note {note} passage {b} about quantum information.\n\n"))
                .collect::<String>();
            super::super::sync(&c, &a, &format!("/a/n{note}.md"), &text).unwrap();
        }
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM knowledge_blocks WHERE deleted=0",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            100000
        );
        let page = lexical(
            &c,
            &a,
            &SearchQuery {
                text: "quantum".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.len(), 100);
    }
}

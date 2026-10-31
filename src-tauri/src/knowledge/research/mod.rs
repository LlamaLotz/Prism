//! Native Research Runtime (R1 Discover).
//!
//! The command surface returns immediately: a session and its job identity are
//! persisted, then a detached worker runs the bounded discover pipeline. Web
//! access is always a permission-gated tool action, never an implicit query.
pub(crate) mod dedupe;
pub(crate) mod discover;
pub(crate) mod fetch;
pub(crate) mod notes;
pub(crate) mod providers;
pub(crate) mod store;

use crate::knowledge::{self, jobs, operations};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::Emitter;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Relevance {
    pub lexical: f64,
    pub domain: f64,
    pub freshness: f64,
    pub graph_proximity: f64,
    pub final_score: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub key: String,
    pub title: String,
    pub url: String,
    pub domain: String,
    pub snippet: String,
    pub extracted_chars: usize,
    pub relevance: Relevance,
    pub duplicate_of: Option<String>,
    pub why: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSession {
    pub session_id: String,
    pub job_id: String,
    pub query: String,
    pub depth: String,
    pub include_web: bool,
    pub use_sources: bool,
    pub collection_id: Option<String>,
    pub status: String,
    pub phase: String,
    pub progress: f64,
    pub candidates: Vec<Candidate>,
    pub added_keys: Vec<String>,
    pub error: Option<String>,
    pub created: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchStart {
    pub job_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchPreview {
    pub title: String,
    pub text: String,
    pub url: Option<String>,
    pub chars: usize,
}

fn sessions_dir(root: &Path) -> Result<PathBuf, String> {
    let dir = store::sessions_dir(root);
    operations::validate(root, &dir)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn session_path(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    session_id
        .parse::<uuid::Uuid>()
        .map_err(|_| "Invalid research session ID")?;
    let path = sessions_dir(root)?.join(format!("{session_id}.json"));
    operations::validate(root, &path)?;
    Ok(path)
}

fn save_session(root: &Path, session: &ResearchSession) -> Result<(), String> {
    let path = session_path(root, &session.session_id)?;
    let bytes = serde_json::to_vec_pretty(session).map_err(|e| e.to_string())?;
    operations::atomic_write(&path, &bytes, false)
}

fn load_session(root: &Path, session_id: &str) -> Result<ResearchSession, String> {
    let path = session_path(root, session_id)?;
    let raw = std::fs::read_to_string(path)
        .map_err(|_| "Research session not found".to_string())?;
    serde_json::from_str(&raw).map_err(|_| "Research session is unreadable".to_string())
}

fn emit_phase(app: &tauri::AppHandle, session: &ResearchSession) {
    let _ = app.emit(
        "research-phase",
        json!({
            "jobId": session.job_id,
            "sessionId": session.session_id,
            "phase": session.phase,
            "progress": session.progress,
        }),
    );
}

/// Advances a phase monotonically and persists it before emitting. The worker
/// calls this between units of work, so cancellation and reload never lose the
/// last known state.
pub(crate) fn advance(
    app: &tauri::AppHandle,
    root: &Path,
    session: &mut ResearchSession,
    phase: &str,
    progress: f64,
) -> Result<(), String> {
    session.status = "running".into();
    session.phase = phase.into();
    session.progress = session.progress.max(progress.clamp(0.0, 1.0));
    save_session(root, session)?;
    emit_phase(app, session);
    Ok(())
}

fn job_cancelled(app: &tauri::AppHandle, job_id: &str) -> bool {
    crate::db::init_db(app)
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT state FROM knowledge_jobs WHERE id=?1",
                [job_id],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .is_some_and(|state| state == "cancelled")
}

#[tauri::command]
pub fn research_start(
    app: tauri::AppHandle,
    vault_path: String,
    collection_id: Option<String>,
    query: String,
    depth: String,
    include_web: bool,
    use_sources: bool,
    request_id: Option<String>,
) -> Result<ResearchStart, String> {
    discover::validate_request(&query, &depth, include_web)?;
    let scope = crate::study::scope(&app, &vault_path)?;
    if let Some(id) = collection_id.as_deref() {
        let library = crate::study::db(&scope)?;
        crate::study::collection(&library, id).map_err(|_| "Notebook not found".to_string())?;
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let job_id = uuid::Uuid::new_v4().to_string();
    let mut session = ResearchSession {
        session_id: session_id.clone(),
        job_id: job_id.clone(),
        query: query.trim().to_string(),
        depth,
        include_web,
        use_sources,
        collection_id: collection_id.clone(),
        status: "queued".into(),
        phase: "queued".into(),
        progress: 0.0,
        candidates: Vec::new(),
        added_keys: Vec::new(),
        error: None,
        created: crate::study::now(),
    };
    save_session(&scope.root, &session)?;

    let worker_app = app.clone();
    let worker_job_id = job_id.clone();
    let root = scope.root.clone();
    let dedup = format!("research:{session_id}");
    let payload = json!({"sessionId": session_id.clone(), "query": session.query.clone()});
    std::thread::spawn(move || {
        let outcome = {
            let app = &worker_app;
            let session_ref = &mut session;
            jobs::run_with_id(
                app,
                &worker_job_id,
                "RESEARCH_DISCOVER",
                15,
                &dedup,
                payload,
                |job| discover::run(app, job, &scope, session_ref, request_id),
            )
        };
        match outcome {
            Ok(candidates) => {
                session.candidates = candidates;
                session.status = "done".into();
                session.phase = "done".into();
                session.progress = 1.0;
                session.error = None;
                if let Err(error) = save_session(&root, &session) {
                    session.status = "failed".into();
                    session.error = Some(error);
                    let _ = save_session(&root, &session);
                }
                let _ = worker_app.emit(
                    "research-candidates",
                    json!({
                        "jobId": session.job_id,
                        "sessionId": session.session_id,
                        "candidates": session.candidates,
                    }),
                );
                emit_phase(&worker_app, &session);
            }
            Err(error) => {
                let cancelled = job_cancelled(&worker_app, &session.job_id)
                    || error.contains("Operation cancelled")
                    || error.contains("Vault changed");
                session.status = if cancelled { "cancelled" } else { "failed" }.into();
                session.phase = session.status.clone();
                session.error = if cancelled { None } else { Some(error) };
                let _ = save_session(&root, &session);
                emit_phase(&worker_app, &session);
            }
        }
    });

    Ok(ResearchStart {
        job_id,
        session_id,
    })
}

#[tauri::command]
pub fn research_cancel(app: tauri::AppHandle, job_id: String) -> Result<(), String> {
    jobs::cancel_knowledge_job(app, job_id)
}

#[tauri::command]
pub fn research_get(app: tauri::AppHandle, session_id: String) -> Result<ResearchSession, String> {
    let scope = knowledge::current(&app)?;
    load_session(&scope.root, &session_id)
}

#[tauri::command]
pub fn research_add_sources(
    app: tauri::AppHandle,
    vault_path: String,
    collection_id: String,
    keys: Vec<String>,
) -> Result<Value, String> {
    if keys.len() > 100 {
        return Err("Add at most 100 sources at once".into());
    }
    let scope = crate::study::scope(&app, &vault_path)?;
    let _lock = operations::lock()?;
    let library = crate::study::db(&scope)?;
    crate::study::collection(&library, &collection_id)?;
    let mut normalized = Vec::new();
    for key in keys {
        let key = crate::study::normalize_key(&key);
        let Some(sha) = store::key_sha(&key) else {
            return Err(format!("{key} is not a web source key"));
        };
        if !store::snapshot_exists(&scope.root, sha) {
            if store::cache_exists(&scope.root, sha) {
                store::promote(&scope.root, sha)?;
            } else {
                return Err(format!(
                    "{key} is no longer available in the research cache"
                ));
            }
        }
        normalized.push(key);
    }
    crate::study::append_source_ids(&library, &collection_id, &normalized)
}

#[tauri::command]
pub async fn research_add_url(
    app: tauri::AppHandle,
    vault_path: String,
    collection_id: String,
    url: String,
) -> Result<Value, String> {
    let scope = crate::study::scope(&app, &vault_path)?;
    let normalized_url = dedupe::normalize_url(&url).ok_or("Enter a valid http(s) URL")?;
    {
        let library = crate::study::db(&scope)?;
        crate::study::collection(&library, &collection_id)?;
        for key in crate::study::source_ids(&library, &collection_id)? {
            let Some(sha) = store::key_sha(&key) else {
                continue;
            };
            let meta = store::snapshot_source(&scope.root, sha)
                .or_else(|| store::cache_source(&scope.root, sha))
                .map(|(meta, _)| meta);
            if meta
                .as_ref()
                .and_then(|meta| dedupe::normalize_url(&meta.url))
                .as_deref()
                == Some(normalized_url.as_str())
            {
                return Err("This URL is already a source in the notebook".into());
            }
        }
    }

    let page = fetch::fetch_page(&app, &url, &url).await?;
    let meta = store::SourceMeta {
        url: page.url.clone(),
        title: page.title.clone(),
        fetched_at: page.fetched_at,
        content_type: page.content_type,
        extractor: store::EXTRACTOR.into(),
        hash: page.hash.clone(),
    };
    let _lock = operations::lock()?;
    let library = crate::study::db(&scope)?;
    crate::study::collection(&library, &collection_id)?;
    store::write_cache(&scope.root, &meta, &page.text)?;
    store::promote(&scope.root, &page.hash)?;
    crate::study::append_source_ids(
        &library,
        &collection_id,
        &[store::web_key(&page.hash)],
    )
}

#[tauri::command]
pub fn research_preview(app: tauri::AppHandle, key: String) -> Result<ResearchPreview, String> {
    let scope = knowledge::current(&app)?;
    let preview = store::preview(&scope.root, &key, 20_000)?;
    Ok(ResearchPreview {
        title: preview.title,
        text: preview.text,
        url: preview.url,
        chars: preview.chars,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_files_round_trip_under_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let session = ResearchSession {
            session_id: uuid::Uuid::new_v4().to_string(),
            job_id: uuid::Uuid::new_v4().to_string(),
            query: "quantum computing".into(),
            depth: "discover".into(),
            include_web: true,
            use_sources: false,
            collection_id: None,
            status: "queued".into(),
            phase: "queued".into(),
            progress: 0.0,
            candidates: Vec::new(),
            added_keys: Vec::new(),
            error: None,
            created: 1,
        };
        save_session(&root, &session).unwrap();
        let loaded = load_session(&root, &session.session_id).unwrap();
        assert_eq!(loaded.session_id, session.session_id);
        assert_eq!(loaded.job_id, session.job_id);
        assert_eq!(loaded.query, "quantum computing");
        assert!(root
            .join(".prism/research/sessions")
            .join(format!("{}.json", session.session_id))
            .is_file());
    }
}

//! Vault-owned structured documents, reviewed import plans and batch publication.
use super::{operations, Scope};
use crate::document_model::{self as model, Fragment, Output, PrismDocument, Source};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
};
use tauri::Emitter;
const CACHE_QUOTA: u64 = 2 * 1024 * 1024 * 1024;
fn err(e: impl std::fmt::Display) -> String {
    format!("PERSISTENCE: {e}")
}
fn conflict(s: &str) -> String {
    format!("CONFLICT: {s}. Refresh the import preview.")
}
pub fn file_hash(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(path).map_err(err)?;
    let mut h = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        let n = f.read(&mut buf).map_err(err)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
fn private_dir(s: &Scope, name: &str) -> Result<PathBuf, String> {
    let path = s.root.join(".prism/documents").join(name);
    operations::validate(&s.root, &path)?;
    std::fs::create_dir_all(&path).map_err(err)?;
    Ok(path)
}
fn limited_read(path: &Path) -> Result<Vec<u8>, String> {
    if std::fs::metadata(path).map_err(err)?.len() > 96 * 1024 * 1024 {
        return Err("LIMIT: Document artifact too large".into());
    }
    std::fs::read(path).map_err(err)
}
struct ExtractionLogs {
    stage: PathBuf,
    scope: Scope,
}
impl Drop for ExtractionLogs {
    fn drop(&mut self) {
        let destination = self
            .scope
            .root
            .join(".prism/documents/logs")
            .join(uuid::Uuid::new_v4().to_string());
        for relative in ["diagnostics/logs", "legacy-runtime/logs"] {
            let source = self.stage.join(relative);
            if !source.is_dir() {
                continue;
            }
            if operations::validate(&self.scope.root, &destination).is_err()
                || std::fs::create_dir_all(&destination).is_err()
            {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(source) {
                for entry in entries.flatten() {
                    if entry.file_type().is_ok_and(|t| t.is_file()) {
                        let _ = std::fs::copy(entry.path(), destination.join(entry.file_name()));
                    }
                }
            }
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRequest {
    #[serde(default)]
    pub folder: String,
    pub kind: String,
    pub value: String,
    pub method: String,
    pub saved_revision: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPrepareRequest {
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default = "default_true")]
    pub include_subfolders: bool,
    #[serde(default = "default_ocr")]
    pub ocr: String,
    pub method: String,
    #[serde(default)]
    pub folder: String,
}
fn default_true() -> bool {
    true
}
fn default_ocr() -> String {
    "A".into()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchImportItem {
    #[serde(flatten)]
    pub summary: ImportSummary,
    pub source: String,
    pub destination: String,
    pub cached: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFailure {
    pub source: String,
    pub error: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPrepareResult {
    pub batch_id: String,
    pub batch_label: String,
    pub imports: Vec<BatchImportItem>,
    pub failures: Vec<BatchFailure>,
    pub skipped: Vec<BatchFailure>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchCommitResult {
    pub committed: Vec<String>,
    pub skipped: Vec<BatchFailure>,
    pub failed: Vec<BatchFailure>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    #[serde(default)]
    pub require_existing_folder: bool,
    pub name: String,
    pub folder: String,
    pub split_level: Option<u8>,
    pub keep_source: bool,
    pub separate_copy: bool,
    #[serde(default)]
    pub excluded_outputs: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlannedOutput {
    output: Output,
    path: String,
    mutation: Option<operations::Mutation>,
    conflict: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    id: String,
    revision: String,
    document_id: String,
    generation: String,
    token: String,
    options: ImportOptions,
    outputs: Vec<PlannedOutput>,
    retained: Vec<String>,
    source_copy: Option<String>,
    #[serde(default)]
    batch_id: Option<String>,
    #[serde(default)]
    batch_label: Option<String>,
    #[serde(default)]
    batch_index: Option<usize>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub id: String,
    pub title: String,
    pub state: String,
    pub revision: String,
    pub outputs: usize,
    pub needs_refresh: bool,
    pub batch_id: Option<String>,
    pub batch_label: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOutput {
    pub key: String,
    pub name: String,
    pub path: String,
    pub markdown: String,
    pub total_chars: usize,
    pub conflict: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub conflicts: usize,
    pub retained_total: usize,
    pub skipped_total: usize,
    pub skipped: Vec<(String, String)>,
    pub id: String,
    pub token: String,
    pub options: ImportOptions,
    pub outputs: Vec<PreviewOutput>,
    pub offset: usize,
    pub total: usize,
    pub warnings: Vec<String>,
    pub retained: Vec<String>,
    pub needs_refresh: bool,
}
fn load_plan(c: &Connection, s: &Scope, id: &str) -> Result<(String, Plan), String> {
    let (state, json): (String, String) = c
        .query_row(
            "SELECT state,payload FROM document_imports WHERE id=?1 AND vault_id=?2",
            params![id, s.vault_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(err)?;
    Ok((state, serde_json::from_str(&json).map_err(err)?))
}
fn save_plan(c: &Connection, p: &Plan, state: &str) -> Result<(), String> {
    c.execute(
        "UPDATE document_imports SET payload=?2,state=?3 WHERE id=?1",
        params![p.id, serde_json::to_string(p).map_err(err)?, state],
    )
    .map_err(err)?;
    Ok(())
}
fn load_document(c: &Connection, s: &Scope, revision: &str) -> Result<PrismDocument, String> {
    let(path,digest):(String,String)=c.query_row("SELECT artifact,artifact_hash FROM document_revisions WHERE vault_id=?1 AND revision=?2",params![s.vault_id,revision],|r|Ok((r.get(0)?,r.get(1)?))).map_err(err)?;
    operations::validate(&s.root, Path::new(&path))?;
    let bytes = limited_read(Path::new(&path))?;
    if model::hash(&bytes) != digest {
        return Err(
            "CACHE_CORRUPT: Extract this source again; its saved document failed verification"
                .into(),
        );
    }
    let doc: PrismDocument = serde_json::from_slice(&bytes).map_err(err)?;
    doc.validate()?;
    if doc.revision != revision {
        return Err("CACHE_CORRUPT: Revision mismatch".into());
    }
    c.execute(
        "UPDATE document_revisions SET last_used=unixepoch() WHERE vault_id=?1 AND revision=?2",
        params![s.vault_id, revision],
    )
    .map_err(err)?;
    Ok(doc)
}
fn store_document(
    c: &Connection,
    s: &Scope,
    d: &PrismDocument,
    runtime: &str,
) -> Result<(), String> {
    d.validate()?;
    let bytes = serde_json::to_vec(d).map_err(err)?;
    let path = private_dir(s, "revisions")?.join(format!("{}.json", d.revision));
    operations::validate(&s.root, &path)?;
    operations::atomic_write(&path, &bytes, false)?;
    c.execute(
        "INSERT OR IGNORE INTO knowledge_documents(id,vault_id,locator) VALUES(?1,?2,?3)",
        params![d.id, s.vault_id, d.source.locator],
    )
    .map_err(err)?;
    c.execute("INSERT INTO document_revisions(revision,vault_id,document_id,source_hash,settings,runtime,artifact,artifact_hash,bytes) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(vault_id,revision) DO UPDATE SET artifact_hash=excluded.artifact_hash,last_used=unixepoch()",params![d.revision,s.vault_id,d.id,d.source.content_hash,d.settings_fingerprint,runtime,path.to_string_lossy(),model::hash(&bytes),bytes.len()]).map_err(err)?;
    Ok(())
}
fn evict(c: &Connection, s: &Scope) -> Result<(), String> {
    evict_to(c, s, CACHE_QUOTA)
}
fn evict_to(c: &Connection, s: &Scope, quota: u64) -> Result<(), String> {
    let mut stmt=c.prepare("SELECT revision,artifact,bytes FROM document_revisions r WHERE vault_id=?1 AND pinned=0 AND NOT EXISTS(SELECT 1 FROM document_imports p WHERE p.vault_id=r.vault_id AND json_extract(p.payload,'$.revision')=r.revision AND p.state IN ('review','publishing','recovery_required')) ORDER BY last_used DESC").map_err(err)?;
    let rows = stmt
        .query_map([&s.vault_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u64>(2)?,
            ))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let mut total = 0u64;
    for (revision, path, size) in rows {
        total = total.saturating_add(size);
        if total > quota {
            operations::validate(&s.root, Path::new(&path))?;
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(err(e)),
            };
            c.execute(
                "DELETE FROM document_revisions WHERE vault_id=?1 AND revision=?2 AND pinned=0",
                params![s.vault_id, revision],
            )
            .map_err(err)?;
        }
    }
    Ok(())
}
fn destination(s: &Scope, folder: &str, name: &str) -> Result<String, String> {
    let p = s.root.join(folder).join(name);
    operations::validate(&s.root, &p)?;
    if Path::new(folder).is_absolute()
        || Path::new(folder)
            .components()
            .find_map(|c| match c {
                std::path::Component::Normal(v) => {
                    Some(v.to_string_lossy().eq_ignore_ascii_case(".prism"))
                }
                _ => None,
            })
            .unwrap_or(false)
    {
        return Err(conflict("Choose a relative note folder outside .prism"));
    }
    Ok(p.to_string_lossy().into())
}
fn regenerate(c: &Connection, s: &Scope, p: &mut Plan, doc: &PrismDocument) -> Result<(), String> {
    if p.options.require_existing_folder && !s.root.join(&p.options.folder).is_dir(){return Err(conflict("Destination folder is unavailable; choose another folder"));}
    let outputs = model::outputs_selected(
        doc,
        p.options.split_level,
        &p.options.name,
        &p.options.excluded_outputs,
    )?;
    let mut planned = vec![];
    let mut paths = std::collections::HashSet::new();
    let mut recovery_bytes = 0usize;
    for output in outputs {
        let path = destination(s, &p.options.folder, &output.name)?;
        if !paths.insert(path.to_lowercase()) {
            return Err(conflict("Output filenames collide"));
        }
        let previous:Option<(String,String,String,String)>=c.query_row("SELECT path,fingerprint,physical_id,note_id FROM document_outputs WHERE vault_id=?1 AND document_id=?2 AND output_key=?3",params![s.vault_id,doc.id,output.key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(err)?;
        let check = (|| {
            let snapshot = operations::snapshot(Path::new(&path))?;
            if let Some((old, hash, physical, note_id)) = &previous {
                if !p.options.separate_copy {
                    let actual:Option<String>=c.query_row("SELECT id FROM knowledge_notes WHERE vault_id=?1 AND path=?2 AND deleted=0",params![s.vault_id,old],|r|r.get(0)).optional().map_err(err)?;
                    if old != &path
                        || actual.as_ref() != Some(note_id)
                        || !snapshot.get("").is_some_and(|entry| {
                            &entry.fingerprint == hash && &entry.identity == physical
                        })
                    {
                        return Err(conflict("Generated note was edited, moved, deleted, or replaced; choose a separately named import"));
                    }
                    let old = std::fs::read_to_string(&path).map_err(err)?;
                    return operations::capture(
                        c,
                        s,
                        "edit_note",
                        &path,
                        None,
                        &old,
                        &output.markdown,
                    );
                }
            }
            if !snapshot.is_empty() {
                return Err(conflict(
                    "Destination belongs to an existing note; choose another name",
                ));
            }
            let retired: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM knowledge_notes WHERE vault_id=?1 AND path=?2)",
                    params![s.vault_id, path],
                    |r| r.get(0),
                )
                .map_err(err)?;
            if retired {
                return Err(conflict(
                    "Destination has a previous note identity; choose another name",
                ));
            }
            operations::capture(c, s, "create_note", &path, None, "", &output.markdown)
        })();
        let (mutation, conflict) = match check {
            Ok(m) => (Some(m), None),
            Err(e) => (None, Some(e)),
        };
        if let Some(m) = &mutation {
            for e in m.before.values().chain(m.after.values()) {
                recovery_bytes =
                    recovery_bytes.saturating_add(e.data.as_ref().map_or(0, String::len));
            }
        }
        if recovery_bytes > 64 * 1024 * 1024 * 4 / 3 {
            return Err(
                "LIMIT: Combined recovery versions exceed 64 MiB; divide the import".into(),
            );
        }
        planned.push(PlannedOutput {
            output,
            path,
            mutation,
            conflict,
        });
    }
    let mut stmt = c
        .prepare("SELECT path FROM document_outputs WHERE vault_id=?1 AND document_id=?2")
        .map_err(err)?;
    p.retained = stmt
        .query_map(params![s.vault_id, doc.id], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?
        .into_iter()
        .filter(|path| !planned.iter().any(|o| &o.path == path))
        .collect();
    p.outputs = planned;
    p.generation = s.generation.clone();
    p.token = uuid::Uuid::new_v4().to_string();
    Ok(())
}
fn summary(p: &Plan, state: &str, s: &Scope) -> ImportSummary {
    ImportSummary {
        id: p.id.clone(),
        title: p.options.name.clone(),
        state: state.into(),
        revision: p.revision.clone(),
        outputs: p.outputs.len(),
        needs_refresh: p.generation != s.generation,
        batch_id: p.batch_id.clone(),
        batch_label: p.batch_label.clone(),
    }
}
fn runtime_signature(app: &tauri::AppHandle) -> String {
    let script = crate::resolve_resource_file(app, "Extractor Final/master_extractor.py");
    let config = crate::config::load_runtime_config(app).unwrap_or_default();
    let manifest = crate::resolve_resource_file(app, "ingest-runtime/manifest.json");
    #[cfg(feature = "ingest-rust")]
    let worker = crate::native_ingest::executable(app)
        .and_then(|p| file_hash(&p).ok())
        .unwrap_or_default();
    #[cfg(not(feature = "ingest-rust"))]
    let worker = String::new();
    model::hash(
        format!(
            "{:?}:{}:{}:{}:{}",
            config.ingestion_engine,
            file_hash(&script).unwrap_or_default(),
            file_hash(&manifest).unwrap_or_default(),
            env!("CARGO_PKG_VERSION"),
            worker
        )
        .as_bytes(),
    )
}
#[tauri::command]
pub async fn prepare_document_import(
    app: tauri::AppHandle,
    window: tauri::Window,
    request: PrepareRequest,
) -> Result<ImportSummary, String> {
    let s = super::current(&app)?;
    let c = crate::db::init_db(&app)?;
    destination(&s,&request.folder,"import.md")?;
    if !s.root.join(&request.folder).is_dir(){return Err(conflict("Destination folder is unavailable; choose another folder"));}
    let locator = if request.kind == "file" {
        request
            .value
            .rsplit_once('|')
            .filter(|(_, suffix)| ["A", "O", "N"].contains(suffix))
            .map(|(path, _)| path)
            .unwrap_or(&request.value)
            .to_string()
    } else {
        request.value.clone()
    };
    if !["file", "url"].contains(&request.kind.as_str()) {
        return Err("Unsupported source kind".into());
    }
    let settings = model::hash(
        serde_json::to_vec(&(
            request.kind.as_str(),
            request.method.as_str(),
            request.value.strip_prefix(&locator).unwrap_or(""),
        ))
        .map_err(err)?
        .as_slice(),
    );
    let runtime = runtime_signature(&app);
    let source_hash = if request.kind == "file" {
        file_hash(Path::new(&locator))?
    } else {
        String::new()
    };
    let cached = if let Some(revision) = &request.saved_revision {
        let d = load_document(&c, &s, revision)?;
        if d.source.locator != locator {
            return Err(conflict("Saved revision belongs to another source"));
        }
        Some(d)
    } else if request.kind == "file" {
        let revision:Option<String>=c.query_row("SELECT revision FROM document_revisions WHERE vault_id=?1 AND document_id=?2 AND source_hash=?3 AND settings=?4 AND runtime=?5 ORDER BY last_used DESC LIMIT 1",params![s.vault_id,model::hash(locator.as_bytes()),source_hash,settings,runtime],|r|r.get(0)).optional().map_err(err)?;
        revision.and_then(|r| load_document(&c, &s, &r).ok())
    } else {
        None
    };
    let documents = if let Some(doc) = cached {
        vec![doc]
    } else {
        let stage = tempfile::Builder::new()
            .prefix("extract-")
            .tempdir_in(private_dir(&s, "staging")?)
            .map_err(err)?;
        let _logs = ExtractionLogs {
            stage: stage.path().into(),
            scope: s.clone(),
        };
        let ext = Path::new(&locator)
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        if request.kind == "file" && matches!(ext.as_str(), "md" | "markdown" | "txt") {
            let bytes = limited_read(Path::new(&locator))?;
            let text = String::from_utf8(bytes).map_err(err)?;
            operations::atomic_write(&stage.path().join("source.md"), text.as_bytes(), true)?;
        } else {
            // Run against a verified immutable snapshot, so an edit during cloud consent
            // cannot substitute new file contents into an approved request.
            let execution_value = if request.kind == "file" {
                let input_dir = stage.path().join("input");
                std::fs::create_dir(&input_dir).map_err(err)?;
                let input = input_dir.join(
                    Path::new(&locator)
                        .file_name()
                        .ok_or("Source filename missing")?,
                );
                std::fs::copy(&locator, &input).map_err(err)?;
                if file_hash(&input)? != source_hash {
                    return Err(conflict("Source changed while staging"));
                }
                format!(
                    "{}{}",
                    input.to_string_lossy(),
                    request.value.strip_prefix(&locator).unwrap_or("")
                )
            } else {
                request.value.clone()
            };
            crate::extract_to_stage_async(
                app.clone(),
                window.clone(),
                stage.path().to_string_lossy().into(),
                request.kind.clone(),
                execution_value,
                request.method.clone(),
            )
            .await?;
        }
        if super::current(&app)?.generation != s.generation {
            return Err(conflict("Vault changed during extraction"));
        }
        if request.kind == "file" && file_hash(Path::new(&locator))? != source_hash {
            return Err(conflict("Source changed during extraction"));
        }
        let mut docs = vec![];
        for entry in walkdir::WalkDir::new(stage.path())
            .max_depth(1)
            .follow_links(false)
            .sort_by_file_name()
        {
            let entry = entry.map_err(err)?;
            if entry.file_type().is_symlink() {
                return Err(conflict("Extractor emitted a symlink"));
            }
            if !entry.file_type().is_file() || !entry.path().extension().is_some_and(|e| e == "md")
            {
                continue;
            }
            let markdown = String::from_utf8(limited_read(entry.path())?).map_err(err)?;
            let sidecar = entry.path().with_file_name(format!(
                "{}.prism.json",
                entry.file_name().to_string_lossy()
            ));
            let native = if sidecar.is_file() {
                let d: PrismDocument =
                    serde_json::from_slice(&limited_read(&sidecar)?).map_err(err)?;
                d.validate()?;
                Some(d)
            } else {
                None
            };
            let title = if entry.file_name() == "source.md" {
                Path::new(&locator)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            } else {
                entry
                    .path()
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            };
            let fragments = if let Some(d) = &native {
                d.blocks
                    .iter()
                    .map(|b| Fragment {
                        markdown: b.markdown.clone(),
                        location: b.location.clone(),
                    })
                    .collect()
            } else {
                vec![Fragment {
                    markdown: markdown.clone(),
                    location: None,
                }]
            };
            let mut d = PrismDocument::new(
                title,
                Source {
                    locator: locator.clone(),
                    content_hash: if request.kind == "file" {
                        source_hash.clone()
                    } else {
                        model::hash(markdown.as_bytes())
                    },
                    kind: if matches!(ext.as_str(), "md" | "markdown") {
                        "markdown"
                    } else {
                        request.kind.as_str()
                    }
                    .into(),
                    fingerprint_kind: if request.kind == "file" {
                        "bytes"
                    } else {
                        "extracted_snapshot"
                    }
                    .into(),
                },
                native
                    .as_ref()
                    .map(|d| d.extractor.clone())
                    .unwrap_or_else(|| {
                        if entry.file_name() == "source.md" {
                            "Prism text"
                        } else {
                            "Python fallback"
                        }
                        .into()
                    }),
                runtime.clone(),
                settings.clone(),
                fragments,
            );
            if let Some(native) = &native {
                d.warnings.extend(native.warnings.clone());
            }
            if native.is_none() && entry.file_name() != "source.md" {
                d.warnings.push(
                    "Fallback supplied Markdown without verified original-source locations.".into(),
                );
            }
            if request.kind == "url" {
                d.warnings.push("This revision fingerprints the extracted web snapshot. Refresh fetches the source again with privacy authorization.".into());
            }
            docs.push(d);
        }
        if docs.is_empty() {
            return Err("Extraction produced no Markdown documents".into());
        }
        docs
    };
    // Each extractor source is reviewed as one document, preserving multiple fallback outputs in order.
    let mut doc = documents[0].clone();
    if documents.len() > 1 {
        let fragments = documents
            .iter()
            .flat_map(|d| {
                d.blocks.iter().map(|b| Fragment {
                    markdown: b.markdown.clone(),
                    location: b.location.clone(),
                })
            })
            .collect();
        if doc.source.fingerprint_kind != "bytes" {
            doc.source.content_hash = model::hash(
                documents
                    .iter()
                    .map(|d| d.source.content_hash.as_str())
                    .collect::<Vec<_>>()
                    .join(":")
                    .as_bytes(),
            );
        }
        doc = PrismDocument::new(
            doc.title,
            doc.source,
            doc.extractor,
            doc.extractor_version,
            doc.settings_fingerprint,
            fragments,
        );
        doc.warnings.push(
            "Extractor emitted multiple files; combined for a single reviewed import.".into(),
        );
    }
    let _guard = operations::lock()?;
    if super::current(&app)?.generation != s.generation {
        return Err(conflict("Vault changed"));
    }
    store_document(&c, &s, &doc, &runtime)?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut plan = Plan {
        id: id.clone(),
        revision: doc.revision.clone(),
        document_id: doc.id.clone(),
        generation: s.generation.clone(),
        token: String::new(),
        options: ImportOptions {
            require_existing_folder: true,
            name: doc.title.clone(),
            folder: request.folder.clone(),
            split_level: None,
            keep_source: false,
            separate_copy: false,
            excluded_outputs: vec![],
        },
        outputs: vec![],
        retained: vec![],
        source_copy: None,
        batch_id: None,
        batch_label: None,
        batch_index: None,
    };
    regenerate(&c, &s, &mut plan, &doc)?;
    let tx = c.unchecked_transaction().map_err(err)?;
    tx.execute("INSERT INTO document_imports(id,vault_id,job_id,state,payload) VALUES(?1,?2,?1,'review',?3)",params![id,s.vault_id,serde_json::to_string(&plan).map_err(err)?]).map_err(err)?;
    tx.execute("INSERT INTO knowledge_jobs(id,vault_id,kind,dedup,priority,state,progress,payload) VALUES(?1,?2,'DOCUMENT_IMPORT',?1,10,'waiting_for_approval',0.8,?3)",params![id,s.vault_id,serde_json::json!({"importId":id}).to_string()]).map_err(err)?;
    tx.commit().map_err(err)?;
    evict(&c, &s)?;
    super::emit(&app, &c, &s.vault_id, "document_review_required", &id)?;
    let _ = window.emit(
        "ingestion-progress",
        "Extraction ready — review before importing notes.",
    );
    Ok(summary(&plan, "review", &s))
}
const BATCH_MAX_FILES: usize = 200;
const BATCH_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const BATCH_EXTENSIONS: &[&str] = &[
    "pdf", "docx", "pptx", "xlsx", "mp3", "wav", "m4a", "flac", "aac", "ogg", "mp4", "mov",
    "mkv", "avi", "webm", "png", "jpg", "jpeg", "webp", "html", "md", "markdown", "txt",
];

fn batch_extension_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| BATCH_EXTENSIONS.iter().any(|known| known.eq_ignore_ascii_case(ext)))
        .unwrap_or(false)
}

fn batch_component(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| match ch {
            '\\' | '/' | '*' | '?' | ':' | '"' | '<' | '>' | '|' => ' ',
            _ => ch,
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim().trim_end_matches('.').trim();
    if cleaned.is_empty() {
        "document".into()
    } else {
        cleaned.chars().take(80).collect()
    }
}

fn batch_relative_allowed(relative: &Path) -> bool {
    relative.components().all(|component| match component {
        std::path::Component::Normal(value) => {
            let name = value.to_string_lossy();
            let lower = name.to_ascii_lowercase();
            !name.starts_with('.')
                && !name.starts_with("~$")
                && lower != "thumbs.db"
                && lower != "desktop.ini"
                && lower != "legacy-runtime"
                && lower != "diagnostics"
        }
        _ => true,
    })
}

struct BatchSource {
    path: PathBuf,
    /// Relative folder below the destination base (mirrored source folder).
    suffix: String,
}

fn add_batch_source(
    path: PathBuf,
    suffix: String,
    sources: &mut Vec<BatchSource>,
    skipped: &mut Vec<BatchFailure>,
    seen: &mut HashSet<PathBuf>,
    total_bytes: &mut u64,
) -> Result<(), String> {
    if !path.is_file() {
        skipped.push(BatchFailure {
            source: path.to_string_lossy().into(),
            error: "Not a readable file".into(),
        });
        return Ok(());
    }
    let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    if !seen.insert(canonical) {
        return Ok(());
    }
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) => {
            skipped.push(BatchFailure {
                source: path.to_string_lossy().into(),
                error: error.to_string(),
            });
            return Ok(());
        }
    };
    if sources.len() >= BATCH_MAX_FILES {
        return Err(format!(
            "This batch contains more than {BATCH_MAX_FILES} supported files. Split it into smaller batches."
        ));
    }
    if total_bytes.saturating_add(metadata.len()) > BATCH_MAX_BYTES {
        return Err(
            "This batch is larger than 4 GB. Split it into smaller batches.".into(),
        );
    }
    *total_bytes += metadata.len();
    sources.push(BatchSource { path, suffix });
    Ok(())
}

fn expand_batch_sources(
    request: &BatchPrepareRequest,
) -> Result<(Vec<BatchSource>, Vec<BatchFailure>), String> {
    let mut sources = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = HashSet::new();
    let mut total_bytes = 0u64;

    for file in &request.files {
        add_batch_source(
            PathBuf::from(file),
            String::new(),
            &mut sources,
            &mut skipped,
            &mut seen,
            &mut total_bytes,
        )?;
    }

    let mut root_labels = HashMap::<String, usize>::new();
    let mut seen_roots = HashSet::new();
    for folder in &request.folders {
        let root = PathBuf::from(folder);
        if !root.is_dir() {
            skipped.push(BatchFailure {
                source: folder.clone(),
                error: "Folder does not exist".into(),
            });
            continue;
        }
        let canonical_root = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        if !seen_roots.insert(canonical_root) {
            continue;
        }
        let base_label = root
            .file_name()
            .and_then(|name| name.to_str())
            .map(batch_component)
            .unwrap_or_else(|| "Folder".into());
        let count = root_labels.entry(base_label.to_lowercase()).or_insert(0);
        *count += 1;
        let label = if *count == 1 {
            base_label
        } else {
            format!("{base_label} ({count})")
        };

        let walker = if request.include_subfolders {
            walkdir::WalkDir::new(&root)
        } else {
            walkdir::WalkDir::new(&root).max_depth(1)
        };
        for entry in walker.follow_links(false).sort_by_file_name() {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    skipped.push(BatchFailure {
                        source: folder.clone(),
                        error: error.to_string(),
                    });
                    continue;
                }
            };
            if entry.path() == root
                || !entry.file_type().is_file()
                || entry.file_type().is_symlink()
            {
                continue;
            }
            let Ok(relative) = entry.path().strip_prefix(&root) else {
                continue;
            };
            if !batch_relative_allowed(relative) || !batch_extension_supported(entry.path()) {
                continue;
            }
            let parent = relative
                .parent()
                .map(|path| {
                    path.components()
                        .filter_map(|component| match component {
                            std::path::Component::Normal(value) => {
                                Some(batch_component(&value.to_string_lossy()))
                            }
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let mut parts = vec![label.clone()];
            parts.extend(parent);
            add_batch_source(
                entry.path().to_path_buf(),
                parts.join("/"),
                &mut sources,
                &mut skipped,
                &mut seen,
                &mut total_bytes,
            )?;
        }
    }

    sources.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((sources, skipped))
}

struct PreparedBatchSource {
    index: usize,
    path: PathBuf,
    title: String,
    source_hash: String,
    plan_folder: String,
    plan_name: String,
    staged_stem: String,
    text_direct: bool,
    was_cached: bool,
    document: Option<PrismDocument>,
}

fn batch_join(base: &str, suffix: &str) -> String {
    let base = base.trim_matches('/').replace('\\', "/");
    let suffix = suffix.trim_matches('/').replace('\\', "/");
    match (base.is_empty(), suffix.is_empty()) {
        (true, true) => String::new(),
        (true, false) => suffix,
        (false, true) => base,
        (false, false) => format!("{base}/{suffix}"),
    }
}

fn cached_revision(
    c: &Connection,
    s: &Scope,
    locator: &Path,
    source_hash: &str,
    settings: &str,
    runtime: &str,
) -> Option<String> {
    c.query_row(
        "SELECT revision FROM document_revisions WHERE vault_id=?1 AND document_id=?2 AND source_hash=?3 AND settings=?4 AND runtime=?5 ORDER BY last_used DESC LIMIT 1",
        params![
            s.vault_id,
            model::hash(locator.to_string_lossy().as_bytes()),
            source_hash,
            settings,
            runtime
        ],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn batch_document(
    source: &PreparedBatchSource,
    mut markdown: String,
    settings: &str,
) -> PrismDocument {
    let extractor = if source.text_direct {
        "Prism text"
    } else {
        "Python fallback"
    };
    if !source.text_direct {
        // The extractor names files after the indexed staging copy. Replace
        // those internal names so the reviewed note carries the real source.
        let extension = source
            .path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default();
        let staged_name = format!("{}.{}", source.staged_stem, extension);
        if let Some(original_name) = source.path.file_name().and_then(|name| name.to_str()) {
            markdown = markdown.replace(&staged_name, original_name);
        }
        markdown = markdown.replace(&source.staged_stem, &source.title);
    }
    let mut document = PrismDocument::new(
        source.title.clone(),
        Source {
            locator: source.path.to_string_lossy().into(),
            content_hash: source.source_hash.clone(),
            kind: "file".into(),
            fingerprint_kind: "bytes".into(),
        },
        extractor.into(),
        env!("CARGO_PKG_VERSION").into(),
        settings.into(),
        vec![Fragment {
            markdown,
            location: None,
        }],
    );
    if !source.text_direct {
        document.warnings.push(
            "Fallback supplied Markdown without verified original-source locations.".into(),
        );
    }
    document
}

fn create_batch_plan(
    c: &Connection,
    s: &Scope,
    doc: &PrismDocument,
    source: &PreparedBatchSource,
    batch_id: &str,
    batch_label: &str,
    runtime: &str,
) -> Result<Plan, String> {
    if !source.was_cached {
        store_document(c, s, doc, runtime)?;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut plan = Plan {
        id: id.clone(),
        revision: doc.revision.clone(),
        document_id: doc.id.clone(),
        generation: s.generation.clone(),
        token: String::new(),
        options: ImportOptions {
            require_existing_folder: false,
            name: source.plan_name.clone(),
            folder: source.plan_folder.clone(),
            split_level: None,
            keep_source: false,
            separate_copy: false,
            excluded_outputs: vec![],
        },
        outputs: vec![],
        retained: vec![],
        source_copy: None,
        batch_id: Some(batch_id.to_string()),
        batch_label: Some(batch_label.to_string()),
        batch_index: Some(source.index),
    };
    regenerate(c, s, &mut plan, doc)?;
    let tx = c.unchecked_transaction().map_err(err)?;
    tx.execute("INSERT INTO document_imports(id,vault_id,job_id,state,payload) VALUES(?1,?2,?1,'review',?3)",params![id,s.vault_id,serde_json::to_string(&plan).map_err(err)?]).map_err(err)?;
    tx.execute("INSERT INTO knowledge_jobs(id,vault_id,kind,dedup,priority,state,progress,payload) VALUES(?1,?2,'DOCUMENT_IMPORT',?1,10,'waiting_for_approval',0.8,?3)",params![id,s.vault_id,serde_json::json!({"importId":id}).to_string()]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(plan)
}

fn prepare_document_batch_inner(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    request: &BatchPrepareRequest,
    job: &super::jobs::JobContext,
) -> Result<BatchPrepareResult, String> {
    let s = super::current(app)?;
    let c = crate::db::init_db(app)?;
    destination(&s, &request.folder, "import.md")?;
    if !s.root.join(&request.folder).is_dir() {
        return Err(conflict("Destination folder is unavailable; choose another folder"));
    }

    let (sources, skipped) = expand_batch_sources(request)?;
    if sources.is_empty() {
        if let Some(first) = skipped.first() {
            return Err(format!("No files could be prepared: {}", first.error));
        }
        return Err("No supported files were selected".into());
    }

    let batch_id = uuid::Uuid::new_v4().to_string();
    let batch_label = if request.files.len() == 1 && request.folders.is_empty() {
        Path::new(&request.files[0])
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(batch_component)
            .unwrap_or_else(|| "Document".into())
    } else if request.folders.len() == 1 && request.files.is_empty() {
        Path::new(&request.folders[0])
            .file_name()
            .and_then(|name| name.to_str())
            .map(batch_component)
            .unwrap_or_else(|| "Folder".into())
    } else {
        format!("{} file(s)", sources.len())
    };
    let runtime = runtime_signature(app);
    let settings = model::hash(
        serde_json::to_vec(&(
            "file",
            request.method.as_str(),
            format!("|{}", request.ocr),
        ))
        .map_err(err)?
        .as_slice(),
    );

    let mut prepared = Vec::new();
    let mut failures = Vec::new();
    let total_sources = sources.len();
    for (offset, source) in sources.into_iter().enumerate() {
        job.check()?;
        let title = source
            .path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_string)
            .unwrap_or_else(|| "Document".into());
        let source_hash = match file_hash(&source.path) {
            Ok(hash) => hash,
            Err(error) => {
                failures.push(BatchFailure {
                    source: source.path.to_string_lossy().into(),
                    error,
                });
                continue;
            }
        };
        let extension = source
            .path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let text_direct = matches!(extension.as_str(), "md" | "markdown" | "txt");
        let plan_folder = batch_join(&request.folder, &source.suffix);
        let plan_name = batch_component(&title);
        let index = offset + 1;
        let staged_stem = format!("{index:04}__{}", batch_component(&title));
        let mut prepared_source = PreparedBatchSource {
            index,
            path: source.path,
            title,
            source_hash: source_hash.clone(),
            plan_folder,
            plan_name,
            staged_stem,
            text_direct,
            was_cached: false,
            document: None,
        };
        if let Some(revision) = cached_revision(
            &c,
            &s,
            &prepared_source.path,
            &source_hash,
            &settings,
            &runtime,
        ) {
            if let Ok(document) = load_document(&c, &s, &revision) {
                prepared_source.was_cached = true;
                prepared_source.document = Some(document);
            }
        }
        prepared.push(prepared_source);
    }

    // Disambiguate note names within each mirrored destination folder.
    let mut used_names = HashMap::<(String, String), usize>::new();
    for source in &mut prepared {
        let key = (
            source.plan_folder.to_lowercase(),
            source.plan_name.to_lowercase(),
        );
        let count = used_names.entry(key).or_insert(0);
        *count += 1;
        if *count > 1 {
            source.plan_name = format!("{} ({count})", source.plan_name);
        }
    }

    let stage = tempfile::Builder::new()
        .prefix("batch-")
        .tempdir_in(private_dir(&s, "staging")?)
        .map_err(err)?;
    let _logs = ExtractionLogs {
        stage: stage.path().into(),
        scope: s.clone(),
    };
    let input_dir = stage.path().join("input");
    std::fs::create_dir(&input_dir).map_err(err)?;
    let manifest_path = stage.path().join("batch-input.json");
    let mut manifest = Vec::new();

    for source in &prepared {
        job.check()?;
        if source.was_cached {
            continue;
        }
        let _ = window.emit(
            "ingestion-progress",
            format!(
                "[Prism] Staging {}/{}: {}",
                source.index,
                total_sources,
                source
                    .path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default()
            ),
        );
        if source.text_direct {
            let output = stage.path().join(format!("{}.md", source.staged_stem));
            match std::fs::read_to_string(&source.path) {
                Ok(text) => {
                    if let Err(error) = std::fs::write(&output, text) {
                        failures.push(BatchFailure {
                            source: source.path.to_string_lossy().into(),
                            error: error.to_string(),
                        });
                    }
                }
                Err(error) => failures.push(BatchFailure {
                    source: source.path.to_string_lossy().into(),
                    error: format!("Could not read text source: {error}"),
                }),
            }
        } else {
            let extension = source
                .path
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or_default();
            let staged = input_dir.join(format!("{}.{}", source.staged_stem, extension));
            match std::fs::copy(&source.path, &staged) {
                Ok(_) => match file_hash(&staged) {
                    Ok(hash) if hash == source.source_hash => {
                        manifest.push(format!("{}|{}", staged.to_string_lossy(), request.ocr));
                    }
                    Ok(_) => failures.push(BatchFailure {
                        source: source.path.to_string_lossy().into(),
                        error: "Source changed while staging".into(),
                    }),
                    Err(error) => failures.push(BatchFailure {
                        source: source.path.to_string_lossy().into(),
                        error,
                    }),
                },
                Err(error) => failures.push(BatchFailure {
                    source: source.path.to_string_lossy().into(),
                    error: error.to_string(),
                }),
            }
        }
    }

    let mut extraction_detail = String::new();
    if !manifest.is_empty() {
        std::fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).map_err(err)?,
        )
        .map_err(err)?;
        let authorization_sources = prepared
            .iter()
            .filter(|source| !source.was_cached)
            .map(|source| source.path.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        let run = crate::run_python_extractor(
            app,
            window,
            stage.path().to_string_lossy().as_ref(),
            "file",
            &authorization_sources,
            &request.ocr,
            job,
            Some(&manifest_path),
        )?;
        extraction_detail = run.stderr_tail;
    }

    // Map `<index>__<name>.md` outputs back to their source file.
    let mut outputs = HashMap::<usize, PathBuf>::new();
    if let Ok(entries) = std::fs::read_dir(stage.path()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || path.extension().map_or(true, |ext| ext != "md") {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(prefix) = name.split("__").next() else {
                continue;
            };
            if let Ok(index) = prefix.parse::<usize>() {
                outputs.insert(index, path);
            }
        }
    }

    for source in &mut prepared {
        if source.was_cached || source.document.is_some() {
            continue;
        }
        job.check()?;
        let Some(output) = outputs.remove(&source.index) else {
            failures.push(BatchFailure {
                source: source.path.to_string_lossy().into(),
                error: if extraction_detail.trim().is_empty() {
                    "Extractor produced no Markdown note for this file".into()
                } else {
                    format!(
                        "Extractor produced no Markdown note. {}",
                        extraction_detail.lines().last().unwrap_or("")
                    )
                },
            });
            continue;
        };
        if file_hash(&source.path)? != source.source_hash {
            failures.push(BatchFailure {
                source: source.path.to_string_lossy().into(),
                error: "Source changed during extraction".into(),
            });
            continue;
        }
        let bytes = match limited_read(&output) {
            Ok(bytes) => bytes,
            Err(error) => {
                failures.push(BatchFailure {
                    source: source.path.to_string_lossy().into(),
                    error,
                });
                continue;
            }
        };
        let markdown = match String::from_utf8(bytes) {
            Ok(markdown) => markdown,
            Err(_) => {
                failures.push(BatchFailure {
                    source: source.path.to_string_lossy().into(),
                    error: "Extractor output was not UTF-8 Markdown".into(),
                });
                continue;
            }
        };
        if markdown.trim().is_empty()
            || [
                "No content extracted.",
                "[PDF extraction produced no text]",
                "Office conversion failed:",
            ]
            .iter()
            .any(|placeholder| markdown.contains(placeholder))
        {
            failures.push(BatchFailure {
                source: source.path.to_string_lossy().into(),
                error: "Extractor produced an empty or failure placeholder".into(),
            });
            continue;
        }
        source.document = Some(batch_document(source, markdown, &settings));
    }

    if prepared.iter().all(|source| source.document.is_none()) {
        let detail = failures
            .first()
            .map(|failure| failure.error.clone())
            .unwrap_or_else(|| "Extraction produced no usable notes".into());
        return Err(format!("Batch extraction failed: {detail}"));
    }

    let _guard = operations::lock()?;
    if super::current(app)?.generation != s.generation {
        return Err(conflict("Vault changed during extraction"));
    }
    let mut imports = Vec::new();
    for source in &mut prepared {
        let Some(document) = source.document.take() else {
            continue;
        };
        let plan = match create_batch_plan(
            &c,
            &s,
            &document,
            source,
            &batch_id,
            &batch_label,
            &runtime,
        ) {
            Ok(plan) => plan,
            Err(error) => {
                failures.push(BatchFailure {
                    source: source.path.to_string_lossy().into(),
                    error,
                });
                continue;
            }
        };
        let summary = summary(&plan, "review", &s);
        imports.push(BatchImportItem {
            summary,
            source: source.path.to_string_lossy().into(),
            destination: batch_join(&plan.options.folder, &plan.options.name),
            cached: source.was_cached,
        });
        super::emit(app, &c, &s.vault_id, "document_review_required", &plan.id)?;
    }
    if imports.is_empty() {
        let detail = failures
            .first()
            .map(|failure| failure.error.clone())
            .unwrap_or_else(|| "No import plans could be created".into());
        return Err(format!("Batch import failed: {detail}"));
    }
    evict(&c, &s)?;
    let _ = window.emit(
        "ingestion-progress",
        format!(
            "Batch prepared: {} import(s), {} failed, {} skipped.",
            imports.len(),
            failures.len(),
            skipped.len()
        ),
    );
    Ok(BatchPrepareResult {
        batch_id,
        batch_label,
        imports,
        failures,
        skipped,
    })
}

#[tauri::command]
pub async fn prepare_document_batch(
    app: tauri::AppHandle,
    window: tauri::Window,
    request: BatchPrepareRequest,
) -> Result<BatchPrepareResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut key_parts = request.files.clone();
        key_parts.extend(request.folders.clone());
        key_parts.sort();
        let key = format!(
            "batch:{}:{}:{}",
            request.method,
            request.ocr,
            model::hash(key_parts.join("\n").as_bytes())
        );
        super::jobs::run(
            &app,
            "EXTRACT",
            10,
            &key,
            serde_json::json!({"batch": true}),
            |job| prepare_document_batch_inner(&app, &window, &request, job),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn commit_document_batch(
    app: tauri::AppHandle,
    window: tauri::Window,
    batch_id: String,
) -> Result<BatchCommitResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = super::current(&app)?;
        let c = crate::db::init_db(&app)?;
        let mut stmt = c
            .prepare("SELECT id,payload FROM document_imports WHERE vault_id=?1 AND json_extract(payload,'$.batchId')=?2 AND state='review' ORDER BY json_extract(payload,'$.batchIndex')")
            .map_err(err)?;
        let rows = stmt
            .query_map(params![s.vault_id, batch_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        let total = rows.len();
        let mut result = BatchCommitResult {
            committed: vec![],
            skipped: vec![],
            failed: vec![],
        };
        for (position, (id, payload)) in rows.into_iter().enumerate() {
            let plan: Plan = match serde_json::from_str(&payload) {
                Ok(plan) => plan,
                Err(error) => {
                    result.failed.push(BatchFailure {
                        source: id,
                        error: error.to_string(),
                    });
                    continue;
                }
            };
            if plan.generation != s.generation {
                result.skipped.push(BatchFailure {
                    source: plan.options.name.clone(),
                    error: "Vault changed; refresh the import preview".into(),
                });
                continue;
            }
            if plan
                .outputs
                .iter()
                .any(|output| output.conflict.is_some() || output.mutation.is_none())
            {
                result.skipped.push(BatchFailure {
                    source: plan.options.name.clone(),
                    error: "Resolve output conflicts before importing".into(),
                });
                continue;
            }
            let _ = window.emit(
                "ingestion-progress",
                format!("[Prism] Committing {}/{}: {}", position + 1, total, plan.options.name),
            );
            match commit_document_import_inner(app.clone(), id.clone(), plan.token) {
                Ok(_) => result.committed.push(id),
                Err(error) if error.starts_with("CONFLICT:") => result.skipped.push(BatchFailure {
                    source: plan.options.name,
                    error,
                }),
                Err(error) => result.failed.push(BatchFailure {
                    source: plan.options.name,
                    error,
                }),
            }
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn list_document_imports_inner(app: tauri::AppHandle) -> Result<Vec<ImportSummary>, String> {
    let _guard = operations::lock()?;
    let s = super::current(&app)?;
    let c = crate::db::init_db(&app)?;
    recover_batches(&c, &s)?;
    c.execute("UPDATE document_imports SET state='cancelled' WHERE vault_id=?1 AND state='review' AND job_id IN (SELECT id FROM knowledge_jobs WHERE state='cancelled')",[&s.vault_id]).map_err(err)?;
    let mut stmt=c.prepare("SELECT p.id,p.state,json_extract(p.payload,'$.options.name'),json_extract(p.payload,'$.revision'),json_array_length(p.payload,'$.outputs'),json_extract(p.payload,'$.generation'),json_extract(p.payload,'$.batchId'),json_extract(p.payload,'$.batchLabel') FROM document_imports p JOIN knowledge_jobs j ON j.id=p.job_id WHERE p.vault_id=?1 AND p.state IN ('review','publishing','recovery_required') AND j.state!='cancelled' ORDER BY p.created_at DESC LIMIT 500").map_err(err)?;
    let rows = stmt
        .query_map([&s.vault_id], |r| {
            Ok(ImportSummary {
                id: r.get(0)?,
                state: r.get(1)?,
                title: r.get(2)?,
                revision: r.get(3)?,
                outputs: r.get(4)?,
                needs_refresh: r.get::<_, String>(5)? != s.generation,
                batch_id: r.get(6)?,
                batch_label: r.get(7)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}
fn get_document_preview_inner(
    app: tauri::AppHandle,
    id: String,
    offset: Option<usize>,
    limit: Option<usize>,
    content_offset: Option<usize>,
) -> Result<Preview, String> {
    let s = super::current(&app)?;
    let c = crate::db::init_db(&app)?;
    let (_, p) = load_plan(&c, &s, &id)?;
    let doc = load_document(&c, &s, &p.revision)?;
    let skipped = if p.options.excluded_outputs.is_empty() {
        vec![]
    } else {
        model::outputs(&doc, p.options.split_level, &p.options.name)?
            .into_iter()
            .filter(|o| p.options.excluded_outputs.contains(&o.key) && o.key != "root")
            .map(|o| (o.key, o.name))
            .collect::<Vec<_>>()
    };
    let offset = offset
        .unwrap_or(0)
        .min(p.outputs.len().max(p.retained.len()).max(skipped.len()));
    let limit = limit.unwrap_or(100).clamp(1, 100);
    Ok(Preview {
        conflicts: p.outputs.iter().filter(|o| o.conflict.is_some()).count(),
        retained_total: p.retained.len(),
        skipped_total: skipped.len(),
        skipped: skipped.into_iter().skip(offset).take(limit).collect(),
        id: p.id,
        token: p.token,
        options: p.options,
        outputs: p
            .outputs
            .iter()
            .skip(offset)
            .take(limit)
            .map(|o| PreviewOutput {
                key: o.output.key.clone(),
                name: o.output.name.clone(),
                path: o.path.clone(),
                markdown: o
                    .output
                    .markdown
                    .chars()
                    .skip(content_offset.unwrap_or(0))
                    .take(8000)
                    .collect(),
                total_chars: o.output.markdown.chars().count(),
                conflict: o.conflict.clone(),
            })
            .collect(),
        offset,
        total: p.outputs.len(),
        warnings: doc
            .warnings
            .into_iter()
            .take(100)
            .map(|w| w.chars().take(1000).collect())
            .collect(),
        retained: p.retained.into_iter().skip(offset).take(limit).collect(),
        needs_refresh: p.generation != s.generation,
    })
}
fn update_document_import_inner(
    app: tauri::AppHandle,
    id: String,
    options: ImportOptions,
) -> Result<(), String> {
    let _guard = operations::lock()?;
    let s = super::current(&app)?;
    let c = crate::db::init_db(&app)?;
    let (state, mut p) = load_plan(&c, &s, &id)?;
    if state != "review" {
        return Err(conflict("Import is not awaiting review"));
    }
    let doc = load_document(&c, &s, &p.revision)?;
    p.options = options;
    regenerate(&c, &s, &mut p, &doc)?;
    save_plan(&c, &p, "review")
}
#[derive(Clone, Serialize, Deserialize)]
struct PreviousOutput {
    key: String,
    note_id: String,
    path: String,
    revision: String,
    fingerprint: String,
    physical_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Batch {
    plan: Plan,
    children: Vec<String>,
    previous: Vec<PreviousOutput>,
    #[serde(default)]
    folders: std::collections::BTreeMap<String, operations::Snapshot>,
}
fn output_rows(c: &Connection, s: &Scope, document: &str) -> Result<Vec<PreviousOutput>, String> {
    let mut q=c.prepare("SELECT output_key,note_id,path,revision,fingerprint,physical_id FROM document_outputs WHERE vault_id=?1 AND document_id=?2").map_err(err)?;
    let rows = q
        .query_map(params![s.vault_id, document], |r| {
            Ok(PreviousOutput {
                key: r.get(0)?,
                note_id: r.get(1)?,
                path: r.get(2)?,
                revision: r.get(3)?,
                fingerprint: r.get(4)?,
                physical_id: r.get(5)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}
fn map_sources(
    c: &Connection,
    s: &Scope,
    path: &str,
    doc: &PrismDocument,
    selected: Option<&[String]>,
) -> Result<(), String> {
    let mut q=c.prepare("SELECT b.id,b.text,b.hash FROM knowledge_blocks b JOIN knowledge_notes n ON n.id=b.note_id WHERE n.vault_id=?1 AND n.path=?2 AND n.deleted=0 AND b.deleted=0 ORDER BY b.ordinal").map_err(err)?;
    let rows = q
        .query_map(params![s.vault_id, path], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let selected_ids = selected.map(|ids| ids.iter().collect::<std::collections::HashSet<_>>());
    let candidates: Vec<_> = doc
        .blocks
        .iter()
        .filter(|b| {
            selected_ids
                .as_ref()
                .map_or(true, |ids| ids.contains(&b.id))
        })
        .collect();
    let mut by_text = std::collections::HashMap::<&str, Vec<&model::DocumentBlock>>::new();
    for block in &candidates {
        by_text.entry(&block.markdown).or_default().push(block);
    }
    // Output order is known during publication, including duplicate paragraphs.
    // On historical restoration without an output manifest, require unique text.
    let ordered: Vec<_> = candidates
        .iter()
        .copied()
        .filter(|b| !super::blocks::parse(&b.markdown).is_empty())
        .collect();
    let mut used = std::collections::HashSet::new();
    for (ordinal, (id, text, hash)) in rows.into_iter().enumerate() {
        let matches: Vec<_> = by_text
            .get(text.as_str())
            .into_iter()
            .flatten()
            .copied()
            .filter(|b| !used.contains(&b.id))
            .collect();
        let b = if selected.is_some() && ordered.get(ordinal).is_some_and(|b| b.markdown == text) {
            ordered[ordinal]
        } else if matches.len() == 1 {
            matches[0]
        } else {
            continue;
        };
        used.insert(b.id.clone());
        let location = serde_json::to_string(&b.location).map_err(err)?;
        c.execute("INSERT OR REPLACE INTO document_block_sources(block_id,document_id,revision,document_block_id,content_hash,location) VALUES(?1,?2,?3,?4,?5,?6)",params![id,doc.id,doc.revision,b.id,hash,location]).map_err(err)?;
        c.execute(
            "UPDATE knowledge_blocks SET source_id=?2,source_page=?3,source_bbox=?4 WHERE id=?1",
            params![
                id,
                doc.id,
                b.location.as_ref().and_then(|l| l.page),
                b.location
                    .as_ref()
                    .and_then(|l| l.bbox)
                    .map(|b| serde_json::to_string(&b).unwrap())
            ],
        )
        .map_err(err)?;
    }
    Ok(())
}
fn finish_import(c: &Connection, s: &Scope, batch: &Batch) -> Result<(), String> {
    let p = &batch.plan;
    let doc = load_document(c, s, &p.revision)?;
    for id in &batch.children {
        operations::check_undo(c, s, id)?;
    }
    let tx = c.unchecked_transaction().map_err(err)?;
    for output in &p.outputs {
        let snapshot = operations::snapshot(Path::new(&output.path))?;
        let entry = snapshot
            .get("")
            .ok_or_else(|| conflict("Published note is missing"))?;
        let expected = output
            .mutation
            .as_ref()
            .and_then(|m| m.after.get(""))
            .ok_or_else(|| conflict("Recovery evidence missing"))?;
        if entry.fingerprint != expected.fingerprint {
            return Err(conflict("Published note changed during reconciliation"));
        }
        let id: String = tx
            .query_row(
                "SELECT id FROM knowledge_notes WHERE vault_id=?1 AND path=?2 AND deleted=0",
                params![s.vault_id, output.path],
                |r| r.get(0),
            )
            .map_err(err)?;
        let key = if p.options.separate_copy {
            format!("{}:{}", p.id, output.output.key)
        } else {
            output.output.key.clone()
        };
        tx.execute("INSERT OR REPLACE INTO document_outputs(vault_id,document_id,output_key,note_id,path,revision,fingerprint,physical_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![s.vault_id,p.document_id,key,id,output.path,p.revision,entry.fingerprint,entry.identity]).map_err(err)?;
        map_sources(&tx, s, &output.path, &doc, Some(&output.output.blocks))?;
    }
    tx.execute(
        "UPDATE document_revisions SET pinned=1 WHERE vault_id=?1 AND revision=?2",
        params![s.vault_id, p.revision],
    )
    .map_err(err)?;
    tx.execute(
        "UPDATE document_imports SET state='imported' WHERE id=?1",
        [&p.id],
    )
    .map_err(err)?;
    tx.execute(
        "UPDATE knowledge_jobs SET state='succeeded',progress=1,error=NULL WHERE id=?1",
        [&p.id],
    )
    .map_err(err)?;
    for id in &batch.children {
        operations::check_undo(&tx, s, id)?;
    }
    tx.commit().map_err(err)?;
    Ok(())
}
fn set_batch(c: &Connection, id: &str, state: &str, error: Option<&str>) -> Result<(), String> {
    c.execute(
        "UPDATE document_import_batches SET state=?2,error=?3 WHERE id=?1",
        params![id, state, error],
    )
    .map_err(err)?;
    Ok(())
}
fn commit_document_import_inner(
    app: tauri::AppHandle,
    id: String,
    token: String,
) -> Result<serde_json::Value, String> {
    let _guard = operations::lock()?;
    let s = super::current(&app)?;
    let c = crate::db::init_db(&app)?;
    let (state, mut p) = load_plan(&c, &s, &id)?;
    if p.options.require_existing_folder && !s.root.join(&p.options.folder).is_dir(){return Err(conflict("Destination folder is unavailable; choose another folder"));}
    if state != "review" || p.token != token || p.generation != s.generation {
        return Err(conflict("Import approval is stale"));
    }
    let job_state: String = c
        .query_row("SELECT state FROM knowledge_jobs WHERE id=?1", [&id], |r| {
            r.get(0)
        })
        .map_err(err)?;
    if job_state != "waiting_for_approval" {
        return Err(conflict("Import job is no longer awaiting approval"));
    }
    let doc = load_document(&c, &s, &p.revision)?;
    if doc.source.fingerprint_kind == "bytes"
        && file_hash(Path::new(&doc.source.locator))? != doc.source.content_hash
    {
        return Err(conflict("Original source changed"));
    }
    let mut total = 0usize;
    for output in &p.outputs {
        let m = output
            .mutation
            .as_ref()
            .ok_or_else(|| conflict("Resolve output conflicts before importing"))?;
        operations::verify_approval(&c, &s, m)?;
        total = total.saturating_add(
            m.before
                .values()
                .chain(m.after.values())
                .filter_map(|e| e.data.as_ref())
                .map(|v| v.len())
                .sum::<usize>(),
        );
    }
    if total > 64 * 1024 * 1024 * 4 / 3 {
        return Err("LIMIT: Combined recovery versions exceed 64 MiB; divide the import".into());
    }
    if p.options.keep_source && doc.source.fingerprint_kind == "bytes" {
        let extension = Path::new(&doc.source.locator)
            .extension()
            .unwrap_or_default()
            .to_string_lossy();
        let dest = private_dir(&s, "sources")?.join(format!(
            "{}.{}",
            doc.source.content_hash,
            model::safe_name(&extension)
        ));
        operations::validate(&s.root, &dest)?;
        if !dest.exists() {
            let mut temp = tempfile::NamedTempFile::new_in(dest.parent().unwrap()).map_err(err)?;
            let mut source = std::fs::File::open(&doc.source.locator).map_err(err)?;
            std::io::copy(&mut source, &mut temp).map_err(err)?;
            temp.as_file().sync_all().map_err(err)?;
            if file_hash(temp.path())? != doc.source.content_hash {
                return Err(conflict("Source changed while retaining it"));
            }
            temp.persist_noclobber(&dest).map_err(err)?;
        }
        if file_hash(&dest)? != doc.source.content_hash {
            return Err("CACHE_CORRUPT: Retained source failed verification".into());
        }
        p.source_copy = Some(dest.to_string_lossy().into());
    }
    save_plan(&c, &p, "review")?;
    let (batch_id, batch) = begin_batch(&c, &s, &p)?;
    let result = apply_batch(&c, &s, &batch_id, &batch, || {
        if super::current(&app)?.generation != s.generation {
            return Err(conflict("Vault changed during publication"));
        }
        let state: String = c
            .query_row("SELECT state FROM knowledge_jobs WHERE id=?1", [&id], |r| {
                r.get(0)
            })
            .map_err(err)?;
        if state == "cancelled" {
            return Err("Import cancelled; partial publication requires recovery".into());
        }
        Ok(())
    });
    if let Err(e) = result {
        set_batch(&c, &batch_id, "recovery_required", Some(&e))?;
        save_plan(&c, &p, "recovery_required")?;
        c.execute(
            "UPDATE knowledge_jobs SET state='failed',error=?2 WHERE id=?1",
            params![id, e],
        )
        .map_err(err)?;
        return Err(format!(
            "RECOVERY_REQUIRED: Import {batch_id}: {e}. Recovery versions retained."
        ));
    }
    super::emit(&app, &c, &s.vault_id, "document_imported", &id)?;
    Ok(
        serde_json::json!({"operationId":batch_id,"undoAvailable":true,"paths":p.outputs.iter().map(|o|&o.path).collect::<Vec<_>>()}),
    )
}
fn begin_batch(c: &Connection, s: &Scope, p: &Plan) -> Result<(String, Batch), String> {
    for output in &p.outputs {
        operations::verify_approval(
            c,
            s,
            output
                .mutation
                .as_ref()
                .ok_or_else(|| conflict("Output conflict"))?,
        )?;
    }
    let batch_id = format!("document:{}", uuid::Uuid::new_v4());
    let children = (0..p.outputs.len())
        .map(|i| format!("import:{batch_id}:{i}"))
        .collect();
    let batch = Batch {
        previous: output_rows(c, s, &p.document_id)?,
        plan: p.clone(),
        children,
        folders: Default::default(),
    };
    let tx = c.unchecked_transaction().map_err(err)?;
    tx.execute("INSERT INTO document_import_batches(id,vault_id,state,payload) VALUES(?1,?2,'publishing',?3)",params![batch_id,s.vault_id,serde_json::to_string(&batch).map_err(err)?]).map_err(err)?;
    save_plan(&tx, p, "publishing")?;
    tx.execute(
        "UPDATE knowledge_jobs SET state='running' WHERE id=?1",
        [&p.id],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok((batch_id, batch))
}
fn apply_batch(
    c: &Connection,
    s: &Scope,
    id: &str,
    b: &Batch,
    mut checkpoint: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    for (output, child) in b.plan.outputs.iter().zip(&b.children) {
        checkpoint()?;
        let mut m = output
            .mutation
            .clone()
            .ok_or_else(|| conflict("Output conflict"))?;
        m.parents.retain(|p| !Path::new(p).exists());
        operations::apply_named(c, s, &m, child)?;
    }
    finish_import(c, s, b)?;
    record_folders(c, s, id, b)?;
    set_batch(c, id, "applied", None)
}
fn folder_snapshot(s: &Scope, path: &str) -> Result<operations::Snapshot, String> {
    operations::validate(&s.root, Path::new(path))?;
    let mut snapshot = operations::snapshot(Path::new(path))?;
    for entry in snapshot.values_mut() {
        entry.data = None;
    }
    Ok(snapshot)
}
fn record_folders(c: &Connection, s: &Scope, id: &str, b: &Batch) -> Result<(), String> {
    let mut b = b.clone();
    for output in &b.plan.outputs {
        if let Some(m) = &output.mutation {
            for path in &m.parents {
                b.folders.insert(path.clone(), folder_snapshot(s, path)?);
            }
        }
    }
    c.execute(
        "UPDATE document_import_batches SET payload=?2 WHERE id=?1",
        params![id, serde_json::to_string(&b).map_err(err)?],
    )
    .map_err(err)?;
    Ok(())
}
fn check_folders(s: &Scope, b: &Batch) -> Result<(), String> {
    for (path, expected) in &b.folders {
        if &folder_snapshot(s, path)? != expected {
            return Err(conflict(
                "An import-created folder changed; no notes were undone",
            ));
        }
    }
    Ok(())
}

pub fn recover_batches(c: &Connection, s: &Scope) -> Result<(), String> {
    operations::recover(c, s)?;
    let mut q=c.prepare("SELECT id,state,payload FROM document_import_batches WHERE vault_id=?1 AND state IN ('publishing','undoing','rolling_back')").map_err(err)?;
    let rows = q
        .query_map([&s.vault_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    for (id, state, json) in rows {
        let b: Batch = serde_json::from_str(&json).map_err(err)?;
        if state == "publishing" {
            match finish_import(c, s, &b) {
                Ok(()) => {
                    record_folders(c, s, &id, &b)?;
                    set_batch(c, &id, "applied", None)?;
                }
                Err(e) => {
                    set_batch(c, &id, "recovery_required", Some(&e))?;
                    save_plan(c, &b.plan, "recovery_required")?;
                }
            }
        } else {
            let done = b.children.iter().all(|id| {
                c.query_row(
                    "SELECT state FROM knowledge_operations WHERE id=?1",
                    [id],
                    |r| r.get::<_, String>(0),
                )
                .ok()
                .as_deref()
                    == Some("undone")
            });
            if done {
                restore_mappings(c, s, &b)?;
                set_batch(c, &id, "undone", None)?;
            } else {
                set_batch(
                    c,
                    &id,
                    "recovery_required",
                    Some("Undo interrupted; current notes and recovery versions retained"),
                )?;
            }
        }
    }
    Ok(())
}
fn restore_mappings(c: &Connection, s: &Scope, b: &Batch) -> Result<(), String> {
    let tx = c.unchecked_transaction().map_err(err)?;
    restore_mappings_inner(&tx, s, b)?;
    tx.commit().map_err(err)
}
fn restore_mappings_inner(c: &Connection, s: &Scope, b: &Batch) -> Result<(), String> {
    for child in &b.children {
        let state: Option<String> = c
            .query_row(
                "SELECT state FROM knowledge_operations WHERE id=?1",
                [child],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        if state.as_deref() == Some("undone") {
            operations::check_restored(c, s, child)?;
        }
    }
    for output in &b.plan.outputs {
        let key = if b.plan.options.separate_copy {
            format!("{}:{}", b.plan.id, output.output.key)
        } else {
            output.output.key.clone()
        };
        c.execute(
            "DELETE FROM document_outputs WHERE vault_id=?1 AND document_id=?2 AND output_key=?3",
            params![s.vault_id, b.plan.document_id, key],
        )
        .map_err(err)?;
    }
    for previous in &b.previous {
        if !b.plan.outputs.iter().any(|o| o.path == previous.path) {
            continue;
        }
        let snap = operations::snapshot(Path::new(&previous.path))?;
        let entry = snap
            .get("")
            .ok_or_else(|| conflict("Restored note missing"))?;
        if entry.fingerprint != previous.fingerprint {
            return Err(conflict(
                "Restored note changed before metadata reconciliation",
            ));
        }
        c.execute("INSERT OR REPLACE INTO document_outputs(vault_id,document_id,output_key,note_id,path,revision,fingerprint,physical_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![s.vault_id,b.plan.document_id,previous.key,previous.note_id,previous.path,previous.revision,entry.fingerprint,entry.identity]).map_err(err)?;
        let doc = load_document(c, s, &previous.revision)?;
        map_sources(c, s, &previous.path, &doc, None)?;
    }
    c.execute(
        "UPDATE document_imports SET state='undone' WHERE id=?1",
        [&b.plan.id],
    )
    .map_err(err)?;
    Ok(())
}
pub fn undo_import(c: &Connection, s: &Scope, id: &str) -> Result<serde_json::Value, String> {
    let (state, json): (String, String) = c
        .query_row(
            "SELECT state,payload FROM document_import_batches WHERE vault_id=?1 AND id=?2",
            params![s.vault_id, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(err)?;
    if state != "applied" {
        return Err(conflict("Batch is not available for undo"));
    }
    let b: Batch = serde_json::from_str(&json).map_err(err)?;
    check_folders(s, &b)?;
    for child in &b.children {
        operations::check_undo(c, s, child)?;
    }
    set_batch(c, id, "undoing", None)?;
    let result = (|| {
        for child in b.children.iter().rev() {
            operations::undo(c, s, child)?;
        }
        restore_mappings(c, s, &b)?;
        set_batch(c, id, "undone", None)
    })();
    if let Err(e) = result {
        set_batch(c, id, "recovery_required", Some(&e))?;
        return Err(format!("RECOVERY_REQUIRED: {e}"));
    }
    Ok(
        serde_json::json!({"operationId":id,"notePath":s.root,"relativePath":"document import","preview":"Restored the complete import batch","restoredVersion":null}),
    )
}
pub fn operation_views(
    c: &Connection,
    s: &Scope,
) -> Result<Vec<operations::OperationView>, String> {
    recover_batches(c, s)?;
    let mut q=c.prepare("SELECT id,state,json_extract(payload,'$.plan.options.name'),error FROM document_import_batches WHERE vault_id=?1 ORDER BY rowid DESC LIMIT 100").map_err(err)?;
    let rows = q
        .query_map([&s.vault_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    rows.into_iter()
        .map(|(id, state, name, error)| {
            Ok(operations::OperationView {
                id,
                tool: "document_import".into(),
                note_path: name,
                state: state.clone(),
                undo_available: state == "applied",
                error,
            })
        })
        .collect()
}
pub fn recheck_import(c: &Connection, s: &Scope, id: &str) -> Result<(), String> {
    let json:String=c.query_row("SELECT payload FROM document_import_batches WHERE id=?1 AND vault_id=?2 AND state='recovery_required'",params![id,s.vault_id],|r|r.get(0)).map_err(err)?;
    let b: Batch = serde_json::from_str(&json).map_err(err)?;
    for child in &b.children {
        let state: Option<String> = c
            .query_row(
                "SELECT state FROM knowledge_operations WHERE id=?1",
                [child],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        if state.is_some_and(|s| s.contains("recovery")) {
            operations::recheck(c, s, child)?;
        }
    }
    finish_import(c, s, &b)?;
    record_folders(c, s, id, &b)?;
    set_batch(c, id, "applied", None)
}
fn get_document_source_inner(
    app: tauri::AppHandle,
    block_id: String,
) -> Result<serde_json::Value, String> {
    let s = super::current(&app)?;
    let c = crate::db::init_db(&app)?;
    let(revision,document_block,recorded,current):(String,String,String,String)=c.query_row("SELECT p.revision,p.document_block_id,p.content_hash,b.hash FROM document_block_sources p JOIN knowledge_blocks b ON b.id=p.block_id JOIN knowledge_notes n ON n.id=b.note_id WHERE b.id=?1 AND n.vault_id=?2 AND n.deleted=0 AND b.deleted=0",params![block_id,s.vault_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|"No original document source is recorded for this block".to_string())?;
    let d = load_document(&c, &s, &revision)?;
    let block = d
        .blocks
        .iter()
        .find(|b| b.id == document_block)
        .ok_or("Recorded document block unavailable")?;
    let copy:Option<String>=c.query_row("SELECT json_extract(payload,'$.sourceCopy') FROM document_imports WHERE vault_id=?1 AND json_extract(payload,'$.revision')=?2 AND json_extract(payload,'$.sourceCopy') IS NOT NULL ORDER BY created_at DESC LIMIT 1",params![s.vault_id,revision],|r|r.get(0)).optional().map_err(err)?;
    let path = copy.as_deref().unwrap_or(&d.source.locator);
    let status = if d.source.fingerprint_kind != "bytes" {
        "web_snapshot"
    } else {
        match file_hash(Path::new(path)) {
            Ok(hash) if hash == d.source.content_hash => "available",
            Ok(_) => "changed",
            Err(_) => "missing",
        }
    };
    Ok(
        serde_json::json!({"blockId":block_id,"revision":revision,"title":d.title,"extractor":d.extractor,"extractorVersion":d.extractor_version,"location":block.location,"excerpt":block.markdown.chars().take(8000).collect::<String>(),"modified":recorded!=current,"source":d.source.locator,"sourceStatus":status,"retained":copy.is_some()}),
    )
}
pub fn pdf_source_path(app: &tauri::AppHandle, block_id: &str) -> Result<PathBuf, String> {
    let details = get_document_source_inner(app.clone(), block_id.to_string())?;
    if details["sourceStatus"] != "available" { return Err("Original source is missing or changed".into()); }
    let scope = super::current(app)?;
    let c = crate::db::init_db(app)?;
    let revision = details["revision"].as_str().ok_or("Missing revision")?;
    let copy: Option<String> = c.query_row("SELECT json_extract(payload,'$.sourceCopy') FROM document_imports WHERE vault_id=?1 AND json_extract(payload,'$.revision')=?2 AND json_extract(payload,'$.sourceCopy') IS NOT NULL LIMIT 1", params![scope.vault_id, revision], |r| r.get(0)).optional().map_err(err)?;
    let path = PathBuf::from(copy.unwrap_or_else(|| details["source"].as_str().unwrap_or_default().to_string()));
    if file_hash(&path)? != load_document(&c, &scope, revision)?.source.content_hash { return Err("Original source changed".into()); }
    Ok(path)
}
fn open_document_source_inner(app: tauri::AppHandle, block_id: String) -> Result<(), String> {
    let details = get_document_source_inner(app.clone(), block_id)?;
    if details["sourceStatus"] != "available" {
        return Err(
            "Original source is missing or changed; the stored excerpt remains available".into(),
        );
    }
    let s = super::current(&app)?;
    let c = crate::db::init_db(&app)?;
    let revision = details["revision"].as_str().unwrap();
    let copy:Option<String>=c.query_row("SELECT json_extract(payload,'$.sourceCopy') FROM document_imports WHERE vault_id=?1 AND json_extract(payload,'$.revision')=?2 AND json_extract(payload,'$.sourceCopy') IS NOT NULL LIMIT 1",params![s.vault_id,revision],|r|r.get(0)).optional().map_err(err)?;
    let path = copy.unwrap_or_else(|| details["source"].as_str().unwrap().to_string());
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    let doc = load_document(&c, &s, revision)?;
    if file_hash(Path::new(&path))? != doc.source.content_hash {
        return Err(conflict("Original source changed"));
    }
    command
        .arg(std::fs::canonicalize(path).map_err(err)?)
        .spawn()
        .map_err(err)?;
    Ok(())
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
                root,
                vault_id,
                generation: "session".into(),
            },
        )
    }
    fn document(s: &Scope, text: &str) -> PrismDocument {
        PrismDocument::new(
            "Source".into(),
            Source {
                locator: s.root.join("original.txt").to_string_lossy().into(),
                content_hash: model::hash(text.as_bytes()),
                kind: "file".into(),
                fingerprint_kind: "bytes".into(),
            },
            "fixture".into(),
            "1".into(),
            "settings".into(),
            vec![Fragment {
                markdown: text.into(),
                location: Some(model::Location {
                    page: Some(2),
                    ..Default::default()
                }),
            }],
        )
    }
    fn plan(c: &Connection, s: &Scope, doc: &PrismDocument) -> Plan {
        store_document(c, s, doc, "runtime").unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut p = Plan {
            id: id.clone(),
            revision: doc.revision.clone(),
            document_id: doc.id.clone(),
            generation: s.generation.clone(),
            token: String::new(),
            options: ImportOptions {
            require_existing_folder: false,
                name: "Imported".into(),
                folder: "Imported folder".into(),
                split_level: Some(2),
                keep_source: false,
                separate_copy: false,
                excluded_outputs: vec![],
            },
            outputs: vec![],
            retained: vec![],
            source_copy: None,
            batch_id: None,
            batch_label: None,
            batch_index: None,
        };
        regenerate(c, s, &mut p, doc).unwrap();
        c.execute("INSERT INTO document_imports(id,vault_id,job_id,state,payload) VALUES(?1,?2,?1,'review',?3)",params![id,s.vault_id,serde_json::to_string(&p).unwrap()]).unwrap();
        c.execute("INSERT INTO knowledge_jobs(id,vault_id,kind,dedup,priority,state,payload) VALUES(?1,?2,'DOCUMENT_IMPORT',?1,10,'waiting_for_approval','{}')",params![id,s.vault_id]).unwrap();
        p
    }
    fn publish(c: &Connection, s: &Scope, p: &Plan) -> String {
        let (id, b) = begin_batch(c, s, p).unwrap();
        apply_batch(c, s, &id, &b, || Ok(())).unwrap();
        id
    }
    #[test]
    fn batch_expansion_filters_and_mirrors_folders() {
        let root = tempfile::tempdir().unwrap();
        let research = root.path().join("Research");
        std::fs::create_dir_all(research.join("sub")).unwrap();
        std::fs::write(research.join("a.pdf"), b"a").unwrap();
        std::fs::write(research.join("notes.txt"), b"notes").unwrap();
        std::fs::write(research.join("ignore.bin"), b"ignore").unwrap();
        std::fs::write(research.join("sub").join("b.docx"), b"b").unwrap();
        std::fs::write(research.join("sub").join(".hidden.pdf"), b"hidden").unwrap();

        let request = BatchPrepareRequest {
            files: vec![],
            folders: vec![research.to_string_lossy().into()],
            include_subfolders: true,
            ocr: "A".into(),
            method: "yt-dlp".into(),
            folder: String::new(),
        };
        let (sources, skipped) = expand_batch_sources(&request).unwrap();
        assert!(skipped.is_empty());
        assert_eq!(sources.len(), 3);
        let names = sources
            .iter()
            .map(|source| {
                (
                    source.path.file_name().unwrap().to_string_lossy().to_string(),
                    source.suffix.clone(),
                )
            })
            .collect::<Vec<_>>();
        assert!(names.contains(&("a.pdf".into(), "Research".into())));
        assert!(names.contains(&("notes.txt".into(), "Research".into())));
        assert!(names.contains(&("b.docx".into(), "Research/sub".into())));

        let shallow = BatchPrepareRequest {
            files: vec![],
            folders: vec![research.to_string_lossy().into()],
            include_subfolders: false,
            ..request.clone()
        };
        let (sources, _) = expand_batch_sources(&shallow).unwrap();
        assert_eq!(sources.len(), 2);
        assert!(sources.iter().all(|source| !source.path.ends_with("b.docx")));

        let individual = BatchPrepareRequest {
            files: vec![research.join("a.pdf").to_string_lossy().into()],
            folders: vec![],
            include_subfolders: true,
            ocr: "A".into(),
            method: "yt-dlp".into(),
            folder: String::new(),
        };
        let (sources, _) = expand_batch_sources(&individual).unwrap();
        assert_eq!(sources.len(), 1);
        assert!(sources[0].suffix.is_empty());
    }
    #[test]
    fn batch_join_keeps_relative_mirror_paths() {
        assert_eq!(batch_join("Imported", "Research/Papers"), "Imported/Research/Papers");
        assert_eq!(batch_join("", "Research"), "Research");
        assert_eq!(batch_join("Imported", ""), "Imported");
        assert_eq!(batch_join("Imported/", ""), "Imported");
    }
    #[test]
    fn batch_plans_create_mirrored_folders_on_commit() {
        let (_d, db, s) = fixture();
        let c = &db.conn;
        let doc = document(&s, "Intro\n\n## Alpha\n\nFirst");
        let source = PreparedBatchSource {
            index: 1,
            path: s.root.join("original.txt"),
            title: "Q1".into(),
            source_hash: doc.source.content_hash.clone(),
            plan_folder: "Imported/Research/Papers".into(),
            plan_name: "Q1".into(),
            staged_stem: "0001__Q1".into(),
            text_direct: true,
            was_cached: false,
            document: None,
        };
        let p = create_batch_plan(c, &s, &doc, &source, "batch-1", "Research", "runtime")
            .unwrap();
        assert_eq!(p.options.folder, "Imported/Research/Papers");
        assert_eq!(p.batch_id.as_deref(), Some("batch-1"));
        assert_eq!(p.batch_index, Some(1));
        publish(c, &s, &p);
        assert!(s.root.join("Imported/Research/Papers/Q1.md").is_file());
    }
    #[test]
    fn imports_validate_an_existing_destination_folder_on_every_refresh() {
        let (_d, db, s) = fixture();
        let c = &db.conn;
        let doc = document(&s, "Intro\n\n## Alpha\n\nFirst");
        store_document(c, &s, &doc, "runtime").unwrap();
        let mut p = Plan {
            id: uuid::Uuid::new_v4().to_string(),
            revision: doc.revision.clone(),
            document_id: doc.id.clone(),
            generation: s.generation.clone(),
            token: String::new(),
            options: ImportOptions {
                require_existing_folder: true,
                name: "Imported".into(),
                folder: "Chosen".into(),
                split_level: Some(2),
                keep_source: false,
                separate_copy: false,
                excluded_outputs: vec![],
            },
            outputs: vec![],
            retained: vec![],
            source_copy: None,
            batch_id: None,
            batch_label: None,
            batch_index: None,
        };
        // A selected folder that is not (or no longer) available fails the
        // preview instead of silently importing into the vault root.
        let error = regenerate(c, &s, &mut p, &doc).unwrap_err();
        assert!(error.contains("Destination folder is unavailable"));
        std::fs::create_dir_all(s.root.join("Chosen")).unwrap();
        regenerate(c, &s, &mut p, &doc).unwrap();
        assert!(p
            .outputs
            .iter()
            .all(|o| crate::path_util::relative_to(&s.root, Path::new(&o.path))
                .is_some_and(|relative| relative.starts_with("Chosen"))));
        std::fs::remove_dir_all(s.root.join("Chosen")).unwrap();
        assert!(regenerate(c, &s, &mut p, &doc).is_err());
        // Plans that never selected a folder keep creating their historical destination.
        p.options.require_existing_folder = false;
        p.options.folder = "Imported folder".into();
        regenerate(c, &s, &mut p, &doc).unwrap();
    }
    #[test]
    fn reviewed_split_identity_provenance_restart_and_batch_undo() {
        let (_d, db, s) = fixture();
        let c = &db.conn;
        let doc = document(&s, "Intro 🦀\n\n## Alpha\n\nFirst\n\n## Beta\n\nSecond");
        let p = plan(c, &s, &doc);
        assert_eq!(p.outputs.len(), 3);
        assert!(!Path::new(&p.outputs[0].path).exists());
        super::super::jobs::recover(c).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT state FROM knowledge_jobs WHERE id=?1",
                [&p.id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "waiting_for_approval"
        );
        let id = publish(c, &s, &p);
        recover_batches(c, &s).unwrap();
        assert!(operation_views(c, &s).unwrap()[0].undo_available);
        let provenance: i64 = c
            .query_row("SELECT count(*) FROM document_block_sources", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(provenance >= 5);
        let before = output_rows(c, &s, &doc.id).unwrap();
        let revised = document(
            &s,
            "Intro 🦀\n\n## Alpha\n\nFirst revised\n\n## Beta\n\nSecond",
        );
        let p2 = plan(c, &s, &revised);
        assert!(p2.outputs.iter().all(|o| o.conflict.is_none()));
        let id2 = publish(c, &s, &p2);
        let after = output_rows(c, &s, &doc.id).unwrap();
        assert!(before
            .iter()
            .zip(&after)
            .all(|(a, b)| a.note_id == b.note_id));
        undo_import(c, &s, &id2).unwrap();
        assert_eq!(
            std::fs::read_to_string(&p.outputs[1].path).unwrap(),
            p.outputs[1].output.markdown
        );
        // A previous operation's physical postimage has been superseded by reimport.
        assert!(undo_import(c, &s, &id).is_err());
        assert!(undo_import(c, &s, &id2).is_err());
    }
    #[test]
    fn edited_moved_deleted_replaced_and_occupied_outputs_block_whole_plan() {
        for action in ["edit", "move", "delete", "replace"] {
            let (_d, db, s) = fixture();
            let c = &db.conn;
            let doc = document(&s, "Intro\n\n## One\n\nBody");
            let p = plan(c, &s, &doc);
            let id = publish(c, &s, &p);
            let path = &p.outputs[1].path;
            match action {
                "edit" => std::fs::write(path, "User changes").unwrap(),
                "move" => std::fs::rename(path, s.root.join("moved.md")).unwrap(),
                "delete" => std::fs::remove_file(path).unwrap(),
                _ => operations::atomic_write(
                    Path::new(path),
                    p.outputs[1].output.markdown.as_bytes(),
                    false,
                )
                .unwrap(),
            }
            let again = plan(c, &s, &doc);
            assert!(again.outputs[1].conflict.is_some(), "{action}");
            assert!(begin_batch(c, &s, &again).is_err());
            assert!(undo_import(c, &s, &id).is_err());
            assert!(Path::new(&p.outputs[0].path).is_file());
            let mut separate = again;
            separate.options.separate_copy = true;
            separate.options.name = "Separate".into();
            regenerate(c, &s, &mut separate, &doc).unwrap();
            assert!(separate.outputs.iter().all(|o| o.conflict.is_none()));
        }
        let (_d, db, s) = fixture();
        let doc = document(&s, "Intro");
        let p = plan(&db.conn, &s, &doc);
        std::fs::create_dir_all(Path::new(&p.outputs[0].path).parent().unwrap()).unwrap();
        std::fs::write(&p.outputs[0].path, "Unrelated").unwrap();
        assert!(begin_batch(&db.conn, &s, &p).is_err());
        assert_eq!(
            std::fs::read_to_string(&p.outputs[0].path).unwrap(),
            "Unrelated"
        );
    }
    #[test]
    fn publication_failures_retain_evidence_and_do_not_replay() {
        let (_d, db, s) = fixture();
        let c = &db.conn;
        let doc = document(&s, "Intro\n\n## One\n\nBody");
        let p = plan(c, &s, &doc);
        let (id, b) = begin_batch(c, &s, &p).unwrap();
        let mut count = 0;
        assert!(apply_batch(c, &s, &id, &b, || {
            count += 1;
            if count == 2 {
                Err("Injected cancellation".into())
            } else {
                Ok(())
            }
        })
        .is_err());
        recover_batches(c, &s).unwrap();
        assert!(Path::new(&p.outputs[0].path).is_file());
        assert!(!Path::new(&p.outputs[1].path).exists());
        assert_eq!(
            operation_views(c, &s).unwrap()[0].state,
            "recovery_required"
        );
        let json: String = c
            .query_row(
                "SELECT payload FROM document_import_batches WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(json.contains("Body"));
    }
    #[test]
    fn reconciliation_failure_is_recoverable_and_cannot_adopt_external_edits() {
        let (_d, db, s) = fixture();
        let c = &db.conn;
        let doc = document(&s, "Intro");
        let p = plan(c, &s, &doc);
        let (id, b) = begin_batch(c, &s, &p).unwrap();
        c.execute_batch("CREATE TRIGGER fail_mapping BEFORE INSERT ON document_outputs BEGIN SELECT RAISE(FAIL,'injected'); END").unwrap();
        assert!(apply_batch(c, &s, &id, &b, || Ok(())).is_err());
        c.execute_batch("DROP TRIGGER fail_mapping").unwrap();
        recover_batches(c, &s).unwrap();
        assert!(operation_views(c, &s).unwrap()[0].undo_available);
        std::fs::write(&p.outputs[0].path, "External edit").unwrap();
        assert!(finish_import(c, &s, &b).is_err());
        assert!(undo_import(c, &s, &id).is_err());
    }
    #[test]
    fn cache_verification_quota_pins_and_revision_identity() {
        let (_d, db, s) = fixture();
        let c = &db.conn;
        let d = document(&s, "First");
        store_document(c, &s, &d, "runtime").unwrap();
        assert_eq!(
            load_document(c, &s, &d.revision).unwrap().markdown(),
            "First"
        );
        let path: String = c
            .query_row(
                "SELECT artifact FROM document_revisions WHERE revision=?1",
                [&d.revision],
                |r| r.get(0),
            )
            .unwrap();
        std::fs::write(&path, b"corrupt").unwrap();
        assert!(load_document(c, &s, &d.revision)
            .unwrap_err()
            .starts_with("CACHE_CORRUPT"));
        store_document(c, &s, &d, "runtime").unwrap();
        let other = document(&s, "Second");
        let p = plan(c, &s, &other);
        evict_to(c, &s, 0).unwrap();
        assert!(load_document(c, &s, &d.revision).is_err());
        assert!(load_document(c, &s, &p.revision).is_ok());
        let id = publish(c, &s, &p);
        evict_to(c, &s, 0).unwrap();
        assert!(load_document(c, &s, &p.revision).is_ok());
        undo_import(c, &s, &id).unwrap();
        assert!(load_document(c, &s, &p.revision).is_ok());
        let changed = PrismDocument::new(
            d.title.clone(),
            Source {
                locator: "/another.txt".into(),
                ..d.source.clone()
            },
            d.extractor.clone(),
            d.extractor_version.clone(),
            d.settings_fingerprint.clone(),
            vec![Fragment {
                markdown: "First".into(),
                location: None,
            }],
        );
        assert_ne!(changed.revision, d.revision);
    }
    #[test]
    fn batch_undo_blocks_unexpected_files_and_explicit_recovery_rolls_back_partial_publication() {
        let (_d, db, s) = fixture();
        let c = &db.conn;
        let doc = document(&s, "Intro\n\n## One\n\nBody");
        let p = plan(c, &s, &doc);
        let (id, b) = begin_batch(c, &s, &p).unwrap();
        let mut calls = 0;
        assert!(apply_batch(c, &s, &id, &b, || {
            calls += 1;
            if calls == 2 {
                Err("injected".into())
            } else {
                Ok(())
            }
        })
        .is_err());
        recover_batches(c, &s).unwrap();
        rollback_interrupted(c, &s, &id).unwrap();
        assert!(p.outputs.iter().all(|o| !Path::new(&o.path).exists()));
        let mut next = plan(c, &s, &doc);
        next.options.folder = "Another folder".into();
        regenerate(c, &s, &mut next, &doc).unwrap();
        let id = publish(c, &s, &next);
        std::fs::write(s.root.join("Another folder/user-file.txt"), "User content").unwrap();
        assert!(undo_import(c, &s, &id).is_err());
        assert!(next.outputs.iter().all(|o| Path::new(&o.path).is_file()));
    }
    #[test]
    fn stale_session_refresh_and_retained_outputs() {
        let (_d, db, s) = fixture();
        let doc = document(&s, "Intro\n\n## One\n\nFirst\n\n## Two\n\nSecond");
        let p = plan(&db.conn, &s, &doc);
        publish(&db.conn, &s, &p);
        let mut again = plan(&db.conn, &s, &doc);
        again.options.split_level = None;
        regenerate(&db.conn, &s, &mut again, &doc).unwrap();
        assert_eq!(again.retained.len(), 2);
        let restarted = Scope {
            generation: "next-session".into(),
            ..s.clone()
        };
        assert!(summary(&again, "review", &restarted).needs_refresh);
        let old_token = again.token.clone();
        regenerate(&db.conn, &restarted, &mut again, &doc).unwrap();
        assert_ne!(old_token, again.token);
        assert!(!summary(&again, "review", &restarted).needs_refresh);
    }
}

fn list_note_document_sources_inner(
    app: tauri::AppHandle,
    path: String,
    offset: Option<usize>,
) -> Result<serde_json::Value, String> {
    let s = super::current(&app)?;
    let c = crate::db::init_db(&app)?;
    let offset = offset.unwrap_or(0).min(i64::MAX as usize) as i64;
    let total:i64=c.query_row("SELECT count(*) FROM document_block_sources p JOIN knowledge_blocks b ON b.id=p.block_id JOIN knowledge_notes n ON n.id=b.note_id WHERE n.vault_id=?1 AND n.path=?2 AND n.deleted=0 AND b.deleted=0",params![s.vault_id,path],|r|r.get(0)).map_err(err)?;
    let mut q=c.prepare("SELECT b.id,substr(b.text,1,160),b.start_line FROM document_block_sources p JOIN knowledge_blocks b ON b.id=p.block_id JOIN knowledge_notes n ON n.id=b.note_id WHERE n.vault_id=?1 AND n.path=?2 AND n.deleted=0 AND b.deleted=0 ORDER BY b.ordinal LIMIT 100 OFFSET ?3").map_err(err)?;
    let entries=q.query_map(params![s.vault_id,path,offset],|r|Ok(serde_json::json!({"blockId":r.get::<_,String>(0)?,"excerpt":r.get::<_,String>(1)?,"line":r.get::<_,i64>(2)?}))).map_err(err)?.collect::<Result<Vec<_>,_>>().map_err(err)?;
    Ok(serde_json::json!({"entries":entries,"offset":offset,"total":total}))
}

/// Explicit recovery only: first validate every recorded file, then reverse known
/// published children. Missing/unpublished children are never replayed.
fn rollback_interrupted(c: &Connection, s: &Scope, id: &str) -> Result<(), String> {
    operations::recover(c, s)?;
    let (state, json): (String, String) = c
        .query_row(
            "SELECT state,payload FROM document_import_batches WHERE id=?1 AND vault_id=?2",
            params![id, s.vault_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(err)?;
    if !["recovery_required", "rolling_back"].contains(&state.as_str()) {
        return Err(conflict("Import does not require recovery"));
    }
    let b: Batch = serde_json::from_str(&json).map_err(err)?;
    let mut applied = vec![];
    for (output, child) in b.plan.outputs.iter().zip(&b.children) {
        let mut state: Option<String> = c
            .query_row(
                "SELECT state FROM knowledge_operations WHERE id=?1 AND vault_id=?2",
                params![child, s.vault_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        if state.as_ref().is_some_and(|s| s.contains("recovery")) {
            operations::recheck(c, s, child)?;
            state = c
                .query_row(
                    "SELECT state FROM knowledge_operations WHERE id=?1",
                    [child],
                    |r| r.get(0),
                )
                .optional()
                .map_err(err)?;
        }
        match state.as_deref(){
   Some("applied")=>{operations::check_undo(c,s,child)?;applied.push(child);},
   None|Some("aborted")=>operations::verify(s,output.mutation.as_ref().ok_or("Missing recovery evidence")?,false,true)?,
   Some("undone")=>operations::check_restored(c,s,child)?,
   _=>return Err("RECOVERY_REQUIRED: Ambiguous file state. Recovery data is retained; resolve changed files before rolling back.".into()),
  }
    }
    set_batch(c, id, "rolling_back", None)?;
    let result = (|| {
        for child in applied.iter().rev() {
            operations::undo(c, s, child)?;
        }
        restore_mappings(c, s, &b)?;
        c.execute(
            "UPDATE knowledge_jobs SET state='cancelled',error=NULL WHERE id=?1",
            [&b.plan.id],
        )
        .map_err(err)?;
        set_batch(c, id, "undone", None)
    })();
    if let Err(e) = result {
        set_batch(c, id, "recovery_required", Some(&e))?;
        return Err(format!("RECOVERY_REQUIRED: {e}"));
    }
    Ok(())
}
fn recover_document_import_inner(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let _guard = operations::lock()?;
    let s = super::current(&app)?;
    let c = crate::db::init_db(&app)?;
    let operation:String=c.query_row("SELECT id FROM document_import_batches WHERE vault_id=?1 AND json_extract(payload,'$.plan.id')=?2 AND state IN ('recovery_required','rolling_back') ORDER BY rowid DESC LIMIT 1",params![s.vault_id,id],|r|r.get(0)).map_err(err)?;
    rollback_interrupted(&c, &s, &operation)?;
    super::emit(&app, &c, &s.vault_id, "document_import_rolled_back", &id)
}

#[tauri::command]
pub async fn list_document_imports(app: tauri::AppHandle) -> Result<Vec<ImportSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || list_document_imports_inner(app))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn get_document_preview(
    app: tauri::AppHandle,
    id: String,
    offset: Option<usize>,
    limit: Option<usize>,
    content_offset: Option<usize>,
) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        get_document_preview_inner(app, id, offset, limit, content_offset)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn update_document_import(
    app: tauri::AppHandle,
    id: String,
    options: ImportOptions,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || update_document_import_inner(app, id, options))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn commit_document_import(
    app: tauri::AppHandle,
    id: String,
    token: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || commit_document_import_inner(app, id, token))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn get_document_source(
    app: tauri::AppHandle,
    block_id: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || get_document_source_inner(app, block_id))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn open_document_source(app: tauri::AppHandle, block_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_document_source_inner(app, block_id))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn list_note_document_sources(
    app: tauri::AppHandle,
    path: String,
    offset: Option<usize>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_note_document_sources_inner(app, path, offset)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn recover_document_import(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || recover_document_import_inner(app, id))
        .await
        .map_err(err)?
}

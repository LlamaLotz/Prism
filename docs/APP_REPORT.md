# Prism — Full Application Report

**Version:** `v1.1.26` (working tree on `main`, post-`v1.1.25` tag)
**Date:** 2026-10-12
**Scope:** high-level + in-depth technical analysis of product, architecture, frontend, backend, data, AI/privacy, build/release, testing, risks and roadmap
**Method:** static source read of `README.md`, `PRODUCT_SCOPE.md`, `docs/v2-runtime.md`, `package.json`, `src/App.tsx`, `src/components/*`, `src/services/*`, `src/types/index.ts`, `src/defaultSettings.ts`, `src-tauri/src/*` (incl. `knowledge/*`, `engine/*`, `linker/*`, `db/*`, `study/*`), configs, tests, scripts and workflows. No runtime execution except read-only `git`/file inventory.

> Version note: `package.json:2` and `src-tauri/tauri.conf.json:4` still declare `1.0.0`, `src-tauri/Cargo.toml:3` declares `0.1.0`. Release identity comes from git tags (`v1.1.25` latest, `v1.1.26` unreleased). Working tree has uncommitted changes in `src/App.tsx`, `src/components/Editor.tsx`, `GraphView.tsx`, `SettingsPage.tsx`, `TitleBar.tsx`, `ResizeHandle.tsx`, `src-tauri/src/knowledge/agent.rs`, `menu.rs`, `study/mod.rs`. Treat manifests as stale — see §17.

---

## 1. Executive summary

Prism is a **local-first personal knowledge workspace** for students, researchers and note-takers. Tagline from `README.md:3-7`: turn your own notes and sources into connected, searchable knowledge you control. Markdown files remain canonical and user-owned.

Core loop (`PRODUCT_SCOPE.md:3`): **capture → find → connect → ask → save**.

What it is technically:

- **Desktop app** built on **Tauri v2 + React 19 + Vite 8 + Tailwind CSS 4**, Rust backend + webview frontend.
- **Vault-scoped Rust Knowledge Runtime** backed by SQLite (`prism_vault.db`): stable note/block IDs, FTS5 lexical search, local ONNX embeddings (`bge-base-en-v1.5` via vendored `fastembed`), HNSW vector search, hybrid RRF retrieval, agent tool bus with approval-gated writes and journaled undo.
- **No backend server, no account, no cloud store.** Optional AI routes through user-configured providers (27-entry registry) with explicit privacy gating in Rust. Default privacy is `AskBeforeCloud`.
- **Ingestion is staged + reviewed:** source → staged extraction → `PrismDocument v1` → persisted review → journaled Markdown publication. Never direct-to-vault.
- **Native Notebook/Study workspace** replaces the removed vendored Open Notebook Python server (deliberate removal, `PRODUCT_SCOPE.md:11-20`).

Scale of codebase (measured):

- `src/`: ~129 files, ~16k+ lines in core `App/types/services` slice alone. `src/App.tsx` 1,100+ lines, `src/components/Editor.tsx` 2,868 lines, `src/components/SettingsPage.tsx` 1,991 lines.
- `src-tauri/src/`: 55 `.rs` files, ~14,691 lines. Largest: `knowledge/agent.rs` (1,933), `knowledge/documents.rs` (1,924), `db.rs` (1,679), `lib.rs` (2,392), `knowledge/operations.rs` (1,393), `knowledge/retrieval.rs` (968), `engine/embeddings.rs` (1,293+).
- Tests: Rust `cargo test` units in nearly every knowledge module + Playwright suite (`tests/notebook/*.spec.ts`, 16 specs) + ingest contracts.

---

## 2. Product vision and scope

Sources: `README.md:1-18`, `PRODUCT_SCOPE.md:1-34`, `docs/v2-runtime.md:1-100`.

### 2.1 Positioning

- Local-first, file-first. Markdown notes remain files you control. SQLite is an index, not the source of truth.
- Audience: students, researchers, anyone working with own notes/sources.
- Free, under active development.

### 2.2 Navigation model (`README.md:9-16`)

- **Notes** = main workspace (notes, search, imports, connections). AI assistant directly accessible.
- **More** = Graph, Topics, Split View, Notebook. Shortcuts + native menu entries preserved.
- **Notebook** = Research, Search, Chats prominent; **Tools** = Transform, Podcasts, Manage.
- AI settings keep privacy + primary provider visible; **Advanced AI settings** = per-feature routing + idle-model tuning.
- New installs start in Notes, 2D graphs by default. Existing prefs/features/notebooks/conversations/data preserved.

### 2.3 Scope guardrails (`PRODUCT_SCOPE.md`)

- **Simplification without removal:** grouping ≠ disabling. Preserve features, data, prefs, shortcuts, Notebook, graph views, advanced AI config. No storage merge or AI-permission change as part of UI cleanup.
- **Notebook definition:** Prism-native notebook only (library + Sources/Chat/Studio workspace + study materials from selected vault notes). One notebook.
- **Removed: Open Notebook integration** — vendored Python runtime, `notebook_*` commands, own DB, upload pipeline, transforms/podcast screens. Gone deliberately, not planned, not to be reinstated under this doc. Cost recorded:
  - sources/transforms/podcast/job screens gone; podcast audio generation gone (transcripts + saved audio kept).
  - study export now only podcast `.mp3` (plain Rust copy); other formats report missing runtime.
  - old Open Notebook data stays on disk but unreachable; linked conversations keep rows, adopt Prism stored messages, no server refresh.
- **Planned work stays eligible:** OpenClaw, V2 architecture, study tools under their specs. No blanket freeze.
- **Additions require justification:** workflow improved + evidence, why existing insufficient, nav/onboarding + maintenance cost, data/privacy/compat preservation. Prefer improving existing over new destinations.

---

## 3. Tech stack and repo layout

### 3.1 Stack

| Layer | Choice | Evidence |
|---|---|---|
| Desktop shell | Tauri 2.11 (`tauri`, `tauri-plugin-log/http/updater`) | `src-tauri/Cargo.toml:24-31`, `src-tauri/tauri.conf.json:1-73` |
| Frontend | React 19.2, Vite 8.2, Tailwind 4.3, TypeScript 7 | `package.json:39-57`, `vite.config.ts:1-28` |
| Editor | CodeMirror 6 (commands/state/view/lang-markdown/theme-one-dark) | `package.json:23-28` |
| Graph | D3 7.9, `react-force-graph-3d`, `three` | `package.json:35-44` |
| Markdown | `react-markdown` | `package.json:42` |
| AI SDKs | `openai` 7.4, `@google/genai` 2.19 (frontend compat) — actual dispatch in Rust via `reqwest` | `package.json:29-38`, `knowledge/models.rs:210-366` |
| Icons/UI | `lucide-react`, `clsx`+`tailwind-merge`, `ldrs` | `package.json:34-43` |
| Local ML | vendored `fastembed` + `ort-sys` ONNX, `hnsw_rs` 0.3, `rayon` | `Cargo.toml:57-60` |
| DB | `rusqlite` 0.31 (`bundled`, `backup`), FTS5, WAL | `Cargo.toml:41`, `db.rs:242-380`, `knowledge/schema.rs:48-79` |
| FS watch | `notify` 6.1 | `Cargo.toml:46`, `watcher.rs:1-91` |
| Dialogs | `rfd` 0.15 native file/folder pickers | `Cargo.toml:37`, `lib.rs:628-649` |
| Secrets | `keyring` 3 (OS credential store) | `Cargo.toml:32`, `config.rs:437-466` |
| Tests | Playwright 1.63, `cargo test`, `tsc` | `package.json:47`, `playwright.config.ts:1-9` |

### 3.2 Top-level layout

```
Prism/
  src/                 # React frontend (App, components, services, utils, types)
  src-tauri/src/       # Rust backend (lib, config, db, engine, linker, knowledge, study, watcher, menu)
  src-tauri/vendor/    # vendored fastembed + hf-hub patches
  src-tauri/capabilities/, gen/, icons/, windows/
  docs/v2-runtime.md   # runtime contract (this report adds APP_REPORT.md)
  scripts/             # ingest + ONNX helpers (benchmark, fixtures, stage-dev-runtime, verify)
  tests/notebook/      # Playwright specs + harnesses
  public/, Fonts/, Loaders/, Logo's/, Extractor Final/
  dist/, output/, prism_output/, test-results/
```

`src/` counts: 31 `*.tsx` in `components/`, 7 in `components/study/`, 5 in `components/ui/`, 21 entries in `services/`, 9 in `utils/`.

`src-tauri/src/` modules: `bin/`, `db/` (`chat.rs`, `history.rs`), `engine/` (`embeddings.rs`, `formatter.rs`, `indexer.rs`), `ingest/`, `knowledge/` (12 files), `linker/` (5 files), `study/` (5 files), plus `config.rs`, `db.rs`, `document_model.rs`, `lib.rs`, `main.rs`, `menu.rs`, `native_ingest.rs`, `watcher.rs`.

---

## 4. System architecture

### 4.1 High-level

```
┌─ React WebView (Vite) ─────────────────────────┐
│ App.tsx orchestration                          │
│ Editor (CodeMirror) │ Sidebar │ Graph 2D/3D │ Topics │
│ AISidebar │ Notebook/Study │ Settings │ Ingest/Review │
│ services/* (invoke wrappers)                   │
└────────────── Tauri IPC (invoke/events) ───────┘
┌─ Rust Core (Tauri commands) ───────────────────┐
│ index_vault │ write/read/create/rename/delete  │
│ Knowledge Runtime (vault scope, generation)     │
│ SQLite prism_vault.db (notes/blocks/fts/edges/ │
│  jobs/events/operations/documents/chat)        │
│ Embeddings (ONNX bge-base) + HNSW │ Linker     │
│ Retrieval planner │ Agent bus │ Models gateway │
│ Watcher (notify) │ Indexer pool │ Jobs sched.  │
│ Config (~/.prism/settings.json) + keyring      │
└────────────── OS FS ──────────────────────────┘
  Vault/*.md (canonical) │ .prism/documents/ │ ~/.prism/models cache
```

Key invariants:

- Markdown is canonical; SQLite is derived. No migration writes IDs into Markdown (`docs/v2-runtime.md:9-14`).
- All AI-adjacent reads go through Knowledge Runtime; all writes go through mutation coordinator + approval + journal.
- IPC is metadata-light: `index_vault` returns `IndexedVault {files, folders}` without contents (`types/index.ts:171-177`); contents lazy-load via `readFile`. Graph is content-free (`getGraph` → `GraphPayload {nodes, links}`).

### 4.2 IPC surface (selected)

Frontend wrapper `tauriAPI` in `src/types/index.ts:159-348` maps to Rust commands in `src-tauri/src/lib.rs` + `knowledge/*`:

- Vault: `index_vault`, `get_graph`, `get_backlinks_for_note`, `readFile`/`writeFile`, `create/delete/rename` file/folder, `select_file/folder`.
- Versions: `record_note_version`, `get_all_reconstructed_versions`, `purge_expired_history`.
- Knowledge: `knowledge_snapshot`, `get_knowledge_blocks`, `search_knowledge`, `get_relations`, `plan_retrieval`/`get_context`, `list_knowledge_jobs`/`cancel_knowledge_job`, `execute_model`, `list/resolve_approval`.
- Agent: `agent_list_tools/call_tool/list_pending/resolve_pending/list_operations/undo_operation/undo_last/recheck_operation`.
- Documents: `prepare/list/get_preview/update/commit/recover_document_import`, `list_note_document_sources/get/open_document_source`.
- Study/chat: `study_request/export`, `create/list/rename/delete_chat_session`, `get/append/replace_chat`, `unlink_notebook_session`.
- System: `get/save_runtime_config`, `relaunch_app`, `web_search` (DuckDuckGo keyless), ingestion script/extractor commands.

Events: `knowledge-event {sequence, vaultId, kind, entityId}`, `vault-changed {path, kind}`, `ingestion-progress/error`, `study-chat-delta/phase`, `menu://*`.

### 4.3 Startup sequence (`src/App.tsx:97-850`)

1. Load `RuntimeConfig` from Rust (`~/.prism/settings.json`); first-run migrates `localStorage`, persists to Rust; migrates legacy amber `#feb05d` → `#38BDF8`; applies startup-only appearance (view, AI panel, sidebar collapsed).
2. `fetchNotes()` → `index_vault(path)` (bounded pool, no contents) → sort + custom order → H1 sync (once per vault, `syncH1OnStartup`) → semantic backfill (once, during static splash) → start/stop `notify` watcher (`watchVault`).
3. Splash gating: `settingsReady + vaultReady + backfillDone` → play video (6,960 ms) → mount heavy UI; 15 s hard timeout fallback.
4. Lazy-load active note content (`readFile`); debounced graph reload (1 s typing pause, signature skip if identical); debounced/coalesced embeddings on save (`embedDebounceMs` default 4,000 ms, 200 KB cap).

---

## 5. Frontend in depth

### 5.1 `src/App.tsx` — orchestrator

- Owns `settings`, `notes`, `folders`, `activeNote`, `layout: AppPage ('editor'|'graph'|'split'|'topics'|'notebook')`, panel sizes, AI/sidebar collapsed, context menu, ingestion logs, graph snapshot, `semanticTick`, `embeddingError`.
- Helpers: `deepMergeSettings` (old configs never leave undefined), `graphSignature` (skip identical D3 reloads), `scheduleEmbedding` (coalesce rapid autosaves, never overlap per note), `navigateWorkspace` (smart split promotion), `handleSaveContent/NewNote/NewFolder/RunIngest/SelectVault/SaveSettings`.
- Native menu bridge (`menu://open-settings/reload-app/new-note/new-folder/open-prism/set-layout/toggle-*`) via `listen` (`App.tsx:542-612`, `menu.rs:150-233`).
- Safety: disables WebView2 default context menu (custom dark menu, `App.tsx:419-481`), blocks browser-only shortcuts (Alt+←/→, F5/F3/F12, Ctrl+P/R/O/U/N/T/W/H/D/G/E/J, zoom, tab-switch) while leaving app keybindings intact.

### 5.2 Editor (`src/components/Editor.tsx`, 2,868 lines)

- CodeMirror 6 edit + markdown preview, autosave (`autosaveDebounceMs` 800 ms), full-render threshold (8,000 lines), find debounce.
- LinkHub integration (`LinkHub.tsx` 709 lines): unlinked mentions, backlinks, semantic related, block matches, outbound links, denied/hidden tabs, approve/deny flows.
- Version Time Machine (`VersionHistoryRuler.tsx` 470 lines): base + deltas reconstructed full-content; explicit-save/note-switch/unmount/formatter/30 s idle triggers, never per-autosave.
- Guards: `LARGE_NOTE_CHARS` disables heavy paths; oversized notes skip per-save mention rescan (mirrors Rust `LARGE_NOTE_CHARS` in `lib.rs:786`).
- Formatter, H1 sync, alias extraction, keyword (`---kw---`) bookkeeping, CodeMirror undo/redo toolbar, flash-highlight, block scroll requests.

### 5.3 Sidebar (`Sidebar.tsx` 689 lines) + related

- Folder tree from `folders` (incl. empty), custom note order (`prism_order_<path>`), folder reveal, move dialog (`FolderPicker.tsx`), rename/delete via context menu.
- `LinkerToolbar.tsx`, `NoteGraphWorkspace.tsx` (74 lines wrapper), `ResizeHandle.tsx`, `sidebar-panels.css`.

### 5.4 Graph + Topics

- `GraphViewContainer.tsx`: 2D/3D switch (persisted `GRAPH_MODE_KEY`, default `2d`), passes content-free snapshot.
- `GraphView.tsx` (732): D3 force-graph, single-transaction snapshot read to avoid `node not found` races (`db.rs:940-999`).
- `GraphView3D.tsx` (626): `react-force-graph-3d` + `three`, label quality, auto-rotate, node color theming.
- `TopicsView.tsx` (165): `@tag` groups from `tags` table (`db.rs:382-440`); boundary rule ignores `text@topic`.

### 5.5 AI Sidebar (`AISidebar.tsx`, 828 lines)

- `sendChatMessageWithRetrieval`: `plan_retrieval({query, activeNoteId})` → append `contextText` (vault block with `[[path]]`/`[[path#^anchor]]` hints) to system prompt → `execute_model`. Privacy gating only at `execute_model` time; retrieval itself local/offline.
- Renders ≤6 citation chips (`[[path]]` pill + `^anchor`/`blockId`, hover full source), amber `degraded` banner on lexical fallback.
- Agent mode: manual JSON + model-driven read/preview loop; write tools stop at preview + approval gate; `Approve for me` auto-approve toggle; abort controller per request; web-search mode; chat library persistence with collapse threshold (50 chars, `knowledge.ts:43`).
- `AIEnhancements.tsx`, `AIRoutingSettings.tsx`, `ModelServiceRecovery.tsx`, `ui/PromptBar.tsx`, `ui/ModelPicker.tsx`, `ui/AiStatusLine.tsx`.

### 5.6 Notebook / Study (`components/study/*`, `services/study.ts` 118 lines)

- `StudyWorkspace.tsx` (90), `AssistantWorkspace.tsx` (12), `NotebookLibrary.tsx` (96), `SharedChat.tsx` (51), `StudyPanels.tsx` (73), `ArtifactView.tsx` (46), `AgentReview.tsx` (44).
- Concepts: collections (`{id,title,sourceIds,revision}`), sources (`{title,path,hash,text,missing}`), snapshots (context + excerpts), artifacts (`table|quiz|flashcards|podcast|slides|mindmap` — `slides` retained for compat), reviews/attempts, managed sessions.
- `studyRequest(vaultPath, action, payload)` → `study_request` command; export via `study_export` (only `.mp3` fully works post-Open-Notebook removal).
- Shared streaming state: `study-chat-delta/phase` events, per-vault stores, activity ledger (`running|done|failed|cancelled`).

### 5.7 Settings (`SettingsPage.tsx`, 1,991 lines)

Sections (`SectionId`: `general|ai|appearance|editor|linking|system`):

- General: vault path, ingestion engine/script.
- AI: provider registry (27 providers, see §8), base URL (locked when `canEditBaseUrl=false`), key format soft warnings, model ID exactness warning, per-task routes (`models.routes`), privacy mode, idle seconds, user profile injection.
- Appearance: `themeStyle (industrial|glass|gloss)`, `themeMode (dark|light)`, startup view, graph mode, background pattern/environment (`none|solar-system|stars|clouds`), AI panel/sidebar startup, LinkHub defaults, label quality, auto-rotate, accent/hover/graph colors, app icon data-URL, sidebar status `{date|time}`, gloss opacity.
- Editor: autosave/full-render/find debounces.
- Linking: auto-link, similarity threshold (default 0.70), embed debounce, backfill on open, threads/batch, persist positions.
- System: watch vault, H1 sync, retention days.

### 5.8 Ingest / Review / Jobs UI

- `IngestModal.tsx`: URL/file ingest, `yt-dlp` method, folder target → `documents.prepare` → review request.
- `DocumentImports.tsx` + `ReviewWindow.tsx` (196): paged review (≤100 outputs, 8k chars/excerpt), H2 split default, exclude sections, settings-change invalidation, restart/vault-switch refresh.
- `RuntimeActivity.tsx` (95) + `IngestionLogPanel.tsx` + `services/ingestionStore.ts` (199): jobs list (latest 100), progress, cancel, approvals polling + events.

### 5.9 Chrome / system UI

- `TitleBar.tsx` (302): frameless (`decorations:false`, transparent), window controls, AI/sidebar toggles.
- `NavigationMenu.tsx` (77), `ContextMenu.tsx`, `DialogProvider.tsx` (replaces `alert/confirm/prompt`), `ErrorBoundary.tsx`, `SplashScreen.tsx` (186), `UpdateBanner.tsx` (149, updater plugin), `LiquidGlass.tsx`/`LiquidGlossDefs.tsx`/`runtime.css`, `VersionHistoryRuler.tsx`.
- `utils/`: `accentColor`, `sidebarLayout`, `formatter`, `markdownParser`, `errors`, `keywords`, `largeText`, `splitter`, `agentIntent`.

---

## 6. Backend (Rust) in depth

### 6.1 `lib.rs` (2,392 lines) — command surface

- `AppState {linker, db_path, watcher_path/stop, embeddings (memoized Result), embed_lock, linker_cache}`. Embeddings memoized success+failure to avoid re-download loops.
- Embedding init: `resolve_embedding_cache_dir` (app cache `fastembed`, legacy `~/.prism/models` compat), `verify_model_cache` (5 required files, resume missing via `hf_hub` patched for relative `Location`), `sanitize_embedding_error` (network → friendly one-time-download message), `initialize_safely` (catch ONNX panic, degrade to lexical).
- Vault ops: `index_vault` (async `spawn_blocking` → `activate` + `jobs::run INDEX`), `write_file` (validate vault containment, 50 MiB cap, `.md` only, 1 MiB streamed-save gate, `suppress_self_write` 600 ms, `sync_file` + graph sync + tags + Aho-Corasick backlinks, 200 KB large-note shortcut), `read_file` (revision check), `create_file/folder`, `delete/rename` file/folder (5-level depth guard, traversal/sidecar/root guards, DB re-point).
- Linker: `scan_unlinked_mentions` (cached automaton + backlink sync), `init_linker`, `linker_scan/diff/apply`, `apply_approved_links` (reverse-offset rewrite + atomic footer), denied-link CRUD + prune.
- Semantic: `generate_and_store_embedding/block`, `find_semantic_related/block`, `backfill_embeddings` (32-note chunks, size gate).
- Ingest: `run_ingestion_script` (custom subprocess, cancellable, StrictLocal-aware), `run_builtin_extractor_async` → `documents::prepare_document_import` (staged review, never direct publish), legacy `extract_to_stage_async`.
- Config bridge: `get/save_runtime_config` (hot-apply similarity/batch), `purge_expired_history`, `select_file/folder` (`rfd`), `relaunch_app`, `web_search` (DuckDuckGo), backlink/graph getters.
- Windows: `webview2-com` accelerator disable (`AreBrowserAcceleratorKeysEnabled`), job objects; macOS: `libonnxruntime.dylib` staging; Linux: static `libonnxruntime.a` link.

### 6.2 `config.rs` (466 lines)

- `RuntimeConfig` mirrors TS `AppSettings` exactly (`camelCase`), persisted pretty-printed to `~/.prism/settings.json` via atomic `NamedTempFile` + `persist` + `sync_all`.
- Secrets: `api_key` migrated to OS keyring (`com.prism.app.models`), stored as `credentialRef`; empty-key save preserves previous ref when provider+URL unchanged; failure preserves previous file (tested).
- Defaults match `defaultSettings.ts:3-57` (accent `#38BDF8`, startup `editor`, 2D graph, autosave 800 ms, similarity 0.70, threads 1, batch 16, watch+H1 on, retention 0).
- `IngestionEngine {Python|Rust}` defaults Python for old settings (compat test).

### 6.3 `db.rs` (1,679 lines) + `db/chat.rs`, `db/history.rs`

- `prism_vault.db` in app-data dir, `PRAGMA busy_timeout=5000, WAL, NORMAL, foreign_keys=ON`.
- Legacy tables: `notes/id,title,path`, `aliases`, `backlinks(source_path,target_path,block_id,lines,matched_text)` (migrated across 3 layouts), `links(source,target)`, `denied_links`, `embeddings(note_id→blob)`, `block_embeddings(note,block→text,vector)`, `tags(note,tag)`, `note_history_base/deltas`, `chat_sessions/messages` (vault-scoped, `copilot|notebook` origins, notebook linked entries).
- Helpers: `upsert_note`, `rename_folder_paths` (prefix update without `LIKE`, FK deferred, all tables follow), `purge_stale_notes` (ghost purge), `update_backlinks` (caps: 5/target, 500/note; O(log n) line mapping; mention + applied-link union), `extract_applied_links` (dedup case-insensitive), `update_links_flat`, `get_graph` (single-tx consistent snapshot), denied-link prune (keyword/backlink/outbound/block liveness), vector blob ser/deser, block-text fetch.

### 6.4 `engine/indexer.rs` (431 lines)

- Bounded pool `MAX_INDEX_WORKERS=4`, bounded channel back-pressure, per-worker SQLite conn, sorted paths, no content buffering.
- `is_hidden` (dot segments + `note metadata` case-insensitive), markdown filter, folder collection incl. empty, `IndexedFile {path,relativePath,name,title,updatedAt}` (no content).
- 3 phases: upsert+`knowledge::sync`+tags → purge (`knowledge::remove` + `purge_stale_notes`) → link-graph rebuild (shared `NoteLinker`, `update_backlinks` + `update_links_flat`). Sorted output by title.
- Self-write mask: `IGNORE_WRITES` + single sweeper thread (50 ms drain), `suppress_self_write(path, 600ms)` — fixes prior per-write thread pile-up.

### 6.5 `engine/embeddings.rs` (1,293+ lines)

- Model: `BGEBaseENV15Q` 768-dim, `max_length 512`, `intra_op_threads` clamped 1–64 (default 1, patched fastembed caps at 2 to avoid all-core spikes).
- HNSW (`hnsw_rs`): `M=24, efConstruction=200, efSearch=128`, capacity pow2, stale-slot + compact (>50% stale + >32), threshold-gated search (no fallback — empty is honest).
- Policy constants: `MIN_SIMILARITY 0.70` (tunable), `QUERY_UNIT_LIMIT 8`, `BACKFILL_BATCH 16` (tunable), `MIN_BLOCK 40`, `MIN_SEMANTIC 50 chars`, `MAX_BLOCKS 400`, `BLOCK_EMBED_BATCH 32`, `MAX_EMBED 200k`.
- Behaviors: empty → purge (never suggest), oversized → skip/purge, short → skip (exact matcher only), identical-content memo (`FNV-1a64` + provenance) skips inference+write, block reuse by `(blockId,text)` (small edits don't re-embed all), batched backfill, foreground yield (`yield_to_foreground`), dim-change wipe, empty-note hygiene, vault-prefix filter.
- `split_into_blocks`: strip linker footer/frontmatter → heading/blank-line split → merge undersized (≤120 chars) → cap by pairwise merge → deterministic `block-<fnv32>-<i>` or existing `^anchor`.

### 6.6 `linker/*` (558 lines)

- `NoteLinker` (Aho-Corasick): `find_mentions(content, currentId)` skips wikilink spans, case-insensitive, cached per dictionary (`cached_linker`).
- `LinkerEngine`: file scan/diff/`apply_file` (atomic footer `<!-- LINKER_START -->`), `update_db_links`.
- `differ::Delta {added, removed}`, `scanner`, `writer::atomic_write`.

### 6.7 `watcher.rs` (363 lines)

- `notify` recursive watch, 500 ms debounce, 256-event channel, paired renames (`RenameMode::Both`) vs split From/To (never guess — content match for unique moves).
- Filters: self-write, non-markdown, hidden/sidecar. Batch: renames → `handle_rename` (DB `move_path`, `[[Old]]`→`[[New]]` rewrite with alias preservation, self-write masked, graph+embedding re-point, re-index target) + `handle_change` (sync+upsert+tags+mentions+links, emit `vault-changed:modified`) / `handle_remove` (purge + emit `removed`).
- Alias extractor: inline + block-list YAML frontmatter.

### 6.8 `menu.rs` (233 lines)

Native File/Edit/View/Prism menus → `menu://` events. Shortcuts: `CmdOrCtrl+N/Shift+N/O`, `1/2/3/5` views, `Shift+A/S` panels, `,/Shift+R` settings/reload. macOS About/Services/Hide; Windows/Linux simplified.

### 6.9 `study/*`, `document_model.rs`, `native_ingest.rs`, `engine/formatter.rs`, `knowledge/note_io.rs`

- `study/`: `artifacts.rs`, `exports.rs`, `library.rs`, `web.rs`; `scope/check/db/context` helpers; snapshot/artifact/review/attempt persistence; export gates.
- `document_model.rs` (366): shared `PrismDocument v1`, revision-scoped block IDs (separate from canonical), PDF/slide/sheet/MD-range/URL locations, normalization preserves text/tables/lists/fences/anchors/frontmatter, no generation model.
- `native_ingest.rs` (262): experimental Rust extractor behind `ingest-rust` feature.
- `formatter.rs`: deterministic local formatting (used by `models::format` — never external).
- `note_io.rs` (68): 50 MiB cap, revision guard, streamed-save interface for >1 MiB.

---

## 7. Knowledge Runtime v2 (core differentiator)

Source: `docs/v2-runtime.md`, `knowledge/mod.rs` (620), `schema.rs` (246), `search.rs` (534), `retrieval.rs` (968), `agent.rs` (1,933), `jobs.rs` (310), `models.rs` (448), `operations.rs` (1,393), `documents.rs` (1,924), `gateway.rs` (234), `blocks.rs` (155), `note_io.rs` (68).

### 7.1 Storage & identity (`schema.rs:48-79`, `mod.rs:85-366`)

- Versioned additive schema, `PRAGMA user_version` 0→4; unknown future rejected; pre-migration SQLite backup API captures WAL-consistent `prism_vault.db.before-runtime-*.db`; schema+version commit together; failure rolls back (tested: `migration_is_additive_and_repeatable`, `failed_schema_rolls_back`, WAL-backup tests).
- Tables: `knowledge_vaults(id,root,revision)`, `knowledge_notes(id,vault,path,title,hash,revision,deleted,empty_fts_rowid)`, `knowledge_blocks(id,note,anchor,text,kind,heading_path,hash,ordinal,lines,source_id/page/bbox,fts_rowid,deleted)`, `knowledge_fts (FTS5 unicode61)`, `knowledge_edges(source,source_block,target_ref,target_anchor,line)`, `knowledge_embedding_provenance(path,kind,hash,model)`, `knowledge_chunk_blocks`, `knowledge_jobs`, `knowledge_events(sequence,vault,kind,entity)`, plus v2 `knowledge_operations`, v3 document tables (see §9).
- Vault identity: canonical root path; `activate` canonicalizes, creates/fetches vault ID, new `generation` UUID per activation, recovers ops/batches, clears embeddings/approvals.
- Note identity: stable UUID; legacy path compat; explicit app moves retain; external moves via paired FS events or unique exact-content match; ambiguous → new ID. No IDs in Markdown.
- Block identity: separate from embedding chunks; explicit `^anchors` + unique unchanged text retain; unanchored edit retains only when bracketed by exactly one unchanged neighbor pair of same kind/heading; removed → tombstones; unchanged text + FTS rows reused; source/page/bbox nullable until ingestion.
- Embedding provenance: legacy rows preserved but not reused without matching input+model signature (`revision + tokenization`); inference chunks map to canonical blocks separately.

### 7.2 Lexical / semantic / hybrid (`search.rs`)

- `search_knowledge({text,mode,folder,tag,offset,limit})`: lexical/semantic/hybrid. Candidate window 1,000 notes; pages ≤100. Folder = absolute dir prefix; tag = exact. Responses: note/block IDs, snippets (`snippet(fts,36)`), component scores, `degraded`, `nextOffset`.
- Lexical: FTS5/BM25 (`bm25(fts,0,0,3,1)`), best block/note (`row_number() PARTITION BY note`), `fts_query` quotes+`AND`s 32 tokens (escapes `OR`, `x:y`).
- Hybrid: RRF `k=60` (`1/(60+rank)` per list, dedup, deterministic `noteId` tie-break). Semantic never downloads/models — unloaded → explicit lexical fallback message.
- `get_relations({noteId,kinds,offset,limit})`: explicit wiki/block edges, tags, folders; incoming derived from outgoing; semantic on-demand for explicit note (requires loaded model); ambiguous titles → `unresolved:`; block anchors only when unique live.
- `graph`/`backlinks` projections preserve legacy shapes; mention suggestions stay separate from explicit links.

### 7.3 Retrieval Planner Phase 2a (`retrieval.rs:315-807`)

Every AI request can go through: active note → explicit edges → backlinks → tags → semantic neighbors → graph-aware rerank → budget pack.

Ranking: `RRF(k=60) + 0.30 explicit + 0.20 graph proximity (1-hop explicit|backlink) + 0.15 tagOverlap + 0.10 folderSibling + 0.05 semantic-neighbor` (deterministic `noteId` tie-break). Explicit outranks pure semantic by design (tested).

- Union set: fused + explicit + backlink + semantic neighbors (active `find_related` top 20) + tag neighbors (shared tags, vault-isolated).
- Block detail: prefer lexical hit `blockId`, else first block; empty notes still citable (empty text).
- Citations: `path#^anchor` or `path#blockId`, heading path, snippet (240 chars), `scores{lexical,semantic,rrf,explicit,graphProximity,tagOverlap,folderSibling,finalScore}`.
- Packing (`pack_context`): default 12k chars (clamp 1k–100k), active note first when header fits (body cap 4k Unicode scalars), `---` separators, exact char accounting incl. headers/markers, Unicode-safe `truncate_chars`. `contextCitations` (packed sources) vs `citations` (paged results). Offset/limit (≤100) paginate blocks after packing.
- Read-only, no agent writes, no network, vault-scoped, degraded lexical-only when embeddings unloaded. Validated by `explicit_outranks_high_semantic`, `vault_isolation`, `context_budget_truncates`, Unicode packing tests.

### 7.4 Agent Tool Bus Phase 2b (`agent.rs`)

Flow: `Model → agent_call_tool → Permission → Rust op → Version snapshot → FS/SQLite → Reindex`. No direct FS from model; every request validated in Rust, vault `Scope` bound.

- Read (auto-approved): `read_note{noteId}`, `read_block{blockId}`, `search_vault{query,mode,folder,tag}`, `get_related_notes{noteId,kinds}`, `get_backlinks{noteId}`.
- Write (approval preview, 10 min expiry, generation-bound): `edit_note{noteId,operations[]}`, `create_note{path,content}`, `rename_note{noteId,newPath}`, `delete_note{noteId}`, `create_folder`, `move_folder`, `add/remove_tag`, `add_wikilink{noteId,target,blockId?}`, `format_note{noteId}`. Preview = diff/rename diff; no Markdown write during preview.
- `edit_note` patches: `replaceBlock/insertAfter/Before/deleteBlock/addTag/removeTag/addWikilink/append/replaceAll` (2 MiB limit, ≤32 ops, frontmatter preserved, block-ID validated, anchor honored).
- Permissions: `PendingEdit {vault_id+generation+600s}`; apply rejects on mismatch/expiry; `knowledge-event: agent_approval_required/applied`.
- Safety: traversal rejected, self-write masked, 2 MiB caps, vault-contained depth, dup coalesce, symlink reject, shared mutation coordinator (app writes/moves/deletes/linker/watcher/exports/ingest batch hold it; external editors independent).
- Journal (`operations.rs`, schema v2): transactional migration + backup; payloads carry before/after, paths/IDs/states/errors, vault-scoped; manifests bounded 64 MiB/10k entries; FS + SQLite reconciliation separate; displaced files staged as `.prism-recovery-*` siblings (retained, not auto-purged); exclusive moves + no-clobber; external races → `recovery_required` (no exclusive claim).
- Undo: `agent_list_operations` (latest 100), `agent_undo_operation` (post-image/identity/manifest/collision checks), `agent_undo_last` compat (history-only rejected). Success returns `operationId + undoAvailable`. Restart reconciles without replay; ambiguous preserves recovery; `agent_recheck_operation` retries metadata only. Prefixes: `CONFLICT:/PERSISTENCE:/RECOVERY_REQUIRED:`.
- Frontend: stale approvals discarded + **Generate fresh preview**; undo controls from journal after restart, vanish after success; recovery entries expose **Recheck recovery**. Manual JSON + model-driven loop both supported.

### 7.5 Jobs & approvals (`jobs.rs`, `models.rs:43-186`, `gateway.rs`)

- Scheduler: 256 active cap, separate foreground (≥50) / background slots, atomic `claim` with priority + dependency (`json_each`) + failure propagation, cooperative `checkpoint` between units, `yield_background`, progress, `recover` (interrupted → resumable for INDEX/EMBED, else retry message), dedup (`vault,dedup` unique while queued/running/waiting).
- Approvals: 10 min expiry, generation-invalidated, vault-change-invalidated, `approval_required` events, UI polling + event listen, `waiting_for_approval` state.

### 7.6 Service contracts (camelCase)

`knowledge_snapshot → {scope{generation,vaultId,root}, revision, sequence}`; `get_knowledge_blocks(noteId|path, offset, limit≤100)`; `search_knowledge`; `get_relations`; `plan_retrieval/get_context`; legacy graph/backlink projections; `list/cancel_knowledge_job`; `execute_model({task,messages})` (unsupported capability errors, never silent substitution); `list/resolve_approval`. Consumers recover via fresh snapshot.

---

## 8. AI, providers and privacy

### 8.1 Provider registry (`services/apiProviders.ts:60-363`)

27 entries alphabetically: AgentRouter, Anthropic (native `messages` path), BazaarLink, Cerebras, Cloudflare Workers AI (`{account_id}` token), Cohere, DeepSeek, Fireworks, Google Gemini (OpenAI-compat + lowercase model), Groq, Hugging Face, LM Studio (local, key optional), Meta Llama, MiniMax, Mistral (UUID pattern), NVIDIA NIM, Ollama (local), OmniRoute local gateway (`http://localhost:20128/v1`, `auto`), OpenAI, OpenRouter, Perplexity, Pollinations (keyless), Qwen, Scaleway, SiliconFlow, Together, xAI.

Each drives Settings UI: base-URL autofill (+ lock when `canEditBaseUrl=false`), key placeholder/format + soft warning (`isValidKeyForProvider`), free-tier/requirement note, extra fields (Cloudflare). Reference aligned to OmniRoute `PROVIDER_REFERENCE.md` 2026-07-28.

### 8.2 Dispatch (`knowledge/models.rs:210-448`, `services/apiService.ts:140`, `apiProviders.ts`)

- `execute_model({task: CHAT|SUMMARIZE|TAG|FORMAT|CLASSIFY|LINK_SUGGEST|AI_SCAN, messages})` runs in `jobs::run MODEL` (priority 80), `spawn_blocking`.
- Route: explicit `provider_id` → `models.providers` (must have `generation` capability) else `models.routes[task]` → provider else `omniRoute`. Missing route → error, never substitution.
- Validation: roles ∈ `system|user|assistant`, URL `http|https` no userinfo, non-empty base+model, Anthropic vs OpenAI-compat payload (`max_tokens 4096`, temperature passthrough, Google lowercases model).
- Loopback is NOT proof of local — BYO endpoints still get external checks.
- `authorize(destination, task, payload)`: StrictLocal denies external; Hybrid allows explicitly routed cloud task; CloudAllowed allows configured; else Ask (blocking approval loop, 100 ms poll, StrictLocal/vault-change/timeout aborts). EXTRACT approval text notes subprocess egress uninspectable.
- Transport: shared `reqwest` Rustls client (redirect `none`, 180 s timeout), Bearer or `x-api-key` (Anthropic), streaming SSE (`text/event-stream`, 8 MiB cap, `data: [DONE]`, `finish_reason`/`message_stop` completeness, cancellation via `checkpoint`). Errors typed: `SERVICE_UNAVAILABLE/AUTHENTICATION/MODEL_OR_ENDPOINT_MISSING/PROVIDER_ERROR`. Rust bypasses WebView2 network quirks.
- `model_service_status(task)`: content-free readiness (`ready|authentication|configuration|unavailable|manual`), `ollama serve` / `omniroute` hints for local, never installs/starts.

### 8.3 Privacy modes (default `AskBeforeCloud`)

- `StrictLocal`: rejects external. `AskBeforeCloud` (default, incl. upgrades): every external needs consent. `Hybrid`: explicitly routed cloud tasks allowed, rest need consent. `CloudAllowed`: configured externals allowed.
- Secrets in keyring, refs in settings atomically (`config.rs:261-300`). Idle unload 300 s, only without leases. Built-in embeddings + deterministic formatting stay local; no generation/rerank/classify weights bundled.

---

## 9. Ingestion and structured documents (Phase 3)

Backend: `knowledge/documents.rs` (1,924), `document_model.rs` (366), `native_ingest.rs` (262), `engine` ingest; frontend: `IngestModal.tsx`, `DocumentImports.tsx`, `ReviewWindow.tsx`, `services/documents.ts:17`, `ingestionStore.ts:199`.

Pipeline: **source → staged extraction → `PrismDocument v1` → persisted review → journaled Markdown publication**.

- `document_model.rs`: revision-scoped block IDs (≠ canonical), PDF pages/slides/sheets/MD ranges/URLs retained when supplied else absent+warning; normalization preserves text/tables/lists/fences/anchors/frontmatter; no generation model.
- Schema v3 (transactional + backup): `knowledge_documents`, `document_revisions (revision,vault,doc,source_hash,settings,runtime,artifact,hash,bytes,pinned,last_used)`, `document_imports`, `document_outputs (vault,doc,output_key→note_id,path,revision,fingerprint,physical)`, `document_block_sources`, `document_import_batches`. No Markdown/history migration.
- Revisions in `.prism/documents/revisions`; reuse verifies hashes/schema/normalization/fingerprint/settings/extractor identity; saved URL snapshots explicitly selected; refresh always re-extracts via privacy auth; disposable LRU 2 GiB; review/recovery pinned; optional originals content-addressed in `.prism/documents/sources` (outside mutation payloads); logs in `.prism/documents/logs` (legacy untouched).
- Workers get staging destinations; native work/data + legacy Python copy under staging; desktop parses only final top-level Markdown; local snapshots verified before subprocess consent; Python fallback separately authorized; StrictLocal blocks uncontrollable-egress subprocesses (no new offline default claimed).
- Commands: `prepare/list/get_preview/update/commit/recover_document_import`, `list_note_document_sources/get/open_document_source`. Legacy extractor keeps args/progress shape but returns staged-review, never direct publish. Review pages ≤100 outputs, 8k chars/excerpt, pageable; default 1 note, H2 split when selected; excludable sections (intro parent retained); settings change invalidates confirmation; restart/vault-switch needs refreshed preview.
- Publication: complete batch journal first (selected outputs + recovery, all destinations checked, 64 MiB/10k limits); per-file mutation coordinator + atomic publish/reconcile; reimport refuses edited/moved/deleted/replaced/unrelated; omitted outputs stay; canonical IDs via reconcile rules; source mappings retain excerpt, mark later block edits.
- Resume from Jobs; confirmed imports get operation undo; batch records survive restart; interrupted reconcile without replay; explicit **Roll back interrupted import** validates full state before reversing; FS vs SQLite deliberately separate recoverable steps.
- Editor **Sources** button opens excerpts/details/locations; originals hash-verified; saved web revisions reusable without fetch or refreshed with approval; dialogs use theme tokens + modal keyboard behavior.

---

## 10. Notebook and Study (native)

Backend `study/*` (5 files), `db/chat.rs`; frontend `study/*` + `services/study.ts` + `chatLibrary.tsx:191`.

- One Prism-native notebook: library + Sources/Chat/Studio + study materials from selected vault notes. No Python gateway.
- Collections/snapshots/artifacts model (`study.ts:18-23`): snapshot freezes sources+context+excerpts; artifact `{kind,title,version,parent,snapshot,body}`; reviews (`cardId,interval,due`) + attempts (`score,total,created`).
- Tools: tables, quiz, flashcards, podcast, mind map (+ legacy `slides` compat). Generation via vault-scoped `study_request` with streaming deltas/phases; activity ledger per vault.
- Chat library unified: Co-Pilot direct + Notebook linked (`origin`); vault-scoped; `create/list/rename/delete`, `get/append/replace_transcript`, `unlink_notebook_session`. Old Open Notebook links keep rows, adopt stored messages.
- Export: only podcast `.mp3` (Rust copy) fully exports; other formats report missing runtime (honest degradation).

---

## 11. Linking, graph and topics flows

- **Capture:** new note/folder (5-level guard), ingest review publish, H1 sync on startup.
- **Find:** hybrid search (FTS + HNSW + RRF), folder/tag filters, 1k window, 100/page, degraded banner when embeddings unloaded.
- **Connect:** auto-link on save (Aho-Corasick), manual `[[title|alias]]` + `[[#^anchor]]`, LinkHub approve/deny (denied persists per `kind/target/matched_text`, stale pruned), backlinks with line ranges, topics via `@tag`, graph 2D/3D from SQLite.
- **Ask:** planner context (active + explicit + backlinks + tags + semantic, 12k budget) → provider → citations (≤6 chips) + degraded flag + chat library save.
- **Save:** atomic write + sync + tags + graph + debounced embeddings (4 s) + version delta (explicit/idle, not per-autosave) + undo journal for agent writes.

---

## 12. Settings, theming and persistence

- Source of truth: `~/.prism/settings.json` (Rust). `localStorage` only legacy migration + lightweight caches (`prism_order_<vault>`, panel widths, collapsed, graph mode, LinkHub prefs). `deepMergeSettings` prevents undefined on old configs.
- Appearance: `industrial|glass|gloss` × `dark|light` → `theme-*` + `mode-*` classes; CSS tokens swap instantly; accent ramp + hover glow + graph color; gloss opacity var; background pattern/environment (incl. solar-system/stars/clouds viewport canvas); custom window icon (`appIcon` data-URL, light-mode grey swap).
- Retention: `versionRetentionDays` (0=keep all) enforced at startup via `purge_expired_history`.
- Hot-apply without restart: similarity threshold + embedding batch (threads need relaunch — baked into ONNX session).

---

## 13. Cross-cutting concerns

- **Events:** `knowledge-event` (jobs/approvals/notes/moves), `vault-changed` (400 ms coalesced refresh), ingestion progress/error, study deltas/phases, `menu://`.
- **Jobs UI:** `RuntimeActivity` + `JobsButton`, latest 100, cancel, resumable INDEX/EMBED after restart (`resume_embeddings`).
- **Logging:** `appLogger` (frontend) + `append_ingestion_log` (file) + Rust `println!` diagnostics (model cache size, load time, purge/skip reasons).
- **Updater:** `tauri-plugin-updater` + pubkey + `latest.json` endpoint (`github.com/LlamaLotz/Prism/releases`), passive Windows install; `UpdateBanner`.
- **Shortcuts/menus:** native menu + in-app `navigateWorkspace`; browser accelerators disabled natively (Windows COM) + JS fallback (macOS/WKWebView).
- **Errors:** `utils/errors.ts` (`ErrorDetails {human, raw}`), `SettingsApplyError` (saved but not fully applied), sanitized embedding errors (never leak `RelativeUrlWithoutBase`/TLS internals to UI), typed provider errors.
- **Splash:** static logo under load, video only on idle after all boot work, 15 s force-dismiss; heavy UI gated on `splashVisible`.
- **Layout:** `sidebarLayout` + `ResizeHandle`, persisted widths, collapse rail, AI expand, narrow-window (<1000 px) adaptations, 6 themes/modes incl. narrow validated by Playwright.

---

## 14. Build, packaging and platform matrix

- Scripts (`package.json:6-17`): `dev` (stage runtime + `tauri dev --features ingest-rust`), `web` (Vite), `build` (Tauri), `build-universal`, `build-frontend` (`tsc && vite build`), `build-ingest`, `stage-dev-runtime`, `test-ingest` (ingest crate).
- Tauri configs: `tauri.conf.json` (1200×800, frameless transparent, `../dist`, updater, NSIS/MSI/DMG targets, `../Extractor Final` resource — legacy), `tauri.macos.conf.json`, `tauri.ingest.conf.json`.
- ONNX: Linux links static `libonnxruntime.a` (no `.so` needed); Windows `onnxruntime.dll`, macOS `libonnxruntime.dylib` (prepare before build, staged/bundled); `ORT_LIB_LOCATION` (build) / `ORT_DYLIB_PATH` (runtime) overrides; `scripts/verify-onnxruntime.py`, `stage-dev-runtime.py`, `build-ingest-runtime.py`.
- Vendored patches: `fastembed` intra-op cap 2 threads (fixes per-save 96% spike) + `hf-hub` relative-`Location` fix. Documented in `Cargo.toml:52-62`.
- CI (`.github/workflows/`): `frontend.yml` (Node 22, `npm ci`, `build-frontend`, Playwright Chromium), `ingest.yml` (macOS Intel/ARM + Windows, `cargo test/check --features pdfium,ml,browser`), `release.yml` (frontend gate → version/tag → packaging; no Open Notebook runtime build/download/bundle).
- Validation gates (`docs/v2-runtime.md:67-82`): `cargo test --manifest-path src-tauri/Cargo.toml --lib`, ignored `hundred_thousand_blocks`, `npx tsc --noEmit`, `npx playwright test`. Phase 2 acceptance + Phase 1 release/packaging separate; no native release enablement/model weights/Notebook packaging/PrismWeb in Phase 3.

---

## 15. Testing

- **Rust:** units in `knowledge/mod` (identity reorder/bounded edit, dup retarget, FTS reuse, parallel writers), `schema` (additive/repeatable, rollback, WAL backup, v1/v2 upgrades), `search` (FTS escape, RRF agreement, vault isolation, block edges, 100k ignored), `retrieval` (isolation/folders, boosts, explicit>semantic, budget/Unicode packing), `jobs` (priority/foreground/background, deps, cancel/recover), `models` (privacy matrix), `config` (round-trip camelCase, keyring, unwritable-dir safety, engine default, appearance compat), `indexer` (empty folders, hidden/sidecar), `embeddings` (cosine, blocks, memo, caps).
- **Frontend (Playwright):** `tests/notebook/*.spec.ts` (16): `app`, `runtime`, `vault-workflows`, `documents`, `study`, `library/actions`, `note-graph-workspace`, `large-text`, `sidebar-layout`, `theming`, `accent-updates`, `contrast`, `prompt-model`, `ui-enhancements`, `agent-durability` + harnesses (`app-harness`, `runtime-harness`, `study-harness`). `playwright.config.ts`: base `127.0.0.1:5178`, harness entry, 30 s timeout, `global-setup.ts`.
- **Ingest:** `cargo test --locked --manifest-path src-tauri/src/ingest/Cargo.toml`, fixtures/baseline/benchmark scripts.
- Gaps noted: manifests stale (no version bump test), no PrismWeb contract tests in Phase 3, 100k test ignored by default.

---

## 16. Data, security and privacy analysis

- **Local-first:** vault files + `~/.prism/settings.json` + app-data `prism_vault.db` + `.prism/documents/` + cache `fastembed` (+ legacy `~/.prism/models`). No account, no telemetry noted.
- **Containment:** `validate_path` (canonical ancestor + `..` reject + vault-root prefix), `validate_vault_relative_path` (relative only, no `.:..:NUL`, 5-level depth), symlink reject (agent), `resolve_active`/`eligible` vault-ID scoping, `Path::starts_with(root)` defense-in-depth, `record_path_change` in same tx as mutation (no new-path/old-revision snapshots).
- **Secrets:** keyring only, refs in JSON, verification read-back, empty-key preserves ref, failure preserves file, no key in logs (sanitized errors, hashed payloads).
- **Privacy:** default Ask, StrictLocal hard block (incl. subprocess with uncontrollable egress), Hybrid explicit-route allow, CloudAllowed configured allow; loopback treated external; approvals 10 min, generation/vault-bound, payload-hash logged not content; retrieval local/offline, gating at dispatch.
- **Safety:** 2 MiB agent op cap, 32 ops, 50 MiB note cap, 200 KB embed skip, 8 MiB provider response cap, 4 MiB ingestion pipe cap, 256-job cap, 100-job list, 100-block review pages, traversal/depth/empty/folder guards, atomic writes + recovery siblings (never auto-purged), no-clobber + exclusive moves, external races stay `recovery_required`.
- **Backup:** pre-migration SQLite backup API (WAL-inclusive), `before-runtime-*.db`, additive migrations, unknown-future reject, Markdown never rewritten by migration.

---

## 17. Strengths, risks and tech debt

### Strengths

- True local-first with file-canonical + index-derived separation; honest degraded modes (lexical fallback, export limits, empty semantic panels).
- Vault-scoped deterministic retrieval (RRF + explicit boosts) with full score breakdown + citations — auditable AI context.
- Approval-gated agent writes + journaled undo + recovery siblings — rare rigor for a note app.
- Bounded concurrency everywhere (index pool 4, serial ONNX, single sweeper, 256 jobs, caps) — large-vault aware.
- Comprehensive Rust unit coverage + harness-driven Playwright; additive migrations with WAL backups.

### Risks / debt (load-bearing)

1. **Version drift:** tags (`v1.1.25`) vs manifests (`1.0.0`/`0.1.0`). Release tooling relying on manifests will mislabel. Fix: sync `package.json` + `tauri.conf.json` + `Cargo.toml` on tag, or derive from `git describe`, add CI check.
2. **Legacy resource bundle:** `tauri.conf.json:33-35` still bundles `../Extractor Final`. Post-Open-Notebook removal this is dead weight / confusion. Remove or document if still needed for legacy script path (`config.rs:215` hardcodes `/Users/Shiver/.../master_extractor.py` default — leaks dev path).
3. **Uncommitted v1.1.26 work:** 9 files dirty (`agent.rs`, `menu.rs`, `study/mod.rs`, `App.tsx`, `Editor.tsx`, `GraphView.tsx`, `SettingsPage.tsx`, `TitleBar.tsx`, `ResizeHandle.tsx`). Report baseline is moving; freeze or commit before release gate.
4. **Dual embedding caches:** `AppState.embeddings` vs `KnowledgeRuntime.embeddings` with fallback logic (`retrieval.rs:278-309` vs `search.rs:116-122`). Divergence risk (search uses legacy cache only). Unify on runtime cache.
5. **Legacy tables dual-write:** `notes/links/backlinks` + `knowledge_*` both maintained (watcher, `write_file`, renames). Ghost risk if one path missed; consider single source + views.
6. **ONNX platform fragility:** dynamic dylib/dll on Mac/Win, static on Linux, manual `prepare` step, vendored patches to maintain. Pin + verify in CI (scripts exist but not all wired to release).
7. **Provider sprawl (27):** best-effort URLs/keys will rot. Add contract test for base-URL shape + key-prefix docs, or split registry per release channel.

---

## 18. Roadmap suggestions (consistent with `PRODUCT_SCOPE.md`)

- Fix §17.1–17.3 first (version sync, resource cleanup, commit freeze) — zero user value but release-blocking.
- Unify embedding cache + deprecate legacy `notes/links` writes behind a projection (preserve compat shapes).
- Wire `verify-onnxruntime.py` + ingest contracts into `release.yml` gates; un-ignore 100k-block test nightly.
- Retrieval: expose `offset/limit` pagination in UI (backend already supports), add folder/tag filter chips to planner request (backend supports in `search_knowledge` but planner union doesn't filter by them yet).
- Study: restore non-MP3 export via native Rust (no Python) or remove UI entry — current honest error is correct but incomplete.
- Docs: add `docs/SECURITY.md` (threat model: vault containment, approval lifecycle, recovery semantics) + `docs/RELEASE.md` (tag→manifest sync, platform matrix, validation gates).

---

## Appendix A — Key files

| Area | File:line |
|---|---|
| Product | `PRODUCT_SCOPE.md:1`, `README.md:1`, `docs/v2-runtime.md:1` |
| App orchestration | `src/App.tsx:97` |
| Editor | `src/components/Editor.tsx:1`, `LinkHub.tsx:1`, `VersionHistoryRuler.tsx:1` |
| Graph/Topics | `GraphViewContainer.tsx:1`, `GraphView.tsx:1`, `GraphView3D.tsx:1`, `TopicsView.tsx:1` |
| AI | `AISidebar.tsx:1`, `services/apiProviders.ts:60`, `services/apiService.ts:1`, `services/knowledge.ts:67` |
| Notebook/Study | `components/study/StudyWorkspace.tsx:1`, `services/study.ts:12`, `src-tauri/src/study/mod.rs:15` |
| Settings | `components/SettingsPage.tsx:56`, `src/defaultSettings.ts:3`, `src/types/index.ts:98` |
| IPC types | `src/types/index.ts:159` |
| Rust entry | `src-tauri/src/lib.rs:1`, `main.rs:1`, `menu.rs:1`, `watcher.rs:1`, `config.rs:1`, `db.rs:1` |
| Runtime | `knowledge/mod.rs:40`, `schema.rs:6`, `search.rs:99`, `retrieval.rs:328`, `agent.rs:38`, `jobs.rs:76`, `models.rs:189`, `operations.rs:1`, `documents.rs:399`, `gateway.rs:1`, `blocks.rs:1` |
| Engine | `engine/indexer.rs:265`, `engine/embeddings.rs:446`, `linker/mod.rs:12` |
| Build/test | `package.json:1`, `vite.config.ts:1`, `tauri.conf.json:1`, `Cargo.toml:1`, `playwright.config.ts:1` |

## Appendix B — Command inventory (abridged)

`index_vault`, `get_graph`, `get_backlinks_for_note`, `read/write/create/rename/delete_file`, `create/delete/rename_folder`, `record_note_version`, `get_all_reconstructed_versions`, `purge_expired_history`, `knowledge_snapshot`, `get_knowledge_blocks`, `search_knowledge`, `get_relations`, `plan_retrieval`/`get_context`, `list/cancel_knowledge_job`, `execute_model`, `list/resolve_approval`, `agent_list_tools/call_tool/list_pending/resolve_pending/list_operations/undo_operation/undo_last/recheck_operation`, `prepare/list/get_preview/update/commit/recover_document_import`, `list_note_document_sources/get/open_document_source`, `study_request/export`, chat library CRUD, `get/save_runtime_config`, `select_file/folder`, `relaunch_app`, `web_search`, ingestion script/extractor, linker scan/diff/apply, embeddings generate/find/backfill, watcher start/stop, `model_service_status`.

## Appendix C — Glossary

- **Vault:** user-selected folder of `*.md`; canonical source.
- **Scope/Generation:** `vault_id + root + generation UUID`; invalidates approvals/jobs/embeddings on switch.
- **Block:** structural unit (heading/paragraph) with stable ID + optional `^anchor`; ≠ embedding chunk.
- **RRF:** reciprocal rank fusion `1/(60+rank)`; hybrid lexical+semantic.
- **Degraded:** lexical-only when embeddings unloaded/failed.
- **PendingEdit/Approval:** 10-min, generation-bound write/mCloud gate.
- **Operation/Journal:** durable write record enabling undo/recheck/recovery.
- **PrismDocument v1:** staged structured doc + revision; published only after review.
- **HNSW:** approximate nearest-neighbor graph for local vector search.

---

*Generated for `docs/APP_REPORT.md` on approval. Baselines `v1.1.26` working tree; re-run `git describe` + manifest sync before release.*

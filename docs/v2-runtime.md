# Prism v2 runtime foundations

Phase 1 introduces the vault-scoped Rust Knowledge Runtime. Markdown remains canonical. The website and later Research, Study, graph-projection and podcast workspaces are outside this delivery.

## Storage and identity

`knowledge/schema.rs` adds versioned SQLite tables without replacing legacy metadata or history. Before migration, SQLite's backup API captures a consistent database, including committed WAL content, in a uniquely named `prism_vault.db.before-runtime-*.db` beside the original. Schema changes and their version advance commit together. An unknown future version is rejected.

Vault identities use canonical root paths. Notes have stable IDs with legacy path compatibility. Explicit app moves retain identity and history; external moves use paired filesystem events or a unique exact-content match to a missing file. Ambiguous matches receive new identities. No migration writes IDs into Markdown.

Structural blocks are separate from bounded embedding chunks. Explicit anchors and unique unchanged blocks retain identity; an unanchored edit retains identity only when unchanged neighbours unambiguously bracket it. Removed blocks remain tombstones. Unchanged block text and FTS rows are reused. Source/page/bounding-box fields are nullable until document ingestion provides them.

Legacy embedding rows are preserved but are not reused without matching input and model provenance. The built-in model signature includes the downloaded repository revision and tokenization settings. Inference chunks map to canonical blocks separately.

## Service contracts

All new command arguments and results use camelCase.

- `knowledge_snapshot()` returns active scope, generation, revision and latest event sequence.
- `get_knowledge_blocks(noteId, offset, limit)` accepts a stable note ID or legacy path and returns at most 100 live blocks with provenance and source ranges.
- `search_knowledge({ text, mode, folder?, tag?, offset?, limit? })` supports lexical, semantic and hybrid retrieval. Responses contain note/block IDs, snippets, component scores, degraded status and a next offset. Folder filters are absolute directory paths. The candidate window is bounded to 1,000 notes; pages contain at most 100 results.
- Lexical retrieval uses FTS5/BM25 and the best block per note. Hybrid retrieval uses reciprocal rank fusion with `k=60`. Searches do not download models. An unloaded semantic model produces an explicit lexical fallback.
- `get_relations({ noteId?, kinds?, offset?, limit? })` exposes explicit wiki/block edges, tags and folders. Incoming edges are derived from outgoing edges. Semantic relations are computed on demand for an explicitly selected note and require the loaded local model. Ambiguous note titles remain unresolved; block anchors resolve only to a unique live block.
- `plan_retrieval({ query, activeNoteId?, budgetChars?, offset?, limit? })` and `get_context` (alias) implement the Phase 2a Retrieval Planner + Context Builder. Every AI request can go through the Knowledge Runtime: active note → explicit wiki/block edges → backlinks → tags → semantic neighbors → graph-aware reranking → budget packing. Ranking is `RRF(k=60) + 0.30 explicit + 0.20 graph proximity (1-hop) + 0.15 tag overlap + 0.10 folder sibling` (deterministic tie-break by `noteId`). Results are block-level with `citation` (`path#^anchor` or `path#blockId`), heading path, snippet and `scores{lexical, semantic, rrf, explicit, graphProximity, tagOverlap, folderSibling, finalScore}`. Context text is budget-packed (default 12k chars, active note first when its header fits, body capped at 4k Unicode scalar characters). Degraded lexical-only status is returned when embeddings are not loaded. No model download, no network. Vault-scoped like `search_knowledge`.
- Legacy graph and backlink commands project the canonical index into their existing response shapes. Mention suggestions remain separate from explicit links.
- `list_knowledge_jobs()` returns the latest 100 jobs for the active vault. `cancel_knowledge_job(id)` requests cooperative cancellation.
- `execute_model({ task, messages })` routes current text-generation tasks to the selected compatible provider. Unsupported capabilities return an error rather than selecting another model.
- `list_approvals()` and `resolve_approval(id, approved)` handle request-bound cloud consent. Approvals expire after ten minutes and are invalidated by vault changes.

`knowledge-event` contains a sequence, vault ID, event kind and entity ID. Consumers can recover by requesting a fresh snapshot. The UI periodically refreshes approvals and jobs as well as listening to events.

## Execution and privacy

The scheduler limits active queue entries to 256 and reserves separate foreground and background execution slots. Backfill yields between notes, inference is serialized, and cancellation is checked between units of work. Index/embedding work interrupted by a restart is refreshed against current content; operations with external side effects require explicit retry. Jobs retain dependency, priority and resource-estimate fields; adaptive hardware governance remains Phase 9.

The Knowledge Runtime owns the shared embedding instance. Idle unloading defaults to 300 seconds and only occurs without active leases. Built-in embeddings and deterministic formatting remain local. No new generation/reranking/classification model weights are bundled in this phase.

Desktop model requests originate in Rust. Named provider configurations can be selected per current text task. Existing OpenAI-compatible endpoints, native Anthropic requests and keyless compatible endpoints remain supported. Successful credential migration stores secrets in the OS credential store and writes references to settings atomically. Notebook's Co-Pilot import resolves credentials in Rust.

Privacy defaults to **Ask Before Cloud**, including upgrades. **Strict Local** rejects external processing. **Hybrid** permits explicitly routed cloud text tasks; other external requests still need consent. **Cloud Allowed** permits configured external requests. A loopback endpoint is not proof of local inference, so configurable BYO endpoints still receive external-processing checks.

Notebook retains its source database and existing model configuration. Its managed Python transports use an authenticated, vault-scoped loopback gateway for HTTP egress. Unknown direct sockets, DNS and shell execution are blocked; approved media processes are restricted to local protocols. The gateway is an integration boundary for the pinned runtime, not an operating-system sandbox for arbitrary third-party plugins. Full Notebook source/workspace/model-setting consolidation remains Phase 5.

## Phase 2a — Retrieval Planner (read-only, no agent writes)

The co-pilot no longer injects only the active note. `AISidebar` now calls `sendChatMessageWithRetrieval`, which issues `plan_retrieval` for the user's last turn and active note, then appends the planner's `contextText` (vault context block with `[[path]]`/`[[path#^anchor]]` citation hints) to the system prompt before `execute_model`. Privacy gating still happens only at `execute_model` time (`authorize(destination, task, payload)`), so retrieval itself remains local/offline. Each assistant turn renders up to 6 citation chips (`[[path]]` pill with `^anchor`/`blockId` qualifier, hover = full source) and an amber `degraded` banner when lexical fallback was used.

## Phase 2b — Agent Tool Bus (approve writes, auto-reads)

`knowledge/agent.rs` is the Agent Tool Bus: `Model → agent_call_tool → Permission → Rust operation → Version snapshot → Filesystem/SQLite → Reindex`. Every model tool request is validated in Rust; no direct filesystem access.

- Read tools (auto-approved, vault-scoped): `read_note{noteId}`, `read_block{blockId}`, `search_vault{query,mode?,folder?,tag?}`, `get_related_notes{noteId,kinds?}`, `get_backlinks{noteId}`. Bound to the active vault's `Scope` (vault_id + generation + root prefix); outside-vault access denied.
- Write tools (approval preview, 10m expiry, vault generation binding): `edit_note{noteId, operations[]}`, `create_note{path,content}`, `rename_note{noteId,newPath}`, `delete_note{noteId}`, `create_folder{path}`, `move_folder{oldPath,newPath}`, `add_wikilink{noteId,target,blockId?}`, `add_tag/remove_tag{noteId,tag}`, `format_note{noteId}`. Preview is a diff patch (or rename path diff); preparing it does not write Markdown.
- Structured patches for `edit_note`: `replaceBlock{blockId,text}`, `insertAfter/Before{blockId,text}`, `deleteBlock{blockId}`, `addTag/removeTag{tag}`, `addWikilink{blockId?,target}`, `append{text}`, `replaceAll{text}` (2MB limit, max 32 ops, frontmatter preserved, block-id validated before mutate, anchor text honored for new block ids).
- Permission: writes create a `PendingEdit` with `vault_id` + `generation` + 600s expiry; apply rejects on generation/vault mismatch or expiry, matching cloud approval semantics. `knowledge-event` emits `agent_approval_required` on create and `agent_applied` on apply.
- Safety: `handleRename`-style path traversal rejected, self-write masked (`suppress_self_write`), 2MB caps, vault-contained folder depth, duplicate tag/wikilink coalesced.
- Conflict checks bind approvals to filesystem identities, content fingerprints, stable note IDs, source/destination paths, and complete folder manifests. Symlinks are rejected. App writes, moves, deletes, linker writes, watcher processing, Notebook exports and ingestion publication share a mutation coordinator. External editors remain independent. Phase 3 managed extraction writes only to staging; reviewed publication holds the coordinator across the complete import batch.
- Schema v2 adds `knowledge_operations` using a transactional migration and consistent pre-migration SQLite backup. No Markdown is rewritten and no historical undo evidence is fabricated. Journal payloads contain before/after content, paths, IDs, states and errors; they are scoped to the vault. Individual manifests are bounded at 64 MiB / 10,000 entries.
- Filesystem publication and SQLite reconciliation are separate steps. File replacements/deletions stage the actual displaced file at a journal-recorded `.prism-recovery-*` sibling; these hidden files and the journal retain recoverable versions. Exclusive moves and no-clobber publication protect newly occupied destinations. Detected external races remain `recovery_required`; Prism does not claim exclusive control over external editors. Retained recovery files are not automatically purged.
- Undo: `agent_list_operations` returns the latest 100 operations; `agent_undo_operation{operationId}` checks recorded post-operation contents and identities before applying its specific inverse. Subsequent edits, changed folder manifests and path collisions block undo. Successful writes return `operationId` and `undoAvailable`. `agent_undo_last{notePath}` is a compatibility adapter to journaled operations; history-only undo is rejected.
- Restart reconciles known interrupted outcomes without repeating filesystem writes. Ambiguous states preserve their recovery data and need explicit attention. `agent_recheck_operation{operationId}` rechecks filesystem evidence and retries metadata reconciliation; it never forces an overwrite. Conflict, persistence and recovery failures have `CONFLICT:`, `PERSISTENCE:` and `RECOVERY_REQUIRED:` prefixes.
- Frontend: stale approvals are discarded and offer **Generate fresh preview**, requiring another approval. Undo controls load from the journal after restart and disappear after successful undo. Recovery entries expose **Recheck recovery**. Agent mode supports both manual JSON tool calls and a model-driven read/preview loop.
- Context packing counts headers, separators, truncation markers and content as Unicode scalar characters. `contextCitations` identifies packed sources independently of result pagination; legacy `citations` describes the result page. Every model round accumulates sources by stable note/block ID and retains degraded retrieval status, including the final preview summary. Chat metadata persists these fields; chips are labelled **Retrieved sources** and navigate through stable identities, without claiming the model cited every source.

Custom ingestion processes cannot have their individual external requests inspected. Their approval describes access to the source/vault, and they are disabled in Strict Local. Managed extraction supports cancellation and stops when the vault changes or Strict Local is selected.

## Validation and release

Run from the desktop repository:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml --lib hundred_thousand_blocks -- --ignored
npx tsc --noEmit
npx playwright test
python3 scripts/test-prism-gateway.py src-tauri/notebook-runtime/<target>
python3 scripts/test-notebook-runtime.py src-tauri/notebook-runtime/<target>
```

The existing native build requires an ONNX Runtime library. Set `ORT_LIB_LOCATION` to its installation directory when not already configured; on macOS the dynamic loader must also find the corresponding dylib. The local validation used the installed Intel macOS ONNX library without downloading new model weights.

When updating an existing development payload, run `scripts/patch-notebook-runtime.py <runtime>` before the gateway/runtime tests. It invalidates the old smoke-test marker. Production payloads must declare `knowledgeGateway: 1`; older payloads fail closed with an update message. The runtime CI matrix runs the transport-policy and real media smoke tests on each supported packaged target. Only the local Intel macOS payload was executed during this implementation.

Phase 2a is the read-only prerequisite; 2b activates the Tool Bus. The remaining phases follow the accepted order: graph projections (Phase 4); Notebook consolidation (Phase 5); research (Phase 6); study (Phase 7); source-linked audio (Phase 8); and hardware/resource hardening (Phase 9).

## Phase 3 — Structured documents and reviewed imports

The desktop ingestion path is now **source → staged extraction → PrismDocument v1 → persisted review → journaled Markdown publication**. `document_model.rs` is shared by the worker and desktop. Its revision-scoped block IDs are separate from canonical knowledge IDs. PDF pages, slides, sheets, original Markdown ranges and web URLs are retained when supplied; missing locations remain absent with warnings. Normalization preserves source text, tables, lists, fences, anchors and front matter; it does not invoke a generation model.

Schema v3 transactionally adds document revisions, import plans, generated-note mappings, source mappings and batch journals after a consistent SQLite backup. No existing Markdown or historical source metadata is migrated. Revisions live in `.prism/documents/revisions`; reuse verifies artifact hashes, schema, normalization, input fingerprint, settings and extractor/runtime identity. Saved URL snapshots are explicitly selected; refresh always extracts again through privacy authorization. Disposable revisions use a 2 GiB LRU budget. Review/recovery references and imported revisions are protected. Optional retained originals are streamed into content-addressed `.prism/documents/sources` files, outside mutation payloads.

Managed workers receive staging destinations. Native work/data directories and the legacy Python script copy stay under staging. The desktop parses only final top-level Markdown outputs, not raw intermediates. Local input snapshots are verified before subprocess consent. Python fallback has its own authorization check. Strict Local continues to block subprocess routes whose egress cannot be controlled; this does not establish a new bundled offline extractor default. Existing legacy logs/artifacts are untouched; managed extraction logs are retained separately under `.prism/documents/logs`.

Commands: `prepare_document_import`, `list_document_imports`, `get_document_preview`, `update_document_import`, `commit_document_import`, `recover_document_import`, `list_note_document_sources`, `get_document_source`, and `open_document_source`. The legacy extractor command keeps its arguments and progress event shapes but returns a staged-review result, never direct publication. Review pages contain at most 100 outputs and 8,000 Unicode characters per excerpt. Longer text and retained/excluded output lists can be paged. One note is the default; heading splitting defaults to H2 when selected. Sections can be excluded, while the introductory parent is retained. Changing settings invalidates confirmation. Restart or vault switching requires a refreshed preview.

Before any write, a complete batch journal stores selected outputs and recovery evidence; all destinations are checked. Each file then uses the mutation coordinator and existing atomic publication/reconciliation protocol. The generated output/recovery limits are 64 MiB and 10,000 entries. Reimport refuses edited, moved, deleted, replaced or unrelated destinations. Outputs omitted from a later plan remain in the vault. Canonical IDs survive only through the existing reconciliation rules. Source mappings retain the recorded original excerpt and mark subsequent block edits rather than redirecting provenance.

Imports are resumable from Jobs. Confirmed imports expose operation-based undo; completed batch records survive restart. Undo validates all child postimages and import-created folder manifests before changing any file. Known interrupted publication can reconcile metadata without replaying writes. Explicit **Roll back interrupted import** validates the entire recorded state before reversing known published children; ambiguous states retain recovery evidence and return a recovery error. Filesystem and SQLite publication are deliberately separate recoverable steps.

The editor’s **Sources** button and retrieved-source controls open original excerpts, extractor/revision details and available locations. Original files are hash-verified before opening; missing or changed originals are reported. Saved web revisions can be reused without fetching, or refreshed with privacy approval. Review/source dialogs use the existing theme tokens and modal keyboard behavior.

Phase 3 regression coverage includes document fidelity, structured extractor sidecars, backed-up v2→v3 migration/rollback, cache corruption and eviction, split/reimport identity, conflicting edits and destinations, partial publication and explicit rollback, batch undo, review confirmation, restart refresh, pagination, and all six themes/modes including narrow windows. Phase 2 acceptance and Phase 1 supported-target release/packaging validation remain separate gates. No native release enablement, model weights, Notebook source packaging, or PrismWeb changes are part of this phase.

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

The remaining phases follow the accepted order: graph-aware AI and controlled edits; structured documents; graph projections; Notebook consolidation; research; study; source-linked audio; and hardware/resource hardening.

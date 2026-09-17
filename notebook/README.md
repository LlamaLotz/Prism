# Notebook in Prism

Notebook is a native React page backed by a private copy of Open Notebook. Open
a vault, choose **Notebook** (Cmd/Ctrl+5), then use **Manage** to configure models.
Import compatible Co-Pilot settings or add provider credentials directly. Chat,
embeddings, transcription and speech generation have independent model defaults.

Notebook sources, notes, chat history, generated media and its database live in
`<vault>/.prism/notebook/data/`. Vault import creates snapshots; changes are not
automatically synchronized. Export creates a new Markdown file without replacing
existing notes. Panel sizes and last-selection UI preferences are local to Prism.

## Development and release

Install uv **0.10.12** on the build machine, then run:

```sh
python3 scripts/build-notebook-runtime.py
python3 scripts/test-notebook-runtime.py src-tauri/notebook-runtime/x86_64-apple-darwin
npm run dev
```

Use `aarch64-apple-darwin` for Apple Silicon or `x86_64-pc-windows-msvc` for
Windows. Build each payload on its native architecture. End users do not need uv,
Python, Node, FFmpeg or Docker installed separately. The Intel runtime currently
occupies approximately 810 MB before compression; universal macOS includes both
architectures. The pinned NumPy wheel requires macOS 14+, so Notebook reports a
clear compatibility message on older Macs without disabling other Prism pages.

The runtime validation workflow builds all three payloads, runs the real API,
worker and media pipeline against a local deterministic AI provider, verifies
relocation, and archives executable bits/symlinks. Release packaging depends on
these jobs and requires a successful smoke-test marker. The local browser tests
exercise all six themes, contrast, narrow layouts, navigation and vault exchange:

```sh
npx playwright install chromium
npx playwright test
```

The smoke test does not call paid or external AI providers. It validates the
provider protocol and pipeline; it does not certify every vendor's live API.
Source ingestion from websites and real AI use still require their configured
services. Optional Docling/Crawl4AI engines and local model weights are not bundled.

## Upstream and compatibility patches

The exact upstream commit and binary versions are recorded in `upstream.json`;
the upstream dependency lockfile and MIT license are retained in `upstream/`.
`openapi.json` is captured from that backend and generates `src/types/notebook-api.ts`
using `scripts/generate-notebook-types.py`. Python distributions retain their
package licenses and the FFmpeg distribution's notices in the bundled resources.

Upstream source is kept intact. The builder applies two asserted patches to the
generated payload: redirect writable data outside resources, and exclude
unconfigured podcast presets from podcast-creator's global profile validation.
`scripts/patch-notebook-runtime.py` can refresh those adapter files in a developer
payload without downloading dependencies again.

`prism_api.py` implements upstream's placeholder job list/cancel routes and adds
an authenticated drain endpoint. `prism_worker.py` executes upstream commands with
two task slots, supports cancellation, stops claiming work while draining, and
marks interrupted running jobs as failed for explicit retry. The native manager
enforces one owner per vault, loopback-only services, bounded shutdown and
process-tree cleanup. It never runs a runtime package installer.

## Recovery and portability

Authentication is generated locally. Encryption and database keys are stored in
the OS credential store under `com.prism.app.notebook`, identified by the vault's
`workspace-id`. Copying a vault to another computer also requires transferring
those credential-store entries; Prism will not silently replace a missing key.

Before an upstream revision change, Prism copies the stopped database and data
to `.prism/notebook/backups/<id>`. A failed migration leaves `migration-pending`
containing the backup path and blocks further startup. To recover, close Prism,
preserve the failed `data` directory, restore the recorded backup as `data`, and
remove `migration-pending`. Do not copy or restore a live SurrealDB directory.

Windows and Apple Silicon packaging must pass their native CI jobs before a
release is considered validated. A successful local Intel test does not replace
those platform checks.

# Prism native ingestor

Independent library/CLI with a Tauri subprocess adapter. Python remains the fallback.
No database writes. `ingest-rust` is off in release builds. `npm run dev` builds the
native worker first (`PRISM_SKIP_INGEST=1 npm run dev` skips that step for web-only
work). All optional backend implementations must compile before shipping.

## Format parity matrix

Native (`ingest/src/lib.rs::extract`) handles:

| Input | Native | Fallback |
| --- | --- | --- |
| pdf | PDFium + `pdf-extract`/`lopdf` inspection, Tesseract OCR | Docling / Python text layers |
| docx, pptx, xlsx, html/htm, txt, md | ZIP/XML, `calamine`, DOM-to-Markdown | Python |
| png, jpg/jpeg, webp | Tesseract | Python |
| mp3, wav, m4a, flac, aac, ogg, mp4, mov, mkv, avi, webm | FFmpeg + `whisper-rs` | faster-whisper Python |
| YouTube URLs | yt-dlp metadata/captions + Whisper | Python |
| http/https pages | `reqwest` + `scraper`, Chromium render, deterministic BFS crawl | Crawl4AI / Python |

Legacy Tk filetypes (`master_extractor.py`) also advertise the same Office/media
set above. Any extension outside this table is `unsupported` natively and must
route to Python once; do not widen the native extension list without a fixture
and a fallback test.

## HTTP and resource budgets

Connection pooling is required: share one `reqwest` client per crawl/job, cap
HTTP concurrency at 8, requests at 30s, buffered web responses at 140MB.
Cap Office/XML input buffering at 256MB before parsers allocate; model memory
(Whisper/VAD/OCR) and decoded PDF pages get separate measured budgets.
Stream large media to temp storage; never hold a full download plus a full
decoded copy in memory.

## Build and tests

```
cargo test --locked --manifest-path src-tauri/src/ingest/Cargo.toml
cargo build --locked --manifest-path src-tauri/src/ingest/Cargo.toml --features pdfium,ml,browser
cargo check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --features ingest-rust
npx playwright test tests/ingest/ingest.spec.ts
```

Both Tauri checks are required: the plain check guards the legacy
Python-first path, the `ingest-rust` check guards the native adapter.

Whisper requires CMake, a C/C++ toolchain, and libclang. Add `metal` for macOS GPU
builds or `cuda` for a separately distributed NVIDIA build. CPU fallback is used
when GPU initialization fails. Model files must be in the verified runtime manifest;
loading unverified downloaded weights is not supported.

The CLI accepts `--vault`, `--files`, `--urls`, `--yt_method`, `--ocr`,
`--follow-links`, `--max-pages`, `--python-script`, `--fallback-python` and
`--no-fallback`. Set `PRISM_INGEST_BIN` / `PRISM_INGEST_LIB` to runtime directories.
`PRISM_INGEST_DATA` overrides the writable `~/.prism/ingest` diagnostics/model cache.
A CLI caller opts into Python fallback by supplying `--python-script`. Tauri supplies
its bundled legacy extractor automatically. No arguments print help.

## Protocol and lifecycle

Each stdout JSON line has `version: 1`, `type`, and `message`; error lines also have
`code`. Events: progress, diagnostic, error, result, ready, python_required,
process_started, process_exited. Tauri forwards human messages as existing string
events. In supervised mode the worker waits for `{"start":true}`, then requests
`{"python":"absolute executable"}` only if fallback is needed, and waits for
`{"commit":true}` before publishing. Closing stdin or denying commit fails the job.

Tauri checks authorization before starting, checks cancellation/privacy every 100ms,
and checks again before publication. Unix supervised descendants share a process
group; Windows descendants are contained by a kill-on-close Job Object. PDF ranges
have independent deadlines; expired processes and descendants are stopped before
fallback. The adapter owns temporary work directories, including after worker death.

A final Markdown rename is atomic. Sidecars are written first and restored if note
publication fails. A machine/process crash between those two renames can leave new
metadata with an old note; this is not a multi-file filesystem transaction.

## Runtime packaging and release gates

No per-target asset lock is committed yet; that is an explicit release blocker.
Each target needs its own lock before `tauri build --features ingest-rust`.

`python3 scripts/build-ingest-runtime.py --release --assets-lock <lock.json>`
requires a target-specific asset lock. Each asset has `source` (HTTPS URL or local
path), `path` within the runtime, `sha256`, and `license` notice. The builder checks
all digests and requires yt-dlp, FFmpeg, Tesseract, Chromium and PDFium. Include all
shared libraries/browser resources, Tesseract language data, and models as pinned
files. The generated manifest records the exact worker digest too. No unpinned
upstream downloads are performed by the worker.

PDFium is loaded from `PRISM_INGEST_LIB` (set by the Tauri adapter to
`<runtime>/lib`, overridable for tests). If the library is absent, PDF range
extraction must return `unavailable` and take the one-shot Python fallback;
it must not silently downgrade a 100+ page or complex-layout PDF to a
lower-fidelity text path.

Chromium is resolved via `PRISM_INGEST_BIN/chromium` and must run headless
with the flags required inside a signed/packaged app. Keep request
interception on so crawl-mode hostname boundaries hold for rendered pages.

Standalone CLI use is dev-only: vault authorization, Strict Local checks, and
cancellation live in the Tauri adapter (`src-tauri/src/native_ingest.rs`),
not in the worker. Never treat a direct worker invocation as authorized.

## Disk and log lifecycle

The adapter owns `PRISM_INGEST_WORK` (per-job `job-*` scratch + `staged/`)
including after worker death. The worker owns writable
`~/.prism/ingest/` (`raw_service_files/`, `logs/prism-<pid>.jsonl`, model
cache). Add rotation/bounds for both: no unbounded `raw_service_files`
growth, rotate JSONL logs, keep `~/.prism/ingestion.log` integration without
duplicate warnings, and never log file contents or URLs with credentials.

## Compatibility notes

`Extractor Final/orchestrator.py` is now a non-interactive shim that requires
the `prism-ingest` binary (`PRISM_INGEST_EXECUTABLE` or `PATH`). External
callers expecting the old interactive Tk/orchestrator behavior must be updated.

`prism-ingest` crate license is MIT (see `src-tauri/src/ingest/Cargo.toml`).
Runtime binaries/models keep their own licenses via the asset lock and the
generated `THIRD_PARTY_NOTICES.txt`.

Use `tauri build --features ingest-rust --config src-tauri/tauri.ingest.conf.json`
only after staging the matching runtime and passing release gates. The ordinary
release command keeps the legacy path. Runtime assets and signing credentials are
not part of this source change. A complete, licensed per-target asset lock, Windows
and both macOS smoke tests, CUDA testing, WER corpus, model/OCR fidelity validation,
and controlled performance results are required before enabling release rollout.

## Fixtures and benchmarking

Synthetic CC0 PDF/Office fixtures are generated by `scripts/ingest-fixtures.py`.
`ingest-baseline.py` extracts deterministic legacy helper contracts without executing
bootstrap code. `benchmark-ingest.py` compares the actual legacy PDF text functions
against a worker on a 150-page fixture; use a release worker and fixed hardware.
Do not compare debug builds with optimized Python native extensions as a release gate.

Known validation limits: runtime word-count checks do not establish semantic/WER
parity; complex-layout detection is conservative and needs corpus validation. Crawl rendering intercepts document requests to enforce hostname boundaries.
Automatic runtime downloads are deliberately absent; release assets must be staged
from a reviewed, pinned lock before distribution.

## Remaining verification before release rollout

- Plain + `ingest-rust` Tauri checks (see above).
- Real 100/101-page PDF ordering/chunk test (not just `chunks()` units).
- OCR off/on/adaptive against a PDFium-rendered fixture.
- YouTube caption cleanup/gate via local-HTTP yt-dlp + subtitle fixture.
- Crawl `max-pages` cap, fragment stripping, same-host redirect enforcement.
- Synthetic-PCM audio window overlap test.
- Fallback-invoked-exactly-once + supervisor-deny-preserves-note tests.
- Windows Job Object smoke + macOS Intel/ARM signed-package smoke.
- Release-worker benchmark on fixed hardware (cold/warm separated, RSS/disk);
  debug-vs-Python comparisons do not pass the gate.

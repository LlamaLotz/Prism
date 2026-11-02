# Local structure assistant

Optional, offline topic segmentation for notes and reviewed imports.

## Contract

- The model receives block IDs and short previews.
- It returns **ordered section start blocks only**.
- Rust derives section ends, so coverage cannot overlap or leave gaps.
- The model never receives note-text write access. The deterministic splitter renders the original blocks.
- Auto-apply headings are extractive where possible; a generated label falls back to the section's first line.

## Commands

- `inspect_note_structure` — deterministic blocks, outline and split options.
- `preview_note_format` — safe offline formatting; no line joining or heading inference.
- `plan_note_split` — headings, auto, paragraph, or local-model topics. Headings win when the note already has a usable outline.
- `get_structure_model_status` — availability, path, checksum, worker budget. Never loads the model.

## Runtime

- Bundled model: `LFM2.5-1.2B-Instruct-Q4_K_M.gguf` (Q4_K_M, 731 MB) or the QAD-Q4_0 benchmark candidate.
- Worker: short-lived `llama-cli` process, CPU-only, 2 threads, 8K context.
- Budget: 2 GB worker memory. Linux/macOS set an address-space limit; Windows assigns the worker to a Job Object with a process-memory ceiling when permitted; all platforms also monitor resident memory and kill the worker if it exceeds the budget.
- Lazy: the worker is never started at app startup, on note save, or on format.

## Staging

```sh
python3 src-tauri/scripts/stage-structure-runtime.py
python3 src-tauri/scripts/stage-structure-model.py --model q4-k-m
```

The model and runtime are gitignored. The license, notices and `manifest.json` are committed.

Release packaging must sign the staged `resources/bin` executable and shared libraries with the same identity as the application on macOS, and sign `llama-cli.exe` on Windows. The model file is data and does not need a code signature.

Development overrides:

```sh
PRISM_STRUCTURE_MODEL=/path/to/model.gguf
PRISM_STRUCTURE_LLAMA=/path/to/llama-cli
PRISM_STRUCTURE_MODEL_SHA256=<optional pinned digest>
```

Resolution order is the environment override first, then the bundled `resources/models` and `resources/bin`.

## Benchmark

```sh
python3 src-tauri/scripts/structure-benchmark.py \
  --llama /path/to/llama-cli \
  --model /path/to/LFM2.5-1.2B-Instruct-Q4_K_M.gguf \
  --model /path/to/LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf
```

Fixtures live in `fixtures/`. The harness measures boundary F1 (with ±1 block tolerance), WindowDiff, JSON validity, coverage, extractive/short headings, latency and peak RSS. Add documents to `fixtures/benchmark.json` before changing the model or prompt.

Initial results are recorded in `fixtures/benchmark-results.md`. Q4_K_M is the bundled artifact; QAD-Q4_0 is a benchmark alternative. The product uses deterministic headings first and calls the model only when the note has no usable outline.

## License

LFM Open License v1.0 (`resources/licenses/LFM-OPEN-LICENSE.txt`). The license includes a commercial-use threshold; review it before distributing Prism commercially. llama.cpp is MIT (`resources/licenses/LLAMA-CPP-LICENSE.txt`). The bundled GGUFs are unmodified official LiquidAI quantized releases.

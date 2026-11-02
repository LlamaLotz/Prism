# Local structure model bake-off

Environment: Linux x86_64 (WSL2), 8 logical CPUs, 19 GiB RAM, CPU-only, 2 threads, 8K context, llama.cpp `b12034`, temperature 0, seed 42. Initial 7-document fixture set; expand before changing the bundled model or prompt. Timings were collected on a development host with other build activity, so use them for relative comparison rather than as absolute desktop latency.

Command:

```sh
python3 src-tauri/scripts/structure-benchmark.py \
  --llama /path/to/llama-cli \
  --model /path/to/LFM2.5-1.2B-Instruct-Q4_K_M.gguf \
  --model /path/to/LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf
```

## Q4_K_M

| Fixture | Boundary F1 | WindowDiff | Sections (model / expected) | Time | Peak RSS |
|---|---:|---:|---:|---:|---:|
| PDF/OCR text | 0.75 | 0.73 | 5 / 3 | 41.3 s | 1390 MB |
| Web article | 0.91 | 0.67 | 5 / 6 | 25.8 s | 1390 MB |
| Transcript | 0.91 | 0.43 | 5 / 6 | 32.8 s | 1390 MB |
| Research paper | 0.75 | 0.33 | 3 / 5 | 25.2 s | 1390 MB |
| Textbook | 0.75 | 0.40 | 5 / 3 | 40.7 s | 1390 MB |
| Report | 1.00 | 0.00 | 6 / 6 | 30.0 s | 1390 MB |
| Real `docs/v2-runtime.md` | model-only invalid | — | 0 / 7 | 66.4 s | 1391 MB |

Model-only average boundary F1: **0.72** including the structured-document failure; **0.85** across the six unstructured/mixed fixtures. JSON was valid and coverage complete on 6/7 model-only runs; the structured `v2-runtime` run failed generation, which is why the product prefers headings there. All accepted headings were extractive and within 8 words. Peak resident memory was **1.39 GB**, below the 2 GB worker budget.

The `v2-runtime` document already has seven H2 headings. In the product path, `topics` does not call the model when a usable outline exists; it uses the deterministic heading split (7/7 boundaries). The model-only row is retained to show why that rule exists.

## QAD-Q4_0

QAD-Q4_0 was tested on the same three-category subset under the same conditions. It produced identical boundary F1 (0.86 mean) and identical boundary sets on all three fixtures, but used 1428 MB peak versus 1390 MB and averaged 47.3 s versus 43.6 s. It is not bundled; the official Q4_K_M file is the selected artifact.

## Interpretation

The model is useful as an **optional proposal layer** for unstructured sources, not as the formatter. It over-segments some documents by one to two sections; Rust coalescing removes tiny non-heading sections and the UI must show a preview before applying. Structured documents should use the deterministic heading split. Failure of the model-only structured-document run is handled by that deterministic path, not by writing a partial plan.

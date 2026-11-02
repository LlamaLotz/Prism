# Third-party notices

## LFM2.5-1.2B-Instruct

- Model: `LiquidAI/LFM2.5-1.2B-Instruct-GGUF`
- Upstream revision: `8ed288026e23958ad9dfa92d53ed773a8eee7125`
- Files bundled:
  - `LFM2.5-1.2B-Instruct-Q4_K_M.gguf` (unmodified official quantized release)
- License: LFM Open License v1.0. A copy is included at `LFM-OPEN-LICENSE.txt`.
- Copyright and attribution: Liquid AI, Inc.
- Modifications: none. Prism does not modify the GGUF files. The model is executed unmodified by llama.cpp.

The LFM Open License v1.0 contains a commercial-use threshold. Review the included license before distributing Prism commercially. This notice is attribution, not legal advice.

## llama.cpp

- Project: `ggml-org/llama.cpp`
- Pinned build: `b12034`
- License: MIT. A copy is included at `LLAMA-CPP-LICENSE.txt`.
- Prism invokes the unmodified `llama-cli` executable as a short-lived local worker. No model weights or prompts leave the device.

## Bundled model runtime

The llama.cpp CPU runtime is packaged from the upstream `b12034` release for the target platform. Platform binaries may include additional shared libraries distributed with that release; their licenses are covered by the llama.cpp distribution and the notices shipped with it.

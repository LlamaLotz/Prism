# Settings crash regression

The 1.1.14 macOS release selected the first file named
`libonnxruntime.1.18.1.dylib` from each ONNX archive. The archives also contain a
same-named dSYM payload. Those payloads were combined and shipped as the runtime.
`dlopen` rejected their `MH_DSYM` headers, and `ort` panicked while Prism held its
embedding mutex. Subsequent settings hot-application could unwrap that poisoned
mutex inside a synchronous WebKit IPC callback and abort the process.

The release workflow now selects the archive's `lib/` path explicitly.
`scripts/verify-onnxruntime.py` rejects non-library slices, verifies both macOS
architectures, loads the host slice, and checks ONNX Runtime 1.18.1/API 18.

## Checks

- `cargo test --manifest-path src-tauri/Cargo.toml --lib --offline`
- `npx playwright test tests/settings --workers=1`
- `python3 scripts/verify-onnxruntime.py src-tauri/onnxruntime/libonnxruntime.dylib`

For native macOS IPC coverage, copy a settings file to a temporary **absolute**
path, then run:

```sh
cargo build --manifest-path src-tauri/Cargo.toml --bin settings-smoke --features settings-smoke
src-tauri/target/debug/settings-smoke /absolute/path/to/copied-settings.json
```

The opt-in harness uses real Tauri get/save commands in a native webview. It
changes only the copied file, tests successful saves/readback, deliberately
poisons the embedding slot, and verifies that a durable save returns a warning
without terminating the app. It exits with status 0 on success. Use a fixture
without plaintext API keys to avoid invoking credential migration. Run it twice
against the same copied file to cover reopening. The harness and its config-path
override are absent from normal release builds.

Browser tests exercise both settings buttons, delayed completion, disabled
controls, failure/retry, the unsaved-changes guard, and committed-save warnings.

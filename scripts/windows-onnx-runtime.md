# Windows ONNX runtime

Windows builds require the x64 ONNX Runtime 1.18.1 DLL at
`src-tauri/onnxruntime/onnxruntime.dll`. Extract it from Microsoft's
`onnxruntime-win-x64-1.18.1.zip` release archive. Release CI downloads and
stages it automatically. Python must be available as `python` during builds.

The build checks the DLL's actual version and API 18 support, and copies it
to `target/<profile>/onnxruntime/onnxruntime.dll`. The Windows Tauri config
includes this same relative path in installers. Prism initializes ort with
that absolute application-local path, ignoring PATH and ORT_DYLIB_PATH.

Before publishing, Windows CI runs `app.exe --verify-onnx-runtime` with a
1.17.1 DLL on PATH and in ORT_DYLIB_PATH; a nonzero exit blocks publication.
This validates native loading without downloading embedding model weights.

Installer acceptance on Windows:

1. Install the newly built NSIS or MSI package (also test upgrading an old installation).
2. Verify `<install directory>/onnxruntime/onnxruntime.dll` with
   `python scripts/verify-onnxruntime.py <DLL path>`.
3. Run the installed executable with `--verify-onnx-runtime` and check its exit
   code, including with an older ONNX DLL on PATH.
4. Open a vault, wait for semantic model initialization, and save Settings.
   Confirm there is no ONNX version warning and semantic search works.

An already-installed 1.17.1 runtime is repaired by installing the corrected
build; saving Settings alone cannot replace native libraries.

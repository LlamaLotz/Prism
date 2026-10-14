# Windows ONNX runtime

Windows builds require the x64 ONNX Runtime 1.18.1 DLL at
`src-tauri/onnxruntime/onnxruntime.dll`. Extract it from Microsoft's
`onnxruntime-win-x64-1.18.1.zip` release archive. Release CI downloads and
stages it automatically, together with the x64 release DLLs from Visual Studio's
`VC/Redist/MSVC/<version>/x64/Microsoft.VC143.CRT` directory. For local Windows
builds, copy those redistributable DLLs into the same `src-tauri/onnxruntime`
directory. Do not use debug CRT DLLs or copies from System32. Python must be available as `python` during builds.

The build checks the DLL's actual version and API 18 support, and copies it
to `target/<profile>/onnxruntime/onnxruntime.dll`. The Windows Tauri config
includes every DLL in this directory in both NSIS and MSI installers.
The verifier requires `msvcp140.dll`, `vcruntime140.dll`, and `vcruntime140_1.dll`
and checks that all bundled DLLs are x64 PE images. Keep these app-local CRT
files current when rebuilding releases; they are serviced through Prism updates.
The loader searches this bundle directory for dependencies before handing the
loaded module to ort; errors include the Windows error code. Prism initializes ort with
that absolute application-local path, ignoring PATH and ORT_DYLIB_PATH.

Before publishing, Windows CI runs `app.exe --verify-onnx-runtime` with a
1.17.1 DLL on PATH and in ORT_DYLIB_PATH; a nonzero exit blocks publication.
This validates native loading without downloading embedding model weights.

Installer acceptance on Windows:

1. On a clean Windows x64 machine without Visual Studio or a separately installed
   Visual C++ runtime, install the newly built NSIS or MSI package (also test upgrading an old installation).
2. Verify `<install directory>/onnxruntime/onnxruntime.dll` with
   `python scripts/verify-onnxruntime.py <DLL path>`.
3. Run the installed executable with `--verify-onnx-runtime` and check its exit
   code, including with an older ONNX DLL on PATH.
4. Repeat with a missing/corrupt ONNX DLL and with a required CRT DLL removed
   on the clean machine. The runtime probe must fail with the path and Windows
   error code. Restore the bundle before continuing. CI's developer image alone
   cannot prove independence from a globally installed CRT.
5. Open a vault, wait for semantic model initialization, and save Settings.
   Confirm there is no ONNX version warning and semantic search works.

An already-installed 1.17.1 runtime is repaired by installing the corrected
build; saving Settings alone cannot replace native libraries.

With an unavailable semantic engine, changing the editor mode must still persist
and show a non-modal semantic warning. Actual settings write failures must still
show “Could not save editor preference”.

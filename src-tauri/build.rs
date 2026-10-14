fn main() {
  // ort links against ONNX Runtime using @rpath. Tauri places bundled
  // dynamic libraries in Contents/Frameworks, so make that directory part
  // of the executable's runtime search path on macOS.
  #[cfg(target_os = "macos")]
  println!("cargo:rustc-link-arg-bin=app=-Wl,-rpath,@loader_path/../Frameworks");

  // `tauri dev` never performs the release bundle step that places
  // libonnxruntime.dylib next to the executable, so a debug binary would
  // dlopen-fail (and ort panics on load failure). Stage the locally prepared
  // release dylib next to the debug binary when it exists. A stale/broken
  // entry (e.g. a symlink into a wiped /tmp from an older setup) is replaced.
  println!("cargo:rerun-if-changed=onnxruntime/libonnxruntime.dylib");
  if std::env::var("PROFILE").as_deref() == Ok("debug")
    && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
  {
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest dir"));
    let source = manifest.join("onnxruntime/libonnxruntime.dylib");
    if source.is_file() {
      // OUT_DIR is target/<profile>/build/<crate>-<hash>/out — three levels
      // up is the profile dir holding the final binary.
      if let Some(profile_dir) = std::env::var_os("OUT_DIR")
        .map(std::path::PathBuf::from)
        .as_deref()
        .and_then(|p| p.ancestors().nth(3))
      {
        let dest = profile_dir.join("libonnxruntime.dylib");
        let stale = match std::fs::symlink_metadata(&dest) {
          Err(_) => true, // missing
          Ok(meta) => {
            if meta.file_type().is_symlink() && std::fs::read(&dest).is_err() {
              true // broken symlink (e.g. into a cleaned /tmp)
            } else {
              // Replace when sizes differ; a valid identical copy is left alone.
              std::fs::metadata(&source).map(|m| m.len()).ok()
                != std::fs::metadata(&dest).map(|m| m.len()).ok()
            }
          }
        };
        if stale {
          let _ = std::fs::remove_file(&dest);
          match std::fs::copy(&source, &dest) {
            Ok(_) => println!("cargo:warning=staged libonnxruntime.dylib next to the debug binary"),
            Err(e) => println!("cargo:warning=could not stage libonnxruntime.dylib for dev: {e}"),
          }
        }
      }
    }
  }

  // Explicit Windows staging avoids ort-sys's cached/default 1.17 DLL.
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let source = manifest.join("onnxruntime/onnxruntime.dll");
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-changed=../scripts/verify-onnxruntime.py");
    assert!(source.is_file(), "Stage ONNX Runtime 1.18.1 at src-tauri/onnxruntime/onnxruntime.dll before building Windows");
    let status = std::process::Command::new("python")
      .arg(manifest.join("../scripts/verify-onnxruntime.py")).arg(&source)
      .status().expect("Python is required to validate the Windows ONNX Runtime");
    assert!(status.success(), "Bundled ONNX Runtime validation failed");
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let destination = out.ancestors().nth(3).expect("Cargo profile directory").join("onnxruntime");
    std::fs::create_dir_all(&destination).expect("Create ONNX runtime directory");
    std::fs::copy(&source, destination.join("onnxruntime.dll")).expect("Stage ONNX runtime");
  }

  tauri_build::build()
}

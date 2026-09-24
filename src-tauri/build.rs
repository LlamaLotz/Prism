fn main() {
  println!("cargo:rerun-if-changed=notebook-runtime");
  // Release artifacts must never silently ship a Notebook page without its
  // validated backend. The universal macOS application contains both payloads.
  if std::env::var("PROFILE").as_deref() == Ok("release") {
    let target = std::env::var("TARGET").expect("Cargo target");
    let manifest = std::path::Path::new("notebook-runtime").join(&target).join("manifest.json");
    assert!(manifest.is_file(), "Build and validate the bundled Notebook runtime before packaging Prism (scripts/build-notebook-runtime.py)");
    assert!(manifest.with_file_name("smoke-tested.json").is_file(), "Notebook runtime smoke tests must pass before release packaging");
  }
  // ort links against ONNX Runtime using @rpath. Tauri places bundled
  // dynamic libraries in Contents/Frameworks, so make that directory part
  // of the executable's runtime search path on macOS.
  #[cfg(target_os = "macos")]
  println!("cargo:rustc-link-arg-bin=app=-Wl,-rpath,@loader_path/../Frameworks");

  // `tauri dev` never performs the release bundle step that places
  // libonnxruntime.dylib next to the executable, so a debug binary would
  // dlopen-fail (and ort panics on load failure). Stage the checked-in
  // release dylib next to the debug binary when it exists. A stale/broken
  // entry (e.g. a symlink into a wiped /tmp from an older setup) is replaced.
  println!("cargo:rerun-if-changed=onnxruntime/libonnxruntime.dylib");
  if std::env::var("PROFILE").as_deref() == Ok("debug") {
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

  tauri_build::build()
}

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

  tauri_build::build()
}

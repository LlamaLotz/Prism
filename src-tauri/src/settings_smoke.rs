//! Opt-in native WKWebView regression using a copied settings file only.
use crate::{config, AppState};
use std::{path::PathBuf, sync::{Arc, Mutex}};
use tauri::Manager;

pub(crate) struct Profile(pub PathBuf);

#[tauri::command]
async fn smoke_poison_embeddings(app: tauri::AppHandle) {
    let slot = app.state::<AppState>().embeddings.clone();
    let _ = std::thread::spawn(move || {
        let _guard = slot.lock().unwrap();
        panic!("simulated failed native model loader");
    }).join();
}

#[tauri::command]
fn smoke_done(app: tauri::AppHandle, error: Option<String>) {
    if let Some(error) = error { eprintln!("Native settings smoke failed: {error}"); app.exit(1); }
    else { println!("Native settings IPC passed: round-trip, appearance, embedding preferences, poisoned engine warning, final readback"); app.exit(0); }
}

pub fn run() {
    let path = PathBuf::from(std::env::args_os().nth(1).expect("Pass an isolated settings file"));
    assert!(path.is_absolute() && path.is_file(), "Pass an absolute copied settings file");
    let mut context = crate::app_context();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .manage(Profile(path))
        .manage(AppState {
            linker: Mutex::new(None), db_path: Mutex::new(None), watcher_path: Mutex::new(None),
            watcher_stop: Mutex::new(None), embeddings: Arc::new(Mutex::new(None)),
            embed_lock: Arc::new(Mutex::new(())), linker_cache: Mutex::new(None),
        })
        .register_uri_scheme_protocol("settings-smoke", |_, _| {
            tauri::http::Response::builder().header("Content-Type", "text/html")
                .body(include_str!("../../tests/settings/native-smoke.html").as_bytes().to_vec()).unwrap()
        })
        .invoke_handler(tauri::generate_handler![crate::get_runtime_config, crate::save_runtime_config, smoke_poison_embeddings, smoke_done])
        .setup(|app| {
            // Assert config isolation before letting any webview IPC execute.
            assert_eq!(config::config_path(app.handle()).unwrap(), app.state::<Profile>().0);
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::CustomProtocol("settings-smoke://localhost".parse().unwrap()))
                .title("Prism settings native regression").build()?;
            Ok(())
        })
        .run(context).expect("native settings test runtime");
}

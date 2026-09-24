//! Runtime configuration bridge.
//!
//! The full `AppSettings` model (vault, AI, appearance, editor, linking,
//! system) is owned by Rust and persisted as JSON at `~/.prism/settings.json`
//! — the single source of truth. The frontend loads it over IPC on startup
//! (migrating legacy localStorage settings on first run) and saves it back
//! whenever the user hits Save in the Settings page.
//!
//! Field names use `#[serde(rename_all = "camelCase")]` so the wire format
//! matches the TypeScript `AppSettings` interface exactly — no mapping layer
//! needed on either side.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct OmniRouteConfig {
    /// Provider id from the frontend API provider registry.
    pub provider: String,
    pub api_key: String,
    #[serde(default)]
    pub credential_ref: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f32,
    pub inject_user_profile: bool,
    /// Free-form user context injected into AI system prompts when
    /// `inject_user_profile` is enabled.
    pub user_profile: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearanceConfig {
    /// Visual archetype: industrial, glass, or gloss.
    pub theme_style: String,
    /// Color scheme: dark or light.
    pub theme_mode: String,
    pub startup_view: String,
    pub default_graph_mode: String,
    pub background_pattern: String,
    pub ai_panel_open_on_start: bool,
    pub sidebar_collapsed_on_start: bool,
    pub link_hub_visible_by_default: bool,
    pub link_hub_default_height: f64,
    pub label_quality: String,
    pub auto_rotate_on_load: bool,
    pub auto_rotate_speed: f64,
    /// Brand accent color (hex) applied as the CSS --color-brand-* ramp.
    pub accent_color: String,
    /// Color of the button/slider hover underglow (hex).
    pub hover_glow_color: String,
    /// Base color for knowledge-graph nodes (hex).
    pub graph_node_color: String,
    /// Selected app icon (logo id, empty = default /logo.png).
    pub app_icon: String,
    /// Status line beside the sidebar logo; supports {date}/{time} tokens.
    pub sidebar_status_text: String,
    /// Opacity of Liquid Gloss glass surfaces.
    pub liquid_glass_opacity: f64,
    /// Viewport-level background environment.
    pub background_environment: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfig {
    pub autosave_debounce_ms: u64,
    pub full_render_line_threshold: u64,
    pub find_debounce_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LinkingConfig {
    pub auto_link_on_save: bool,
    pub similarity_threshold: f32,
    pub embed_debounce_ms: u64,
    pub backfill_on_vault_open: bool,
    pub embedding_threads: usize,
    pub embedding_batch_size: usize,
    pub persist_node_positions: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SystemConfig {
    pub watch_vault: bool,
    pub sync_h1_on_startup: bool,
    pub version_retention_days: u64,
}

/// Full runtime configuration, wire-compatible with the frontend
/// `AppSettings` interface (camelCase keys).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    #[serde(default)]
    pub models: crate::knowledge::models::ModelSettings,
    #[serde(default)]
    pub notebook: NotebookConfig,
    pub vault_path: String,
    pub ingestion_script: String,
    pub omni_route: OmniRouteConfig,
    pub appearance: AppearanceConfig,
    pub editor: EditorConfig,
    pub linking: LinkingConfig,
    pub system: SystemConfig,
}

impl Default for OmniRouteConfig {
    fn default() -> Self {
        Self {
            provider: String::new(),
            api_key: String::new(),
            credential_ref: String::new(),
            base_url: "https://api.omniroute.ai/v1".to_string(),
            model: "gpt-4o".to_string(),
            temperature: 0.7,
            inject_user_profile: false,
            user_profile: String::new(),
        }
    }
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            theme_style: "industrial".to_string(),
            theme_mode: "dark".to_string(),
            startup_view: "graph".to_string(),
            default_graph_mode: "3d".to_string(),
            background_pattern: "grid".to_string(),
            ai_panel_open_on_start: false,
            sidebar_collapsed_on_start: false,
            link_hub_visible_by_default: true,
            link_hub_default_height: 220.0,
            label_quality: "high".to_string(),
            auto_rotate_on_load: false,
            auto_rotate_speed: 0.67,
            accent_color: "#38BDF8".to_string(),
            hover_glow_color: "#38BDF8".to_string(),
            graph_node_color: "#38BDF8".to_string(),
            app_icon: String::new(),
            sidebar_status_text: "{time}".to_string(),
            liquid_glass_opacity: 0.93,
            background_environment: "none".to_string(),
        }
    }
}

impl Default for EditorConfig {
    fn default() -> Self {
        Self {
            autosave_debounce_ms: 800,
            full_render_line_threshold: 8_000,
            find_debounce_ms: 1_000,
        }
    }
}

impl Default for LinkingConfig {
    fn default() -> Self {
        Self {
            auto_link_on_save: true,
            // Mirrors the engine's MIN_SIMILARITY_SCORE constant so the two
            // defaults can never drift apart.
            similarity_threshold: crate::engine::embeddings::MIN_SIMILARITY_SCORE,
            embed_debounce_ms: 4_000,
            backfill_on_vault_open: true,
            // fastembed intra-op thread cap (see vendor/fastembed patch).
            embedding_threads: 1,
            embedding_batch_size: crate::engine::embeddings::BACKFILL_BATCH_SIZE,
            persist_node_positions: true,
        }
    }
}

impl Default for SystemConfig {
    fn default() -> Self {
        Self {
            watch_vault: true,
            sync_h1_on_startup: true,
            version_retention_days: 0,
        }
    }
}

/// Bounds for the user-configurable worker-queue concurrency override.
pub const DEFAULT_WORKER_CONCURRENCY: u32 = 2;
pub const MIN_WORKER_CONCURRENCY: u32 = 1;
pub const MAX_WORKER_CONCURRENCY: u32 = 8;

/// Clamp a stored override into range; returns None when unset so callers
/// fall back to the default instead of breaking queue behavior.
pub fn effective_worker_concurrency(override_value: Option<u32>) -> u32 {
    match override_value {
        Some(n) if n >= MIN_WORKER_CONCURRENCY && n <= MAX_WORKER_CONCURRENCY => n,
        _ => DEFAULT_WORKER_CONCURRENCY,
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct NotebookConfig {
    pub embed_by_default: bool,
    pub source_panel_width: u32,
    pub notes_panel_width: u32,
    /// Worker-queue concurrency override (parallel background jobs).
    /// None/absent = no override; the system default applies. Old settings
    /// files without this key keep working unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_concurrency: Option<u32>,
}

impl Default for NotebookConfig {
    fn default() -> Self { Self { embed_by_default: false, source_panel_width: 260, notes_panel_width: 260, worker_concurrency: None } }
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            models: Default::default(),
            notebook: NotebookConfig::default(),
            vault_path: String::new(),
            ingestion_script: "python \"/Users/Shiver/Documents/Prism/Extractor Final/master_extractor.py\" --vault {vault_path}".to_string(),
            omni_route: OmniRouteConfig::default(),
            appearance: AppearanceConfig::default(),
            editor: EditorConfig::default(),
            linking: LinkingConfig::default(),
            system: SystemConfig::default(),
        }
    }
}

/// `~/.prism/settings.json` — same data directory as the SQLite index and
/// log files.
pub fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "settings-smoke")]
    if let Some(profile) = app.try_state::<crate::settings_smoke::Profile>() {
        return Ok(profile.0.clone());
    }
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".prism").join("settings.json"))
}

/// Loads the persisted config. Returns `None` when no file exists yet (first
/// run) or the file is corrupt — the caller falls back to legacy localStorage
/// settings and re-saves, so a corrupt file never bricks the app.
pub fn load_runtime_config(app: &tauri::AppHandle) -> Option<RuntimeConfig> {
    let path = config_path(app).ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Persists the config to disk (pretty-printed JSON for debuggability).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSaveResult {
    pub settings: RuntimeConfig,
    pub runtime_warning: Option<String>,
}

pub fn save_runtime_config(app: &tauri::AppHandle, config: &RuntimeConfig) -> Result<RuntimeConfig, String> {
    save_config_at(&config_path(app)?, config, migrate_key)
}

fn save_config_at(
    path: &std::path::Path,
    config: &RuntimeConfig,
    mut store_key: impl FnMut(&mut OmniRouteConfig) -> Result<(), String>,
) -> Result<RuntimeConfig, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut config = config.clone();
    if config.omni_route.api_key.is_empty() && config.omni_route.credential_ref.is_empty() {
        if let Some(previous) = std::fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str::<RuntimeConfig>(&raw).ok()) {
            if previous.omni_route.provider == config.omni_route.provider && previous.omni_route.base_url == config.omni_route.base_url { config.omni_route.credential_ref = previous.omni_route.credential_ref; }
        }
    }
    store_key(&mut config.omni_route)?;
    for provider in &mut config.models.providers { store_key(&mut provider.config)?; }
    let raw =
        serde_json::to_string_pretty(&config).map_err(|e| format!("Failed to serialize config: {e}"))?;
    use std::io::Write;
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().ok_or("Settings directory missing")?).map_err(|e|e.to_string())?;
    temporary.write_all(raw.as_bytes()).map_err(|e|e.to_string())?;
    temporary.as_file().sync_all().map_err(|e|e.to_string())?;
    temporary.persist(&path).map_err(|e|format!("Failed to replace settings: {e}"))?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_save_round_trip_returns_the_canonical_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut config = RuntimeConfig::default();
        config.omni_route.api_key = "test-key".into();
        let saved = save_config_at(&path, &config, |provider| {
            if !provider.api_key.is_empty() {
                provider.credential_ref = "test-reference".into();
                provider.api_key.clear();
            }
            Ok(())
        }).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        let loaded: RuntimeConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(loaded.omni_route.credential_ref, saved.omni_route.credential_ref);
        assert!(!raw.contains("test-key"));
        let again = save_config_at(&path, &RuntimeConfig::default(), |_| Ok(())).unwrap();
        assert_eq!(again.omni_route.credential_ref, "test-reference");
    }

    #[test]
    fn credential_failure_preserves_previous_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        save_config_at(&path, &RuntimeConfig::default(), |_| Ok(())).unwrap();
        let before = std::fs::read(&path).unwrap();
        let mut changed = RuntimeConfig::default();
        changed.omni_route.api_key = "new-test-key".into();
        assert!(save_config_at(&path, &changed, |_| Err("Credential store locked".into())).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn unwritable_directory_preserves_previous_settings() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        save_config_at(&path, &RuntimeConfig::default(), |_| Ok(())).unwrap();
        let before = std::fs::read(&path).unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = save_config_at(&path, &RuntimeConfig::default(), |_| Ok(()));
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn settings_before_notebook_gain_safe_defaults() {
        let mut json = serde_json::to_value(RuntimeConfig::default()).unwrap();
        json.as_object_mut().unwrap().remove("notebook");
        let restored: RuntimeConfig = serde_json::from_value(json).unwrap();
        assert!(!restored.notebook.embed_by_default);
        assert_eq!(restored.notebook.source_panel_width, 260);
        assert_eq!(restored.notebook.worker_concurrency, None);
        assert_eq!(effective_worker_concurrency(None), DEFAULT_WORKER_CONCURRENCY);
        assert_eq!(restored.appearance.startup_view, "graph");
    }

    #[test]
    fn worker_concurrency_override_clamps_to_safe_range() {
        // No override (incl. old settings files without the key) → default.
        assert_eq!(effective_worker_concurrency(None), DEFAULT_WORKER_CONCURRENCY);
        assert_eq!(effective_worker_concurrency(Some(4)), 4);
        // Out-of-range / zero values never break queue behavior.
        assert_eq!(effective_worker_concurrency(Some(0)), DEFAULT_WORKER_CONCURRENCY);
        assert_eq!(effective_worker_concurrency(Some(99)), DEFAULT_WORKER_CONCURRENCY);
        // Serde round-trip: missing key and explicit null both mean "no override".
        let missing: NotebookConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(missing.worker_concurrency, None);
        let nulled: NotebookConfig =
            serde_json::from_value(serde_json::json!({ "workerConcurrency": null })).unwrap();
        assert_eq!(nulled.worker_concurrency, None);
    }

    #[test]
    fn runtime_config_roundtrips_camel_case() {
        let cfg = RuntimeConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();

        // Wire format must use camelCase keys matching the TS AppSettings
        // interface exactly — no mapping layer on either side.
        assert!(json.contains("\"vaultPath\""), "expected vaultPath key: {json}");
        assert!(json.contains("\"similarityThreshold\""));
        assert!(json.contains("\"embeddingThreads\""));
        assert!(json.contains("\"versionRetentionDays\""));
        assert!(json.contains("\"injectUserProfile\""));
        assert!(json.contains("\"provider\""));
        assert!(json.contains("\"themeStyle\""));
        assert!(json.contains("\"themeMode\""));
        assert!(json.contains("\"backgroundPattern\""));
        assert!(json.contains("\"userProfile\""));
        assert!(json.contains("\"accentColor\""));
        assert!(json.contains("\"hoverGlowColor\""));
        assert!(json.contains("\"graphNodeColor\""));
        assert!(json.contains("\"appIcon\""));
        assert!(json.contains("\"sidebarStatusText\""));
        assert!(json.contains("\"liquidGlassOpacity\""));
        assert!(json.contains("\"backgroundEnvironment\""));

        let back: RuntimeConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.appearance.background_pattern, "grid");
        assert_eq!(back.appearance.default_graph_mode, "3d");
        assert_eq!(back.appearance.accent_color, "#38BDF8");
        assert_eq!(back.appearance.app_icon, "");
        assert!((back.linking.similarity_threshold - 0.70).abs() < 1e-6);
        assert_eq!(back.linking.embedding_threads, 1);
        assert_eq!(back.system.version_retention_days, 0);
    }
}


pub fn provider_key(config: &OmniRouteConfig) -> Result<String, String> {
    if !config.credential_ref.is_empty() {
        keyring::Entry::new("com.prism.app.models", &config.credential_ref).map_err(|_| "Credential store unavailable")?
            .get_password().map_err(|_| "Provider credential unavailable; unlock the credential store or configure the provider again".into())
    } else { Ok(config.api_key.clone()) }
}

fn migrate_key(config:&mut OmniRouteConfig)->Result<(),String>{
 if config.api_key.is_empty(){return Ok(());}
 let reference=uuid::Uuid::new_v4().to_string();
 let entry=keyring::Entry::new("com.prism.app.models",&reference).map_err(|_|"Credential store unavailable")?;
 entry.set_password(&config.api_key).map_err(|_|"Cannot save provider credential")?;
 if entry.get_password().map_err(|_|"Cannot verify provider credential")?!=config.api_key{return Err("Credential verification failed".into());}
 config.credential_ref=reference;config.api_key.clear();Ok(())
}

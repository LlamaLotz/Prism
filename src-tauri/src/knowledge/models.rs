//! All managed external content requests require a Rust-side policy decision.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
#[derive(Clone, Serialize, Deserialize, Default, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyMode {
    StrictLocal,
    #[default]
    AskBeforeCloud,
    Hybrid,
    CloudAllowed,
}
#[derive(Clone, Copy, Serialize, Deserialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestTimeoutMode {
    #[default]
    UntilFailure,
    Custom,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelSettings {
    pub privacy: PrivacyMode,
    pub idle_seconds: u64,
    pub routes: std::collections::HashMap<String, String>,
    pub providers: Vec<ConfiguredModel>,
    pub request_timeout_mode: RequestTimeoutMode,
    pub request_timeout_seconds: u64,
}
impl Default for ModelSettings {
    fn default() -> Self {
        Self {
            privacy: PrivacyMode::AskBeforeCloud,
            idle_seconds: 300,
            routes: Default::default(),
            providers: vec![],
            request_timeout_mode: RequestTimeoutMode::UntilFailure,
            request_timeout_seconds: 180,
        }
    }
}
impl ModelSettings {
    /// `None` means no total request deadline (the historical behavior).
    /// Custom deadlines are clamped so a saved config cannot pin a request
    /// forever or abort before a handshake can finish.
    pub fn request_timeout(&self) -> Option<Duration> {
        match self.request_timeout_mode {
            RequestTimeoutMode::UntilFailure => None,
            RequestTimeoutMode::Custom => Some(Duration::from_secs(
                self.request_timeout_seconds.clamp(10, 3600),
            )),
        }
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredModel {
    pub id: String,
    pub name: String,
    pub config: crate::config::OmniRouteConfig,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub destination: String,
    pub task: String,
    pub scope: String,
    pub payload_hash: String,
    pub vault_id: String,
    #[serde(skip)]
    pub generation: String,
    #[serde(skip)]
    pub expires: Instant,
    #[serde(skip)]
    pub decision: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequest {
    #[serde(default)]
    pub provider_id: Option<String>,
    pub task: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub vault_path: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}
#[tauri::command]
pub fn list_approvals(app: tauri::AppHandle) -> Result<Vec<Approval>, String> {
    let s = super::current(&app)?;
    let runtime = app.state::<super::KnowledgeRuntime>();
    let mut a = runtime.approvals.lock().unwrap();
    a.retain(|_, a| a.expires > Instant::now() && a.generation == s.generation);
    Ok(a.values()
        .filter(|a| a.decision.is_none())
        .cloned()
        .collect())
}
#[tauri::command]
pub fn resolve_approval(app: tauri::AppHandle, id: String, approved: bool) -> Result<(), String> {
    let scope = super::current(&app)?;
    let runtime = app.state::<super::KnowledgeRuntime>();
    let mut guard = runtime.approvals.lock().unwrap();
    let a = guard.get_mut(&id).ok_or("Approval expired")?;
    if a.generation != scope.generation || a.expires <= Instant::now() {
        return Err("Approval expired".into());
    }
    a.decision = Some(approved);
    Ok(())
}

#[derive(Debug, PartialEq)]
enum PolicyDecision {
    Allow,
    Ask,
    Deny,
}
fn policy(mode: &PrivacyMode, local: bool, explicit_cloud: bool) -> PolicyDecision {
    if local {
        return PolicyDecision::Allow;
    }
    match mode {
        PrivacyMode::StrictLocal => PolicyDecision::Deny,
        PrivacyMode::CloudAllowed => PolicyDecision::Allow,
        PrivacyMode::Hybrid if explicit_cloud => PolicyDecision::Allow,
        _ => PolicyDecision::Ask,
    }
}

pub fn authorize(
    app: &tauri::AppHandle,
    destination: &str,
    task: &str,
    payload: &str,
    local: bool,
    explicit_cloud: bool,
) -> Result<(), String> {
    let settings = crate::config::load_runtime_config(app).unwrap_or_default();
    match policy(&settings.models.privacy, local, explicit_cloud) {
        PolicyDecision::Allow => return Ok(()),
        PolicyDecision::Deny => {
            return Err("Strict Local blocks this external content request".into())
        }
        PolicyDecision::Ask => {}
    }
    let scope = super::current(app)?;
    let runtime = app.state::<super::KnowledgeRuntime>();
    let id = uuid::Uuid::new_v4().to_string();
    let approval = Approval {
        id: id.clone(),
        destination: destination.into(),
        task: task.into(),
        scope: if task == "EXTRACT" {
            "The subprocess can read the selected source and vault. Its external requests cannot be inspected individually.".into()
        } else {
            format!("{} bytes of request content", payload.len())
        },
        payload_hash: super::blocks::hash(payload),
        vault_id: scope.vault_id.clone(),
        generation: scope.generation.clone(),
        expires: Instant::now() + Duration::from_secs(600),
        decision: None,
    };
    super::jobs::approval_wait(true)?;
    runtime
        .approvals
        .lock()
        .unwrap()
        .insert(id.clone(), approval);
    let c = crate::db::init_db(app)?;
    super::emit(app, &c, &scope.vault_id, "approval_required", &id)?;
    loop {
        if let Err(error) = super::jobs::checkpoint() {
            runtime.approvals.lock().unwrap().remove(&id);
            return Err(error);
        }
        let mode = crate::config::load_runtime_config(app)
            .unwrap_or_default()
            .models
            .privacy;
        if mode == PrivacyMode::StrictLocal || super::current(app)?.generation != scope.generation {
            runtime.approvals.lock().unwrap().remove(&id);
            return Err("Privacy policy or vault changed".into());
        }
        {
            let mut guard = runtime.approvals.lock().unwrap();
            let a = guard.get(&id).ok_or("Approval expired")?;
            if a.expires <= Instant::now() {
                guard.remove(&id);
                return Err("Cloud approval timed out".into());
            }
            if let Some(yes) = a.decision {
                guard.remove(&id);
                drop(guard);
                return if yes {
                    super::jobs::approval_wait(false)
                } else {
                    Err("Cloud request denied".into())
                };
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

static CANCELS: OnceLock<Mutex<HashMap<String, Vec<Arc<tokio::sync::Notify>>>>> = OnceLock::new();

fn cancels() -> &'static Mutex<HashMap<String, Vec<Arc<tokio::sync::Notify>>>> {
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Removes its notify entry when the model call ends, including on timeout,
/// cancellation, or an early provider error.
struct CancelRegistration {
    request_id: String,
    notify: Arc<tokio::sync::Notify>,
}

impl CancelRegistration {
    fn register(request_id: &str) -> Self {
        let notify = Arc::new(tokio::sync::Notify::new());
        cancels()
            .lock()
            .unwrap()
            .entry(request_id.to_string())
            .or_default()
            .push(notify.clone());
        Self {
            request_id: request_id.to_string(),
            notify,
        }
    }
}

impl Drop for CancelRegistration {
    fn drop(&mut self) {
        if let Ok(mut map) = cancels().lock() {
            if let Some(entries) = map.get_mut(&self.request_id) {
                entries.retain(|notify| !Arc::ptr_eq(notify, &self.notify));
                if entries.is_empty() {
                    map.remove(&self.request_id);
                }
            }
        }
    }
}

/// Wakes every active model call registered under `request_id`. A call that
/// has not reached its `select!` yet still observes the stored permit.
pub fn cancel_model_request(request_id: &str) {
    let entries = cancels()
        .lock()
        .ok()
        .and_then(|map| map.get(request_id).cloned())
        .unwrap_or_default();
    for notify in entries {
        // A stored permit closes the registration/await race; waking current
        // waiters covers calls already inside the select.
        notify.notify_waiters();
        notify.notify_one();
    }
}

#[tauri::command(rename = "cancel_model_request")]
pub fn cancel_model_request_command(request_id: String) -> Result<(), String> {
    cancel_model_request(&request_id);
    Ok(())
}

#[tauri::command]
pub async fn execute_model(app: tauri::AppHandle, request: ModelRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = super::blocks::hash(&format!(
            "{}:{}:{}:{}",
            request.task,
            serde_json::to_string(&request.messages).map_err(|e| e.to_string())?,
            serde_json::to_string(&crate::config::load_runtime_config(&app))
                .map_err(|e| e.to_string())?,
            request.request_id.as_deref().unwrap_or("")
        ));
        super::jobs::run(
            &app,
            "MODEL",
            80,
            &key,
            serde_json::json!({"task":request.task}),
            |_| tauri::async_runtime::block_on(execute(&app, request)),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
pub(crate) async fn execute(app: &tauri::AppHandle, request: ModelRequest) -> Result<String, String> {
    execute_inner(app, request, None).await
}
pub(crate) async fn execute_stream<F: Fn(&str) + Send + Sync>(app: &tauri::AppHandle, request: ModelRequest, callback: F) -> Result<String, String> {
    execute_inner(app, request, Some(&callback)).await
}
fn emit_phase(
    app: &tauri::AppHandle,
    vault_path: Option<&str>,
    session_id: Option<&str>,
    request_id: Option<&str>,
    phase: &str,
) {
    let (Some(vault_path), Some(session_id), Some(request_id)) =
        (vault_path, session_id, request_id)
    else {
        return;
    };
    let _ = app.emit(
        "study-chat-phase",
        serde_json::json!({
            "vaultPath": vault_path,
            "sessionId": session_id,
            "requestId": request_id,
            "phase": phase,
        }),
    );
}

fn reqwest_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "TIMEOUT: The AI request timed out".into()
    } else if error.is_connect() {
        "SERVICE_UNAVAILABLE: Provider connection failed".into()
    } else if error.is_body() || error.is_decode() {
        "CONNECTION_LOST: Provider response was interrupted; retry manually".into()
    } else {
        "PROVIDER_ERROR: Request failed; it may have reached the provider. Retry manually.".into()
    }
}

fn provider_detail(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let message = value
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(|message| message.as_str())
        .or_else(|| value.get("message").and_then(|message| message.as_str()))
        .or_else(|| value.get("error").and_then(|error| error.as_str()))?;
    let mut detail = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if detail.len() > 240 {
        detail.truncate(240);
        detail.push('…');
    }
    (!detail.is_empty()).then_some(detail)
}

fn status_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = provider_detail(body);
    let code = status.as_u16();
    if code == 408 || code == 504 {
        return match detail {
            Some(detail) => format!("TIMEOUT: Provider timed out ({code}): {detail}"),
            None => format!("TIMEOUT: Provider timed out ({code})"),
        };
    }

    let lower = body.to_lowercase();
    let authentication = lower.contains("api_key_invalid")
        || lower.contains("api key not valid")
        || lower.contains("invalid api key")
        || lower.contains("unauthenticated")
        || lower.contains("permission denied");
    let missing = lower.contains("not found")
        || lower.contains("does not exist")
        || lower.contains("unsupported model")
        || lower.contains("not supported for");
    let limited = lower.contains("resource_exhausted")
        || lower.contains("rate limit")
        || lower.contains("quota");
    let (kind, headline) = if code == 401 || code == 403 || authentication {
        ("AUTHENTICATION", "Provider rejected the credentials")
    } else if code == 404 || missing {
        (
            "MODEL_OR_ENDPOINT_MISSING",
            "Provider could not find the model or endpoint",
        )
    } else if code == 429 || limited {
        ("RATE_LIMITED", "Provider rate limited the request")
    } else {
        ("PROVIDER_ERROR", "Provider request failed")
    };

    match detail {
        Some(detail) => format!("{kind}: {headline} ({code}): {detail}"),
        None => format!("{kind}: {headline} ({code})"),
    }
}

/// Waits on a reqwest future while polling the job checkpoint every 100 ms, so
/// chat cancellation is observed even before the provider sends a first byte.
async fn polled<T>(
    future: impl std::future::Future<Output = Result<T, reqwest::Error>>,
) -> Result<T, String> {
    let mut future = std::pin::pin!(future);
    loop {
        tokio::select! {
            result = &mut future => return result.map_err(|error| reqwest_error(&error)),
            _ = tokio::time::sleep(Duration::from_millis(100)) => super::jobs::checkpoint()?,
        }
    }
}

async fn execute_inner(app: &tauri::AppHandle, request: ModelRequest, callback: Option<&(dyn Fn(&str) + Send + Sync)>) -> Result<String, String> {
    if !["CHAT", "SUMMARIZE", "TAG", "FORMAT", "CLASSIFY", "LINK_SUGGEST", "AI_SCAN", "RESEARCH"].contains(&request.task.as_str()) {
        return Err("Model capability is not available for this task".into());
    }
    let task = request.task.clone();
    let request_id = request.request_id.clone();
    let vault_path = request.vault_path.clone();
    let session_id = request.session_id.clone();
    // Registration precedes authorization so a cancel issued while the user is
    // deciding is retained; the request timer below still starts afterwards.
    let cancel = request_id.as_deref().map(CancelRegistration::register);
    let cfg = crate::config::load_runtime_config(app).ok_or("Configure an AI provider first")?;
    let model = resolve_model_config(request.provider_id.as_deref(), &task, &cfg.models, &cfg.omni_route)?;
    if model.base_url.is_empty() || model.model.is_empty() {
        return Err("Configure an AI provider and model first".into());
    }
    let mut messages = request.messages;
    if messages
        .iter()
        .any(|m| !["system", "user", "assistant"].contains(&m.role.as_str()))
    {
        return Err("Invalid message role".into());
    }
    if model.inject_user_profile && !model.user_profile.trim().is_empty() {
        messages.insert(
            0,
            Message {
                role: "system".into(),
                content: format!("User profile:\n{}", model.user_profile),
            },
        );
    }
    let is_anthropic = model.provider == "anthropic";
    let mut base = model.base_url.trim_end_matches('/').to_string();
    if !base.ends_with("/v1") && is_anthropic {
        base.push_str("/v1");
    }
    let url = format!(
        "{base}/{}",
        if is_anthropic {
            "messages"
        } else {
            "chat/completions"
        }
    );
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid provider URL")?;
    if !["https", "http"].contains(&parsed.scheme())
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Invalid provider URL".into());
    }
    let model_name = if model.provider == "google" {
        model.model.to_lowercase()
    } else {
        model.model.clone()
    };
    let mut payload = if is_anthropic {
        let system = messages
            .iter()
            .filter(|m| m.role == "system")
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        serde_json::json!({"model":model_name,"system":system,"messages":messages.iter().filter(|m|m.role!="system").collect::<Vec<_>>(),"max_tokens":4096,"temperature":model.temperature})
    } else {
        serde_json::json!({"model":model_name,"messages":messages,"temperature":model.temperature})
    };
    if callback.is_some() { payload["stream"] = serde_json::json!(true); }
    // A configurable localhost server may itself forward to cloud. Treat it as external.
    authorize(
        app,
        parsed.origin().ascii_serialization().as_str(),
        &task,
        &payload.to_string(),
        false,
        cfg.models.routes.contains_key(&task),
    )?;
    // The consent wait above is deliberately excluded from the request deadline.
    let timeout = cfg.models.request_timeout();
    let key = crate::config::provider_key(model)?;
    let runtime = app.state::<super::KnowledgeRuntime>();
    let client = runtime.http.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(30))
            .build()
            .expect("Rustls HTTP client initialization")
    });
    let mut req = client.post(&url).json(&payload);
    if is_anthropic {
        req = req
            .header("anthropic-version", "2023-06-01")
            .header("x-api-key", key);
    } else if !key.is_empty() {
        req = req.bearer_auth(key);
    }
    let phase = |label: &str| {
        emit_phase(
            app,
            vault_path.as_deref(),
            session_id.as_deref(),
            request_id.as_deref(),
            label,
        )
    };
    let exchange = async {
        phase("Contacting provider");
        let mut response = polled(req.send()).await?;
        let status = response.status();
        if !status.is_success() {
            let detail = tokio::time::timeout(Duration::from_secs(10), response.text())
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
            return Err(status_error(status, &detail));
        }
        phase("Waiting for model");
        if let Some(callback) = callback {
            if response.headers().get("content-type").and_then(|v|v.to_str().ok()).unwrap_or("").contains("text/event-stream") {
                let mut buffer=Vec::new();let mut text=String::new();let mut complete=false;let mut first_chunk=true;
                loop {
                    super::jobs::checkpoint()?;
                    let chunk=tokio::select! {
                        result=response.chunk()=>result.map_err(|_|"CONNECTION_LOST: Provider stream interrupted; retry manually")?,
                        _=tokio::time::sleep(Duration::from_millis(100))=>continue,
                    };
                    let Some(chunk)=chunk else {break};
                    if first_chunk { phase("Reading response"); first_chunk=false; }
                    buffer.extend_from_slice(&chunk);
                    if buffer.len()>8*1024*1024 || text.len()>8*1024*1024{return Err("Provider response exceeds 8 MB".into());}
                    while let Some(end)=buffer.iter().position(|b|*b==b'\n') {
                        let line=String::from_utf8(buffer.drain(..=end).collect()).map_err(|_|"Invalid provider text")?;
                        if let Some(data)=line.trim().strip_prefix("data:") {
                            let data=data.trim();if data=="[DONE]"{complete=true;continue;}
                            let item:serde_json::Value=serde_json::from_str(data).map_err(|_|"Invalid provider stream")?;
                            if let Some(error)=item.get("error"){
                                let detail=error.get("message").and_then(|message|message.as_str()).unwrap_or("Provider reported an error while streaming");
                                return Err(format!("PROVIDER_ERROR: {detail}"));
                            }
                            if item["type"]=="message_stop" || !item["choices"][0]["finish_reason"].is_null(){complete=true;}
                            let delta=if is_anthropic {item["delta"]["text"].as_str()}else{item["choices"][0]["delta"]["content"].as_str()};
                            if let Some(delta)=delta {text.push_str(delta);callback(&text);}
                        }
                    }
                }
                if !complete || text.trim().is_empty(){return Err("CONNECTION_LOST: Provider stream ended before a complete response; retry manually".into());}
                return Ok(text);
            }
        }
        phase("Reading response");
        let body: serde_json::Value = polled(response.json()).await?;
        let text = if is_anthropic {
            body["content"].as_array().map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        } else {
            body["choices"][0]["message"]["content"]
                .as_str()
                .map(String::from)
        };
        if let (Some(callback), Some(text)) = (callback, text.as_ref()) { callback(text); }
        text.ok_or("Provider returned no text".into())
    };
    let operation = async {
        match timeout {
            Some(limit) => match tokio::time::timeout(limit, exchange).await {
                Ok(result) => result,
                Err(_) => Err(format!(
                    "TIMEOUT: The AI request timed out after {} seconds",
                    limit.as_secs()
                )),
            },
            None => exchange.await,
        }
    };
    match &cancel {
        Some(cancel) => tokio::select! {
            biased;
            _ = cancel.notify.notified() => Err("CANCELLED: Operation cancelled".into()),
            result = operation => result,
        },
        None => operation.await,
    }
}

/// Resolve a conversation's saved profile ID separately from the provider
/// name stored in the global assistant configuration. `Some("")` is the
/// explicit Default model selection and must use `default`, even if a task
/// route exists; `None` inherits the configured task route.
fn resolve_model_config<'a>(
    provider_id: Option<&'a str>,
    task: &str,
    settings: &'a ModelSettings,
    default: &'a crate::config::OmniRouteConfig,
) -> Result<&'a crate::config::OmniRouteConfig, String> {
    let route = provider_id
        .filter(|id| !id.is_empty())
        .or_else(|| if provider_id.is_none() { settings.routes.get(task).map(String::as_str) } else { None });
    if let Some(id) = route {
        if let Some(profile) = settings.providers.iter().find(|profile| profile.id == id) {
            if !profile.capabilities.iter().any(|capability| capability == "generation") {
                return Err("Selected model does not support generation".into());
            }
            return Ok(&profile.config);
        }
        if id != "configured" && id != default.model {
            return Err("Selected provider unavailable".into());
        }
    }
    Ok(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_selection_uses_global_provider_while_saved_and_invalid_ids_stay_distinct() {
        let mut default = crate::config::OmniRouteConfig::default();
        default.provider = "google".into();
        default.base_url = "https://generativelanguage.googleapis.com/v1beta/openai/".into();
        default.model = "gemini-2.5-flash".into();
        default.api_key = "fixture-only-secret".into();
        let saved = crate::config::OmniRouteConfig { provider: "openai".into(), model: "saved-model".into(), ..Default::default() };
        let settings = ModelSettings {
            routes: [("CHAT".into(), "saved-profile".into())].into_iter().collect(),
            providers: vec![ConfiguredModel { id: "saved-profile".into(), name: "Saved".into(), config: saved.clone(), capabilities: vec!["generation".into()] }],
            ..Default::default()
        };

        // The UI's empty string is explicit Default model, independent of any
        // task-level route; it resolves to global Gemini configuration.
        let selected = resolve_model_config(Some(""), "CHAT", &settings, &default).unwrap();
        assert_eq!(selected.provider, "google");
        assert_eq!(selected.base_url, "https://generativelanguage.googleapis.com/v1beta/openai/");
        assert_eq!(selected.model, "gemini-2.5-flash");

        assert_eq!(resolve_model_config(Some("saved-profile"), "CHAT", &settings, &default).unwrap().model, "saved-model");
        assert_eq!(resolve_model_config(None, "CHAT", &settings, &default).unwrap().model, "saved-model");
        assert_eq!(resolve_model_config(Some("removed-profile"), "CHAT", &settings, &default).unwrap_err(), "Selected provider unavailable");
    }

    #[test]
    fn request_timeout_defaults_and_deserializes_missing_fields() {
        let settings = ModelSettings::default();
        assert_eq!(
            settings.request_timeout_mode,
            RequestTimeoutMode::UntilFailure
        );
        assert_eq!(settings.request_timeout_seconds, 180);
        assert_eq!(settings.request_timeout(), None);

        let parsed: ModelSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(
            parsed.request_timeout_mode,
            RequestTimeoutMode::UntilFailure
        );
        assert_eq!(parsed.request_timeout_seconds, 180);
        let json = serde_json::to_value(ModelSettings::default()).unwrap();
        assert_eq!(json["requestTimeoutMode"], "until_failure");
        assert_eq!(json["requestTimeoutSeconds"], 180);

        let parsed: ModelSettings = serde_json::from_str(
            r#"{"requestTimeoutMode":"custom","requestTimeoutSeconds":90}"#,
        )
        .unwrap();
        assert_eq!(parsed.request_timeout_mode, RequestTimeoutMode::Custom);
        assert_eq!(parsed.request_timeout(), Some(Duration::from_secs(90)));
    }

    #[test]
    fn custom_request_timeout_is_clamped() {
        let mut settings = ModelSettings {
            request_timeout_mode: RequestTimeoutMode::Custom,
            request_timeout_seconds: 300,
            ..Default::default()
        };
        assert_eq!(settings.request_timeout(), Some(Duration::from_secs(300)));
        settings.request_timeout_seconds = 0;
        assert_eq!(settings.request_timeout(), Some(Duration::from_secs(10)));
        settings.request_timeout_seconds = 24 * 60 * 60;
        assert_eq!(settings.request_timeout(), Some(Duration::from_secs(3600)));
    }

    #[test]
    fn privacy_defaults_and_localhost_forwarders() {
        assert_eq!(
            ModelSettings::default().privacy,
            PrivacyMode::AskBeforeCloud
        );
        assert_eq!(
            policy(&PrivacyMode::StrictLocal, false, true),
            PolicyDecision::Deny
        );
        assert_eq!(
            policy(&PrivacyMode::StrictLocal, true, false),
            PolicyDecision::Allow
        );
        assert_eq!(
            policy(&PrivacyMode::AskBeforeCloud, false, true),
            PolicyDecision::Ask
        );
        assert_eq!(
            policy(&PrivacyMode::Hybrid, false, false),
            PolicyDecision::Ask
        );
        assert_eq!(
            policy(&PrivacyMode::Hybrid, false, true),
            PolicyDecision::Allow
        );
        assert_eq!(
            policy(&PrivacyMode::CloudAllowed, false, false),
            PolicyDecision::Allow
        );
    }

    #[test]
    fn provider_errors_surface_actionable_details() {
        let auth = status_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}"#,
        );
        assert!(auth.starts_with("AUTHENTICATION:"));
        assert!(auth.contains("API key not valid"));

        let missing = status_error(
            reqwest::StatusCode::NOT_FOUND,
            r#"{"error":{"message":"models/gemini-3.8-flash is not found"}}"#,
        );
        assert!(missing.starts_with("MODEL_OR_ENDPOINT_MISSING:"));
        assert!(missing.contains("models/gemini-3.8-flash"));

        let limited = status_error(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            r#"{"error":{"message":"Resource exhausted"}}"#,
        );
        assert!(limited.starts_with("RATE_LIMITED:"));

        let generic = status_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"Bad   request"}}"#,
        );
        assert!(generic.starts_with("PROVIDER_ERROR:"));
        assert!(generic.contains("Bad request"));
    }
}

/// The built-in formatter is deterministic and cannot send content externally.
pub fn format(content: &str) -> String {
    crate::engine::formatter::format_note_content(content)
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    state: String,
    command: Option<String>,
    message: String,
}

/// Content-free, explicit readiness checks. Never installs or starts a process.
#[tauri::command]
pub async fn model_service_status(app: tauri::AppHandle, task: String) -> Result<ServiceStatus, String> {
    super::current(&app)?;
    let cfg = crate::config::load_runtime_config(&app).ok_or("Configure an AI provider first")?;
    let model = match cfg.models.routes.get(&task) {
        Some(id) => &cfg.models.providers.iter().find(|p| &p.id == id).ok_or("Selected provider unavailable")?.config,
        None => &cfg.omni_route,
    };
    let url = reqwest::Url::parse(&model.base_url).map_err(|_| "Invalid provider URL")?;
    let local = url.host_str().is_some_and(|host| host == "localhost" || host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()));
    let command = match model.provider.as_str() {
        "ollama" if local => Some("ollama serve".into()),
        "omniroute" if local => Some("omniroute".into()),
        _ => None,
    };
    if !local || command.is_none() {
        return Ok(ServiceStatus { state: "manual".into(), command: None, message: "Check the configured provider address, credentials, and service. Prism does not start remote or custom services.".into() });
    }
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(3)).build().map_err(|e| e.to_string())?;
    let key = crate::config::provider_key(model)?;
    let mut request = client.get(format!("{}/models", model.base_url.trim_end_matches('/')));
    if !key.is_empty() { request = request.bearer_auth(key); }
    let (state, message) = match request.send().await {
        Ok(r) if r.status().is_success() => ("ready", "Service is reachable. Retry your request when ready; model availability is checked when dispatched."),
        Ok(r) if matches!(r.status().as_u16(), 401 | 403) => ("authentication", "Service is running, but credentials were rejected. Check provider settings."),
        Ok(_) => ("configuration", "Service responded, but its models endpoint is unavailable. Check the configured base URL."),
        Err(_) => ("unavailable", "Start the installed service in your terminal, then check again. No software or models will be installed by Prism."),
    };
    Ok(ServiceStatus { state: state.into(), command, message: message.into() })
}

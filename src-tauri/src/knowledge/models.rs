//! All managed external content requests require a Rust-side policy decision.
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::Manager;
#[derive(Clone, Serialize, Deserialize, Default, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyMode {
    StrictLocal,
    #[default]
    AskBeforeCloud,
    Hybrid,
    CloudAllowed,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelSettings {
    pub privacy: PrivacyMode,
    pub idle_seconds: u64,
    pub routes: std::collections::HashMap<String, String>,
    pub providers: Vec<ConfiguredModel>,
}
impl Default for ModelSettings {
    fn default() -> Self {
        Self {
            privacy: PrivacyMode::AskBeforeCloud,
            idle_seconds: 300,
            routes: Default::default(),
            providers: vec![],
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
    pub task: String,
    pub messages: Vec<Message>,
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

#[tauri::command]
pub async fn execute_model(app: tauri::AppHandle, request: ModelRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = super::blocks::hash(&format!(
            "{}:{}:{}",
            request.task,
            serde_json::to_string(&request.messages).map_err(|e| e.to_string())?,
            serde_json::to_string(&crate::config::load_runtime_config(&app))
                .map_err(|e| e.to_string())?
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
async fn execute(app: &tauri::AppHandle, request: ModelRequest) -> Result<String, String> {
    if !["CHAT", "SUMMARIZE", "TAG", "FORMAT", "CLASSIFY"].contains(&request.task.as_str()) {
        return Err("Model capability is not available for this task".into());
    }
    let cfg = crate::config::load_runtime_config(app).ok_or("Configure an AI provider first")?;
    let route = cfg.models.routes.get(&request.task);
    let configured = route.and_then(|id| cfg.models.providers.iter().find(|p| &p.id == id));
    let model = if let Some(provider) = configured {
        if !provider.capabilities.iter().any(|c| c == "generation") {
            return Err("Selected model does not support generation".into());
        }
        &provider.config
    } else {
        if route.is_some_and(|r| r != "configured" && r != &cfg.omni_route.model) {
            return Err("The selected task model is unavailable".into());
        }
        &cfg.omni_route
    };
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
    let payload = if is_anthropic {
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
    // A configurable localhost server may itself forward to cloud. Treat it as external.
    authorize(
        app,
        parsed.origin().ascii_serialization().as_str(),
        &request.task,
        &payload.to_string(),
        false,
        cfg.models.routes.contains_key(&request.task),
    )?;
    let key = crate::config::provider_key(model)?;
    let runtime = app.state::<super::KnowledgeRuntime>();
    let client = runtime.http.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(180))
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
    let response = req.send().await.map_err(|_| "Provider connection failed")?;
    if !response.status().is_success() {
        return Err(format!("Provider request failed ({})", response.status()));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "Invalid provider response")?;
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
    text.ok_or("Provider returned no text".into())
}

#[cfg(test)]
mod tests {
    use super::*;
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
}

/// The built-in formatter is deterministic and cannot send content externally.
pub fn format(content: &str) -> String {
    crate::engine::formatter::format_note_content(content)
}

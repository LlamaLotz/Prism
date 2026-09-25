"""Prism-owned esperanto profiles for the Co-Pilot-parity Notebook providers.

The upstream provider registry (open_notebook/ai/provider_registry.py) names
these providers, but esperanto only knows a fixed set of first-class
providers plus its builtin profiles (deepseek, xai, dashscope, minimax,
novita, ppq, omlx, ...). This module registers user-level
OpenAICompatibleProfiles for the rest, so chat/inference resolves them
instead of raising "Provider not supported".

Credential config (per-credential base URL + API key from
Credential.to_esperanto_config) always wins over the profile defaults below:
profiles only supply endpoint/key-env fallbacks. All profiles are
language-only — chat parity is the goal; other modalities keep using the
generic `openai_compatible` provider.

Imported for its side effect by both backend entry points (notebook/api and
notebook/worker run in separate processes and both invoke models), via
notebook/prism_api.py and notebook/prism_worker.py. Shipped into the runtime
by scripts/patch-notebook-runtime.py alongside those adapters.
"""

import warnings

# name, display name, default base URL, key env var, default chat model,
# requires_api_key. Base URLs mirror src/services/apiProviders.ts.
_PROFILES = (
    ("together", "Together AI", "https://api.together.xyz/v1",
     "TOGETHER_API_KEY", "meta-llama/Llama-3.3-70B-Instruct-Turbo", True),
    ("fireworks", "Fireworks AI", "https://api.fireworks.ai/inference/v1",
     "FIREWORKS_API_KEY", "accounts/fireworks/models/llama-v3p3-70b-instruct", True),
    ("cerebras", "Cerebras", "https://api.cerebras.ai/v1",
     "CEREBRAS_API_KEY", "llama-3.3-70b", True),
    ("nvidia", "NVIDIA NIM", "https://integrate.api.nvidia.com/v1",
     "NVIDIA_API_KEY", "meta/llama-3.3-70b-instruct", True),
    ("siliconflow", "SiliconFlow", "https://api.siliconflow.cn/v1",
     "SILICONFLOW_API_KEY", "deepseek-ai/DeepSeek-V3", True),
    ("huggingface", "Hugging Face", "https://router.huggingface.co/v1",
     "HF_TOKEN", "meta-llama/Llama-3.3-70B-Instruct", True),
    ("meta", "Meta Llama", "https://api.llama-api.com/v1",
     "LLAMA_API_KEY", "meta-llama-3.3-70b-instruct", True),
    ("agentrouter", "AgentRouter", "https://api.agentrouter.ai/v1",
     "AGENTROUTER_API_KEY", "gpt-4o", True),
    ("bazaarlink", "BazaarLink", "https://bazaarlink.ai/api/v1",
     "BAZAARLINK_API_KEY", "openai/gpt-4o", True),
    # Account-specific endpoint: the credential's own base URL (full URL with
    # the user's account ID) always overrides this template at request time.
    ("cloudflare", "Cloudflare Workers AI",
     "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
     "CLOUDFLARE_API_TOKEN", "@cf/meta/llama-3.3-70b-instruct", True),
    ("pollinations", "Pollinations", "https://text.pollinations.ai/openai",
     "POLLINATIONS_API_KEY", "openai", False),
    ("scaleway", "Scaleway AI", "https://api.scaleway.ai/v1",
     "SCALEWAY_API_KEY", "llama-3.3-70b-instruct", True),
    ("lmstudio", "LM Studio (local)", "http://localhost:1234/v1",
     "LMSTUDIO_API_KEY", "local-model", False),
    ("omniroute", "OmniRoute (local gateway)", "http://localhost:20128/v1",
     "OMNIROUTE_API_KEY", "auto", False),
    # perplexity is intentionally absent: esperanto supports it first-class.
)


def register_copilot_profiles() -> int:
    """Register every profile above. Returns the count registered."""
    from esperanto import AIFactory
    from esperanto.providers.llm.profiles import OpenAICompatibleProfile

    count = 0
    for name, display_name, base_url, api_key_env, default_model, requires_key in _PROFILES:
        with warnings.catch_warnings():
            # Profiles shadow nothing (names are new), but stay quiet anyway.
            warnings.simplefilter("ignore")
            AIFactory.register_openai_compatible_profile(
                OpenAICompatibleProfile(
                    name=name,
                    display_name=display_name,
                    base_url=base_url,
                    api_key_env=api_key_env,
                    default_models={"language": default_model},
                    requires_api_key=requires_key,
                )
            )
        count += 1
    return count


try:
    _REGISTERED = register_copilot_profiles()
    print(f"[providers] registered {_REGISTERED} Co-Pilot-parity model profiles")
except Exception as e:  # noqa: BLE001 - startup must never fail over profiles
    print(f"[providers] WARNING: Co-Pilot-parity profiles unavailable: {e}")

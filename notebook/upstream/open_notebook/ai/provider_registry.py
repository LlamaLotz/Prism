"""
Provider Registry — the single source of truth for AI provider metadata.

Adding a provider used to require keeping ~6 independent dicts in sync
(env config, modalities, test models, discovery table, API Literal,
frontend table). Now the backend surfaces are all derived from the
`PROVIDERS` registry below:

- `api/credentials_service.py` `PROVIDER_ENV_CONFIG` / `PROVIDER_MODALITIES`
- `open_notebook/ai/connection_tester.py` `TEST_MODELS`
- `open_notebook/ai/model_discovery.py` `OPENAI_COMPAT_PROVIDERS`
- `GET /api/providers` (api/routers/providers.py)

One place still needs a manual edit when adding a provider — enforced by
tests (tests/test_credential_provider_validation.py): the
`SupportedProvider` Literal in `api/models.py` (typing can't be built at
runtime from this dict). The frontend consumes `GET /api/providers` at
runtime, so it needs no edit.

The declaration order below is the display order the frontend renders —
`GET /api/providers` returns `PROVIDERS.values()` as declared.

This module is pure data: it must not import anything from the rest of
the project so it stays importable from anywhere without cycles.
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple


@dataclass(frozen=True)
class ProviderSpec:
    """Everything the backend needs to know about one AI provider."""

    name: str
    display_name: str
    # Default modalities offered when creating a credential for this provider.
    modalities: Tuple[str, ...]
    # Env var configuration for env-based setup/migration:
    # - required_env: ALL must be set for the provider to count as configured.
    # - required_any_env: at least ONE must be set.
    # - optional_env: read during migration but not required.
    required_env: Tuple[str, ...] = ()
    required_any_env: Tuple[str, ...] = ()
    optional_env: Tuple[str, ...] = ()
    # Cheapest model used by the provider connection test. None means the
    # test is dynamic (first available model) or handled by a bespoke tester.
    test_model: Optional[str] = None
    test_model_type: str = "language"
    # Where users get an API key / set the provider up.
    docs_url: Optional[str] = None
    # For providers exposing an OpenAI-compatible GET /models endpoint,
    # the discovery URL. Drives OPENAI_COMPAT_PROVIDERS in model_discovery.
    openai_compat_discovery_url: Optional[str] = None

    def env_config(self) -> Dict[str, List[str]]:
        """Env var config in the legacy PROVIDER_ENV_CONFIG dict shape."""
        config: Dict[str, List[str]] = {}
        if self.required_env:
            config["required"] = list(self.required_env)
        if self.required_any_env:
            config["required_any"] = list(self.required_any_env)
        if self.optional_env:
            config["optional"] = list(self.optional_env)
        return config


_LANGUAGE_ONLY = ("language",)
_ALL_MODALITIES = ("language", "embedding", "speech_to_text", "text_to_speech")


_PROVIDER_SPECS: Tuple[ProviderSpec, ...] = (
        ProviderSpec(
            name="openai",
            display_name="OpenAI",
            modalities=_ALL_MODALITIES,
            required_env=("OPENAI_API_KEY",),
            test_model="gpt-3.5-turbo",
            docs_url="https://platform.openai.com/api-keys",
            openai_compat_discovery_url="https://api.openai.com/v1/models",
        ),
        ProviderSpec(
            name="anthropic",
            display_name="Anthropic",
            modalities=_LANGUAGE_ONLY,
            required_env=("ANTHROPIC_API_KEY",),
            test_model="claude-haiku-4-5-20251001",
            docs_url="https://console.anthropic.com/settings/keys",
        ),
        ProviderSpec(
            name="google",
            display_name="Google AI",
            modalities=_ALL_MODALITIES,
            required_any_env=("GOOGLE_API_KEY", "GEMINI_API_KEY"),
            test_model="gemini-flash-latest",
            docs_url="https://aistudio.google.com/app/apikey",
        ),
        ProviderSpec(
            name="groq",
            display_name="Groq",
            modalities=("language", "speech_to_text"),
            required_env=("GROQ_API_KEY",),
            test_model="llama-3.1-8b-instant",
            docs_url="https://console.groq.com/keys",
            openai_compat_discovery_url="https://api.groq.com/openai/v1/models",
        ),
        ProviderSpec(
            name="mistral",
            display_name="Mistral AI",
            modalities=("language", "embedding", "speech_to_text", "text_to_speech"),
            required_env=("MISTRAL_API_KEY",),
            test_model="mistral-small-latest",
            docs_url="https://console.mistral.ai/api-keys/",
            openai_compat_discovery_url="https://api.mistral.ai/v1/models",
        ),
        ProviderSpec(
            name="deepseek",
            display_name="DeepSeek",
            modalities=_LANGUAGE_ONLY,
            required_env=("DEEPSEEK_API_KEY",),
            test_model="deepseek-chat",
            docs_url="https://platform.deepseek.com/api_keys",
            openai_compat_discovery_url="https://api.deepseek.com/models",
        ),
        ProviderSpec(
            name="xai",
            display_name="xAI (Grok)",
            modalities=("language", "text_to_speech"),
            required_env=("XAI_API_KEY",),
            test_model="grok-beta",
            docs_url="https://console.x.ai/",
            openai_compat_discovery_url="https://api.x.ai/v1/models",
        ),
        ProviderSpec(
            name="openrouter",
            display_name="OpenRouter",
            modalities=_ALL_MODALITIES,
            required_env=("OPENROUTER_API_KEY",),
            test_model="openai/gpt-3.5-turbo",
            docs_url="https://openrouter.ai/keys",
            openai_compat_discovery_url="https://openrouter.ai/api/v1/models",
        ),
        ProviderSpec(
            name="dashscope",
            display_name="DashScope (Qwen)",
            modalities=_LANGUAGE_ONLY,
            required_env=("DASHSCOPE_API_KEY",),
            test_model="qwen-plus",
            docs_url="https://help.aliyun.com/zh/model-studio/getting-started/",
            openai_compat_discovery_url="https://dashscope.aliyuncs.com/compatible-mode/v1/models",
        ),
        ProviderSpec(
            name="minimax",
            display_name="MiniMax",
            modalities=_LANGUAGE_ONLY,
            required_env=("MINIMAX_API_KEY",),
            test_model="MiniMax-M2.5",
            docs_url="https://platform.minimaxi.com/document/Guides",
            openai_compat_discovery_url="https://api.minimax.io/v1/models",
        ),
        ProviderSpec(
            name="novita",
            display_name="Novita",
            modalities=_LANGUAGE_ONLY,
            required_env=("NOVITA_API_KEY",),
            test_model="moonshotai/kimi-k2.5",
            docs_url="https://novita.ai/settings/key-management",
            openai_compat_discovery_url="https://api.novita.ai/openai/models",
        ),
        ProviderSpec(
            name="ppq",
            display_name="PayPerQ",
            modalities=_ALL_MODALITIES,
            required_env=("PPQ_API_KEY",),
            test_model="auto",
            docs_url="https://ppq.ai",
            # PPQ's bare /models returns only chat/language models; ?type=all is
            # required to also list embedding, STT and TTS models (PPQ is a
            # multi-modality gateway). Without it, the non-language modalities
            # this provider advertises never surface in discovery.
            openai_compat_discovery_url="https://api.ppq.ai/v1/models?type=all",
        ),
        ProviderSpec(
            name="cohere",
            display_name="Cohere",
            # Native v2 API (/v2/chat, /v2/embed) — NOT OpenAI-compatible, so no
            # openai_compat_discovery_url; discovery is bespoke (esperanto's
            # AIFactory.get_provider_models). Reranking is out of scope (#1087).
            modalities=("language", "embedding"),
            required_env=("COHERE_API_KEY",),
            test_model="command-a-03-2025",
            docs_url="https://dashboard.cohere.com/api-keys",
        ),
        ProviderSpec(
            name="voyage",
            display_name="Voyage AI",
            modalities=("embedding",),
            required_env=("VOYAGE_API_KEY",),
            test_model="voyage-3-lite",
            test_model_type="embedding",
            docs_url="https://dash.voyageai.com/api-keys",
        ),
        ProviderSpec(
            name="elevenlabs",
            display_name="ElevenLabs",
            modalities=("text_to_speech", "speech_to_text"),
            required_env=("ELEVENLABS_API_KEY",),
            test_model="eleven_multilingual_v2",
            test_model_type="text_to_speech",
            docs_url="https://elevenlabs.io/app/settings/api-keys",
        ),
        ProviderSpec(
            name="deepgram",
            display_name="Deepgram",
            modalities=("text_to_speech", "speech_to_text"),
            required_env=("DEEPGRAM_API_KEY",),
            test_model="aura-2-thalia-en",
            test_model_type="text_to_speech",
            docs_url="https://console.deepgram.com/",
        ),
        ProviderSpec(
            name="ollama",
            display_name="Ollama",
            modalities=("language", "embedding"),
            required_env=("OLLAMA_API_BASE",),
            test_model=None,  # Dynamic - uses first available model
        ),
        ProviderSpec(
            name="omlx",
            display_name="oMLX",
            modalities=("language", "embedding"),
            required_env=("OMLX_API_BASE",),
            optional_env=("OMLX_API_KEY",),
            test_model=None,  # Dynamic - uses first available model via /v1/models
            docs_url="https://github.com/lfnovo/open-notebook/blob/main/docs/5-CONFIGURATION/omlx.md",
            # No openai_compat_discovery_url: base URL is user-supplied (default
            # http://localhost:11435/v1) and API key is optional — discovery is
            # handled like openai_compatible, not the fixed-URL OPENAI_COMPAT table.
        ),
        ProviderSpec(
            name="azure",
            display_name="Azure OpenAI",
            modalities=_ALL_MODALITIES,
            required_env=(
                "AZURE_OPENAI_API_KEY",
                "AZURE_OPENAI_ENDPOINT",
                "AZURE_OPENAI_API_VERSION",
            ),
            optional_env=(
                "AZURE_OPENAI_ENDPOINT_LLM",
                "AZURE_OPENAI_ENDPOINT_EMBEDDING",
                "AZURE_OPENAI_ENDPOINT_STT",
                "AZURE_OPENAI_ENDPOINT_TTS",
            ),
            test_model="gpt-35-turbo",  # Azure OpenAI deployment name
            docs_url="https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI",
        ),
        ProviderSpec(
            name="vertex",
            display_name="Google Vertex AI",
            modalities=("language", "embedding", "text_to_speech"),
            required_env=("VERTEX_PROJECT", "VERTEX_LOCATION"),
            optional_env=("GOOGLE_APPLICATION_CREDENTIALS",),
            test_model="gemini-flash-latest",  # Uses Google Vertex AI
            docs_url="https://cloud.google.com/vertex-ai/docs/start/cloud-environment",
        ),
        ProviderSpec(
            name="openai_compatible",
            display_name="OpenAI Compatible",
            modalities=_ALL_MODALITIES,
            required_any_env=("OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_API_KEY"),
            test_model=None,  # Dynamic - uses first available model
            docs_url="https://github.com/lfnovo/open-notebook/blob/main/docs/5-CONFIGURATION/openai-compatible.md",
        ),
        ProviderSpec(
            name="anthropic_compatible",
            display_name="Anthropic Compatible",
            modalities=_LANGUAGE_ONLY,
            required_env=(
                "ANTHROPIC_COMPATIBLE_BASE_URL",
                "ANTHROPIC_COMPATIBLE_API_KEY",
            ),
            test_model=None,  # Dynamic - uses the endpoint's model list
            docs_url="https://github.com/lfnovo/open-notebook/blob/main/docs/5-CONFIGURATION/ai-providers.md",
            # No openai_compat_discovery_url: anthropic-compatible discovery uses
            # Anthropic's GET /v1/models with x-api-key + anthropic-version headers
            # (bespoke), not the OpenAI-compatible GET /models discovery table.
        ),
        # ------------------------------------------------------------------
        # Prism addition: the same providers the Co-Pilot panel offers
        # (src/services/apiProviders.ts). All are OpenAI-compatible chat
        # endpoints, executed at runtime through esperanto
        # OpenAICompatibleProfiles registered in notebook/provider_profiles.py
        # (except perplexity, which esperanto supports first-class). Kept
        # language-only: chat parity is the goal; the generic
        # `openai_compatible` provider remains the route for other modalities.
        # ------------------------------------------------------------------
        ProviderSpec(
            name="together",
            display_name="Together AI",
            modalities=_LANGUAGE_ONLY,
            required_env=("TOGETHER_API_KEY",),
            test_model="meta-llama/Llama-3.3-70B-Instruct-Turbo",
            docs_url="https://api.together.ai",
            openai_compat_discovery_url="https://api.together.xyz/v1/models",
        ),
        ProviderSpec(
            name="fireworks",
            display_name="Fireworks AI",
            modalities=_LANGUAGE_ONLY,
            required_env=("FIREWORKS_API_KEY",),
            test_model="accounts/fireworks/models/llama-v3p3-70b-instruct",
            docs_url="https://app.fireworks.ai",
            openai_compat_discovery_url="https://api.fireworks.ai/inference/v1/models",
        ),
        ProviderSpec(
            name="cerebras",
            display_name="Cerebras",
            modalities=_LANGUAGE_ONLY,
            required_env=("CEREBRAS_API_KEY",),
            test_model="llama-3.3-70b",
            docs_url="https://cloud.cerebras.ai",
            openai_compat_discovery_url="https://api.cerebras.ai/v1/models",
        ),
        ProviderSpec(
            name="nvidia",
            display_name="NVIDIA NIM",
            modalities=_LANGUAGE_ONLY,
            required_env=("NVIDIA_API_KEY",),
            test_model="meta/llama-3.3-70b-instruct",
            docs_url="https://build.nvidia.com",
            openai_compat_discovery_url="https://integrate.api.nvidia.com/v1/models",
        ),
        ProviderSpec(
            name="siliconflow",
            display_name="SiliconFlow",
            modalities=_LANGUAGE_ONLY,
            required_env=("SILICONFLOW_API_KEY",),
            test_model="deepseek-ai/DeepSeek-V3",
            docs_url="https://siliconflow.cn",
            openai_compat_discovery_url="https://api.siliconflow.cn/v1/models",
        ),
        ProviderSpec(
            name="huggingface",
            display_name="Hugging Face",
            modalities=_LANGUAGE_ONLY,
            required_env=("HF_TOKEN",),
            test_model="meta-llama/Llama-3.3-70B-Instruct",
            docs_url="https://huggingface.co/settings/tokens",
            openai_compat_discovery_url="https://router.huggingface.co/v1/models",
        ),
        ProviderSpec(
            name="meta",
            display_name="Meta Llama",
            modalities=_LANGUAGE_ONLY,
            required_env=("LLAMA_API_KEY",),
            test_model="meta-llama-3.3-70b-instruct",
            docs_url="https://llama.com",
            openai_compat_discovery_url="https://api.llama-api.com/v1/models",
        ),
        ProviderSpec(
            name="agentrouter",
            display_name="AgentRouter",
            modalities=_LANGUAGE_ONLY,
            required_env=("AGENTROUTER_API_KEY",),
            test_model="gpt-4o",
            docs_url="https://agentrouter.ai",
            openai_compat_discovery_url="https://api.agentrouter.ai/v1/models",
        ),
        ProviderSpec(
            name="bazaarlink",
            display_name="BazaarLink",
            modalities=_LANGUAGE_ONLY,
            required_env=("BAZAARLINK_API_KEY",),
            test_model="openai/gpt-4o",
            docs_url="https://bazaarlink.ai",
            openai_compat_discovery_url="https://bazaarlink.ai/api/v1/models",
        ),
        ProviderSpec(
            name="cloudflare",
            display_name="Cloudflare Workers AI",
            modalities=_LANGUAGE_ONLY,
            required_env=("CLOUDFLARE_API_TOKEN",),
            test_model="@cf/meta/llama-3.3-70b-instruct",
            docs_url="https://dash.cloudflare.com",
            # No openai_compat_discovery_url: the endpoint embeds the user's
            # account ID, so no fixed discovery URL exists. Register models
            # manually after creating the credential with its full base URL.
        ),
        ProviderSpec(
            name="perplexity",
            display_name="Perplexity",
            modalities=_LANGUAGE_ONLY,
            required_env=("PERPLEXITY_API_KEY",),
            test_model="sonar-pro",
            docs_url="https://www.perplexity.ai/settings/api",
            # No openai_compat_discovery_url: register models manually.
        ),
        ProviderSpec(
            name="pollinations",
            display_name="Pollinations",
            modalities=_LANGUAGE_ONLY,
            required_env=("POLLINATIONS_API_KEY",),
            test_model="openai",
            docs_url="https://pollinations.ai",
            openai_compat_discovery_url="https://text.pollinations.ai/openai/models",
        ),
        ProviderSpec(
            name="scaleway",
            display_name="Scaleway AI",
            modalities=_LANGUAGE_ONLY,
            required_env=("SCALEWAY_API_KEY",),
            test_model="llama-3.3-70b-instruct",
            docs_url="https://console.scaleway.com",
            # No openai_compat_discovery_url: register models manually.
        ),
        ProviderSpec(
            name="lmstudio",
            display_name="LM Studio (local)",
            modalities=_LANGUAGE_ONLY,
            test_model=None,  # Dynamic - local server decides the model list
            docs_url="https://lmstudio.ai",
            # No openai_compat_discovery_url: base URL is user-supplied
            # (default http://localhost:1234/v1) and the key is optional —
            # handled like openai_compatible, not the fixed-URL table.
        ),
        ProviderSpec(
            name="omniroute",
            display_name="OmniRoute (local gateway)",
            modalities=_LANGUAGE_ONLY,
            test_model=None,  # Dynamic - gateway routes `auto` itself
            docs_url="https://github.com/diegosouzapw/OmniRoute",
            # No openai_compat_discovery_url: base URL is user-supplied
            # (default http://localhost:20128/v1) and no key is needed.
        ),
)


def _build_registry(specs: Tuple[ProviderSpec, ...]) -> Dict[str, ProviderSpec]:
    """Build the name -> spec map, refusing duplicate names at import time.

    A plain dict comprehension would silently drop the earlier spec on a
    name collision; fail loudly instead.
    """
    registry: Dict[str, ProviderSpec] = {}
    for spec in specs:
        if spec.name in registry:
            raise ValueError(
                f"Duplicate provider name in registry: {spec.name!r}"
            )
        registry[spec.name] = spec
    return registry


PROVIDERS: Dict[str, ProviderSpec] = _build_registry(_PROVIDER_SPECS)

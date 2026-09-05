import OpenAI from 'openai';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { OmniRouteConfig } from '../types';
import { getApiProvider } from './apiProviders';
import { getSystemMessages, MAX_NOTE_CONTEXT_CHARS } from './systemMessages';

/**
 * Inside Tauri the AI requests run through the Rust HTTP plugin (reqwest)
 * instead of the webview's fetch. WebView2's network stack can fail — proxy
 * or TLS quirks, CORS edge cases — where plain HTTP clients succeed, which
 * surfaced as "Connection error." for Google Gemini. Rust-side requests use
 * the same stack as the rest of the app (updater, model downloads) and are
 * not subject to browser CORS. Outside Tauri (plain `vite` web mode) the
 * regular browser fetch is used.
 */
/**
 * Strips the model's internal <thought>...</thought> reasoning block from the
 * response.  Models like gemma-4-31b-it prepend a thinking block that should
 * not be shown to the user — it inflates the response and causes scroll.
 */
function stripThinking(text: string): string {
  return text.replace(/<thought>[\s\S]*?<\/thought>\s*/gi, '').trim();
}

function resolveFetch(): typeof fetch {
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  return inTauri ? (tauriFetch as unknown as typeof fetch) : fetch;
}

/**
 * Gets an OpenAI instance configured for OmniRoute.
 *
 * Providers whose endpoint is fixed (canEditBaseUrl unset in the registry)
 * always use their registry default base URL — a saved override is ignored.
 * Google Gemini uses the OpenAI-compatible endpoint
 * (`generativelanguage.googleapis.com/v1beta/openai/`) so this same client
 * handles all providers uniformly.
 */
function getAIClient(config: OmniRouteConfig): OpenAI | null {
  if (!config.apiKey || !config.baseUrl) {
    return null;
  }
  const provider = getApiProvider(config.provider);
  const baseURL = provider && !provider.canEditBaseUrl ? provider.baseUrl : config.baseUrl;
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL,
    fetch: resolveFetch(),
    dangerouslyAllowBrowser: true, // Required in Electron/Vite renderer context
  });
}

/**
 * Sends a generic chat request to the AI using OmniRoute.
 *
 * Honors the runtime config: the chat `temperature` is sent with every
 * request, and when `injectUserProfile` is enabled (with a non-empty
 * `userProfile`), the profile is prepended as an extra system message so the
 * model knows who it's helping — for the free-form chat AND every quick action
 * (they all funnel through this function).
 */
/**
 * Truncates note content for quick-action prompts so large notes don't
 * overflow the model's context window (Gemini: "Error code: Out of Memory").
 * Mirrors the chat system-prompt cap in systemMessages.ts.
 */
function truncateForPrompt(content: string): string {
  if (content.length <= MAX_NOTE_CONTEXT_CHARS) return content;
  return `${content.slice(0, MAX_NOTE_CONTEXT_CHARS)}\n\n...[note truncated — full content is in the vault]`;
}

/**
 * Sends a generic chat request to the AI using the OpenAI-compatible client.
 *
 * Honors the runtime config: the chat `temperature` is sent with every
 * request, and when `injectUserProfile` is enabled (with a non-empty
 * `userProfile`), the profile is prepended as an extra system message so the
 * model knows who it's helping — for the free-form chat AND every quick action
 * (they all funnel through this function).
 */
export async function sendChatMessage(
  config: OmniRouteConfig,
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
): Promise<string> {
  const fullMessages = [...messages];
  if (config.injectUserProfile && config.userProfile?.trim()) {
    fullMessages.unshift({
      role: 'system',
      content: `User profile (who you are helping):\n${config.userProfile.trim()}`,
    });
  }

  const client = getAIClient(config);
  if (!client) {
    throw new Error('AI is not configured. Please enter your API Key and Base URL in settings.');
  }

  // Official Gemini model IDs are lowercase (e.g. gemma-4-31b-it);
  // normalize so a saved "gemma-4-31B-it" can't 404.
  const model = config.provider === 'google' ? config.model.toLowerCase() : (config.model || 'gpt-4o');

  try {
    const response = await client.chat.completions.create({
      model,
      messages: fullMessages,
      temperature: config.temperature ?? 0.7,
    });

    return stripThinking(response.choices[0]?.message?.content || 'No response from AI.');
  } catch (error: any) {
    console.error('AI chat error:', error);
    throw new Error(error.message || 'An error occurred while calling AI.', { cause: error });
  }
}

/**
 * Summarizes the active note
 */
export async function summarizeNote(
  config: OmniRouteConfig,
  noteTitle: string,
  noteContent: string
): Promise<string> {
  const systemPrompt = getSystemMessages().summarizeSystemPrompt;

  const userPrompt = `Please summarize my note titled "${noteTitle}". Here is the content:\n\n${truncateForPrompt(noteContent)}`;

  return sendChatMessage(config, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
}

/**
 * Proposes relevant connections/links with other existing notes
 */
export async function suggestConnections(
  config: OmniRouteConfig,
  noteTitle: string,
  noteContent: string,
  allNotes: Array<{ title: string; content: string }>
): Promise<string> {
  const existingNotesList = allNotes.map((n) => n.title).join(', ');

  const systemPrompt = getSystemMessages().linkSuggestSystemPrompt;

  const userPrompt = `Active Note Title: "${noteTitle}"
Active Note Content:
"""
${truncateForPrompt(noteContent)}
"""

Other Notes in Vault: [ ${existingNotesList} ]

Please suggest 2 to 5 highly relevant connections from the vault and briefly explain why.`;

  return sendChatMessage(config, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
}

/**
 * Suggests tags and key metadata for the active note
 */
export async function suggestMetadata(
  config: OmniRouteConfig,
  noteTitle: string,
  noteContent: string
): Promise<string> {
  const systemPrompt = getSystemMessages().metadataSystemPrompt;

  const userPrompt = `Note Title: "${noteTitle}"
Note Content:
"""
${truncateForPrompt(noteContent)}
"""

Please suggest frontmatter and tags in clean markdown format.`;

  return sendChatMessage(config, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
}

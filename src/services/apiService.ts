import { invoke } from '@tauri-apps/api/core';
import { OmniRouteConfig } from '../types';
import { getSystemMessages, MAX_NOTE_CONTEXT_CHARS } from './systemMessages';
import type { RetrievalPlan } from './knowledge';
function truncateForPrompt(content: string): string {
  return content.length <= MAX_NOTE_CONTEXT_CHARS ? content : `${content.slice(0, MAX_NOTE_CONTEXT_CHARS)}\n...[note truncated]`;
}
export async function sendChatMessage(
  _config: OmniRouteConfig,
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  task = 'CHAT',
): Promise<string> {
  const result = await invoke<string>('execute_model', { request: { task, messages } });
  return result.replace(/<thought>[\s\S]*?<\/thought>\s*/gi, '').trim();
}

export async function sendChatMessageWithRetrieval(
  config: OmniRouteConfig,
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  activeNote: { title: string; path: string; content?: string } | null,
  task = 'CHAT',
): Promise<{ text: string; retrieval: RetrievalPlan | null }> {
  const userQuery = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  let retrieval: RetrievalPlan | null = null;
  let injected = messages;
  if (userQuery.trim() || activeNote) {
    try {
      retrieval = await invoke<RetrievalPlan>('plan_retrieval', {
        request: {
          query: userQuery,
          activeNoteId: activeNote?.path ?? null,
          budgetChars: 12_000,
        },
      });
      if (retrieval?.contextText) {
        const sysIdx = messages.findIndex((m) => m.role === 'system');
        const contextBlock = `\n\n--- Vault context (cite sources as [[path]] or [[path#^anchor]]) ---\n${retrieval.contextText}`;
        injected = messages.map((m, i) => (i === sysIdx ? { ...m, content: m.content + contextBlock } : m));
        if (sysIdx < 0) {
          const fallback = getSystemMessages().chatSystemPrompt.replace('{note_context}', '');
          injected = [{ role: 'system', content: fallback + contextBlock }, ...messages.filter((m) => m.role !== 'system')];
        }
        if (retrieval.degraded) {
          injected = injected.map((m, i) => (i === sysIdx || sysIdx < 0 && i === 0 ? { ...m, content: m.content + `\n\n[Retrieval note: ${retrieval?.degraded}]` } : m));
        }
      }
    } catch {
      // retrieval is best-effort — fall back to plain prompt
    }
  }
  const result = await invoke<string>('execute_model', { request: { task, messages: injected } });
  return { text: result.replace(/<thought>[\s\S]*?<\/thought>\s*/gi, '').trim(), retrieval };
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
  ], 'SUMMARIZE');
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
  ], 'TAG');
}

import { invoke } from '@tauri-apps/api/core';
import { OmniRouteConfig } from '../types';
import { getSystemMessages, MAX_NOTE_CONTEXT_CHARS } from './systemMessages';
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

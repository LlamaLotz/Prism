import systemMessages from './systemMessages.json';

export interface SystemMessages {
  chatSystemPrompt: string;
  noteContextTemplate: string;
  noNoteContext: string;
  summarizeSystemPrompt: string;
  linkSuggestSystemPrompt: string;
  metadataSystemPrompt: string;
}

export const getSystemMessages = (): SystemMessages => systemMessages;

/**
 * Notes larger than this are trimmed before being injected into prompts.
 * Sending the whole note can overflow the model's context window — Gemini
 * surfaces that as "Error code: Out of Memory". ~40k chars ≈ 10k tokens is
 * safely inside even small context windows while keeping the note's essence.
 */
export const MAX_NOTE_CONTEXT_CHARS = 40_000;

/** Truncates a note's content for prompt injection, marking the cut. */
function truncateNoteContent(content: string): string {
  if (content.length <= MAX_NOTE_CONTEXT_CHARS) return content;
  return `${content.slice(0, MAX_NOTE_CONTEXT_CHARS)}\n\n...[note truncated — full content is in the vault]`;
}

/**
 * Builds the chat system prompt for the Co-Pilot sidebar, injecting the
 * active note's context into the `{note_context}` placeholder.
 */
export function buildChatSystemPrompt(note: { title: string; content?: string } | null): string {
  const { chatSystemPrompt, noteContextTemplate, noNoteContext } = systemMessages;
  const context = note
    ? noteContextTemplate
        .replace('{note_title}', note.title)
        .replace('{note_content}', truncateNoteContent(note.content ?? ''))
    : noNoteContext;
  return chatSystemPrompt.replace('{note_context}', context);
}

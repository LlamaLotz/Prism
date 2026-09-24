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

/** A single entry of the Rust agent Tool Bus registry (`agent_list_tools`). */
export interface AgentToolDefinition {
  name: string;
  description: string;
  requiresApproval: boolean;
  category: string; // "read" | "write"
}

// Exact input shapes expected by the Rust Tool Bus (`knowledge/agent.rs`).
// Kept in sync manually — the backend error messages name the same keys.
const AGENT_TOOL_INPUTS: Record<string, string> = {
  read_note: '{"noteId": "<stable id, absolute path, or vault-relative path>"}',
  read_block: '{"blockId": "<block id>"}',
  search_vault: '{"query": "<text>", "mode": "hybrid|lexical|semantic", "folder": "<optional>", "tag": "<optional>", "limit": 20}',
  get_related_notes: '{"noteId": "<id or path, may be empty>", "kinds": ["wiki", "tag", "folder"]}',
  get_backlinks: '{"noteId": "<id or path>"}',
  create_note: '{"path": "<vault-relative path, e.g. Notes/Idea.md>", "content": "<markdown>"}',
  edit_note:
    '{"noteId": "<id or path>", "operations": [{"op": "append|replaceAll|replaceBlock|insertAfter|insertBefore|deleteBlock|addTag|removeTag|addWikilink", "blockId": "<block id, for block ops>", "text": "<new text>", "tag": "<tag>", "target": "<link target>"}]} (max 32 ops)',
  rename_note: '{"noteId": "<id or path>", "newPath": "<vault-relative destination>"}',
  delete_note: '{"noteId": "<id or path>"}',
  create_folder: '{"path": "<vault-relative path, max 5 levels>"}',
  move_folder: '{"oldPath": "<vault-relative source>", "newPath": "<vault-relative destination>"}',
  add_wikilink: '{"noteId": "<id or path>", "target": "<link target>", "blockId": "<optional block id>"}',
  add_tag: '{"noteId": "<id or path>", "tag": "<tag>"}',
  remove_tag: '{"noteId": "<id or path>", "tag": "<tag>"}',
  format_note: '{"noteId": "<id or path>"}',
};

/**
 * Builds the agent-mode system prompt: tool registry + the fenced-JSON
 * calling protocol the sidebar's agent loop parses. The model is
 * provider-agnostic (plain messages via `execute_model`), so tool calls are
 * emitted as ```json blocks instead of native function-calling. Write tools
 * still go through the existing preview + user-approval gate — this prompt
 * grants the agent *access* to edits, never silent application.
 */
export function buildAgentSystemPrompt(tools: AgentToolDefinition[]): string {
  const lines = tools.map((t) => {
    const shape = AGENT_TOOL_INPUTS[t.name] ?? '{"...": "see tool description"}';
    const gate = t.requiresApproval ? ' [WRITE — needs user approval before it applies]' : ' [read]';
    return `- ${t.name}${gate}: ${t.description}\n  input: ${shape}`;
  });
  return `You are Prism's vault agent. You can read vault notes and propose edits using these tools:

${lines.join('\n')}

Protocol:
- To act, reply with one or more fenced \`\`\`json blocks, each holding exactly one call: {"tool": "<name>", "input": {...}}.
- You may also include plain-text explanation outside the blocks.
- Read first when you need grounding (search_vault, read_note); then call write tools with concrete operations.
- Never claim an edit was applied: write tools only PREPARE a preview — the user approves it separately. Say what you prepared and ask for approval.
- If no tool is needed, just answer directly with no json blocks.
- NoteId accepts a stable id, an absolute path, or a vault-relative path. Prefer vault-relative paths.`;
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

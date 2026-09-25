import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Sparkles, Send, Loader2, RefreshCw, FileText,
  BookOpen, Link2, Hash, AlertTriangle, Globe, ShieldCheck, Undo2, Eye, Check, X,
  ChevronDown, ChevronUp, History, Plus, Pencil, Trash2, ExternalLink
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { NoteFile, OmniRouteConfig, tauriAPI } from '../types';
import { summarizeNote, suggestConnections, suggestMetadata, sendChatMessage, sendChatMessageWithRetrieval } from '../services/apiService';
import { CHAT_COLLAPSE_THRESHOLD } from '../services/notebook';
import { buildAgentSystemPrompt, buildChatSystemPrompt } from '../services/systemMessages';
import { knowledge } from '../services/knowledge';
import type { AgentToolDefinition, ChatLibrarySession, Citation, RetrievedBlock, AgentPending } from '../services/knowledge';
import { useChatLibrary } from '../services/chatLibrary';
import { useDialog } from './DialogProvider';
import { createErrorDetails, createUserErrorDetails, ErrorDetails } from '../utils/errors';

interface AISidebarProps {
  note: NoteFile | null;
  allNotes: NoteFile[];
  config: OmniRouteConfig;
  onOpenSettings: () => void;
  onInsertText: (text: string) => void;
  /** Vault mutated by an approved/undone agent edit — refresh list + graph.
   *  Receives the affected absolute path when the tool result carries one. */
  onVaultChanged?: (affectedPath?: string) => void;
  /** Open a library session pushed from elsewhere (Notebook deep-link). */
  openRequest?: { sessionId: string; ts: number } | null;
  onOpenRequestConsumed?: () => void;
  /** Continue a Co-Pilot session in Notebook (App seeds a backend session). */
  onOpenInNotebook?: (entry: ChatLibrarySession) => void;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  degraded?: string | null;
  retrievedBlocks?: RetrievedBlock[];
}

/**
 * Assistant bubble content: responses longer than CHAT_COLLAPSE_THRESHOLD
 * start collapsed behind a "View response" toggle so long replies don't
 * flood the chat. The preview is a plain-text snippet; the full markdown
 * only renders when expanded, so formatting can never break mid-collapse.
 */
const AssistantMessage: React.FC<{ content: string }> = ({ content }) => {
  const [expanded, setExpanded] = useState(false);
  if (content.length <= CHAT_COLLAPSE_THRESHOLD) {
    return <ReactMarkdown>{content}</ReactMarkdown>;
  }
  return (
    <div className="min-w-0">
      {expanded
        ? <ReactMarkdown>{content}</ReactMarkdown>
        : <span className="whitespace-pre-wrap break-words">{content.slice(0, CHAT_COLLAPSE_THRESHOLD)}…</span>}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-semibold text-brand-400 hover:text-brand-300 transition-colors cursor-pointer"
      >
        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {expanded ? 'Show less' : `View response (${content.length} chars)`}
      </button>
    </div>
  );
};

// Bounds for one model-driven agent turn: model ↔ Tool Bus rounds, and how
// much of a single tool result is fed back (keeps small context windows safe).
const MAX_AGENT_ROUNDS = 5;
const MAX_TOOL_RESULT_CHARS = 6000;

const fmtChatDate = (epochSeconds: number) => {
  try {
    return new Date(epochSeconds * 1000).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
};

/**
 * Shared chat library: every Co-Pilot + Notebook conversation in this vault.
 * Notebook rows are linked entries kept in sync by the Notebook view;
 * opening one loads its mirrored transcript (synced on demand there).
 */
const ChatLibraryPanel: React.FC<{
  activeId: string | null;
  onOpen: (entry: ChatLibrarySession) => void;
  onNew: () => void;
  onDeleted: (id: string) => void;
  onOpenInNotebook?: (entry: ChatLibrarySession) => void;
}> = ({ activeId, onOpen, onNew, onDeleted, onOpenInNotebook }) => {
  const library = useChatLibrary();
  const dialogs = useDialog();

  const renameEntry = async (entry: ChatLibrarySession) => {
    const name = await dialogs.prompt('Chat title', { title: 'Rename chat', initialValue: entry.title });
    if (name?.trim() && name.trim() !== entry.title) {
      try { await library.rename(entry.id, name.trim()); }
      catch (e) { console.error('Rename chat failed:', e); }
    }
  };

  const deleteEntry = async (entry: ChatLibrarySession) => {
    const ok = await dialogs.confirm(`Delete "${entry.title}" and its history? This cannot be undone.`, { title: 'Delete chat', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      if (entry.origin === 'notebook' && entry.notebookSessionId) {
        // Linked entries mirror the backend: removing the link only detaches
        // it from the library, the Notebook session itself is untouched.
        await library.unlinkNotebook(entry.notebookSessionId);
      } else {
        await library.remove(entry.id);
      }
      onDeleted(entry.id);
    } catch (e) { console.error('Delete chat failed:', e); }
  };

  return (
    <div className="flex flex-col gap-2 min-h-0">
      <div className="flex items-center gap-2">
        <input
          value={library.search}
          onChange={(e) => library.setSearch(e.target.value)}
          placeholder="Search chats…"
          aria-label="Search chats"
          className="min-w-0 flex-1 bg-slate-900/60 border border-border focus:border-slate-700 text-xs rounded-xl px-3 py-1.5 text-slate-200 focus:outline-none transition-colors"
        />
        <button
          type="button"
          onClick={onNew}
          title="Start a new chat"
          className="shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 transition-colors cursor-pointer"
        >
          <Plus className="w-3 h-3" /> New
        </button>
      </div>
      <div className="flex items-center gap-1">
        {([['all', 'All'], ['copilot', 'Co-Pilot'], ['notebook', 'Notebook']] as const).map(([key, label]) => {
          const active = (library.originFilter ?? 'all') === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => library.setOriginFilter(key === 'all' ? null : key)}
              aria-pressed={active}
              className={`text-[10px] font-semibold px-2 py-1 rounded-full border transition-colors cursor-pointer ${active ? 'bg-brand-500/10 text-brand-300 border-brand-500/40' : 'text-slate-500 border-slate-800 hover:text-slate-300'}`}
            >
              {label}
            </button>
          );
        })}
        {library.loading && <span className="text-[10px] text-slate-600 ml-auto">Loading…</span>}
      </div>
      <div className="flex flex-col gap-1.5 overflow-y-auto min-h-0">
        {!library.sessions.length && !library.loading && (
          <p className="text-[11px] text-slate-500 text-center py-6">
            {library.search ? 'No chats match your search.' : 'No chats yet. New conversations appear here automatically.'}
          </p>
        )}
        {library.sessions.map((s) => {
          const isActive = s.id === activeId;
          return (
            <div
              key={s.id}
              className={`group flex items-center gap-1 rounded-xl border px-2.5 py-2 transition-colors ${isActive ? 'bg-brand-500/10 border-brand-500/40' : 'bg-slate-900/40 border-slate-800/60 hover:border-slate-700'}`}
            >
              <button type="button" onClick={() => onOpen(s)} className="flex-1 min-w-0 text-left cursor-pointer" title={`Open "${s.title}"`}>
                <div className="text-xs font-medium text-slate-200 truncate">{s.title}</div>
                <div className="flex items-center gap-1.5 mt-0.5 text-[9px] text-slate-500">
                  <span className={`font-bold uppercase tracking-wide ${s.origin === 'notebook' ? 'text-violet-300/90' : 'text-brand-300/90'}`}>
                    {s.origin === 'notebook' ? 'Notebook' : 'Co-Pilot'}
                  </span>
                  <span>·</span><span>{s.messageCount} msgs</span>
                  <span>·</span><span>{fmtChatDate(s.updatedAt)}</span>
                </div>
              </button>
              {s.origin === 'copilot' && onOpenInNotebook && (
                <button
                  type="button"
                  onClick={() => onOpenInNotebook(s)}
                  title="Continue in Notebook"
                  aria-label={`Continue "${s.title}" in Notebook`}
                  className="shrink-0 p-1.5 text-slate-500 hover:text-brand-300 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => void renameEntry(s)}
                title="Rename chat"
                aria-label={`Rename "${s.title}"`}
                className="shrink-0 p-1.5 text-slate-500 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void deleteEntry(s)}
                title={s.origin === 'notebook' ? 'Remove from library (Notebook session is kept)' : 'Delete chat'}
                aria-label={`Delete "${s.title}"`}
                className="shrink-0 p-1.5 text-slate-500 hover:text-rose-400 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const AISidebar: React.FC<AISidebarProps> = ({
  note,
  allNotes,
  config,
  onOpenSettings,
  onInsertText,
  onVaultChanged,
  openRequest,
  onOpenRequestConsumed,
  onOpenInNotebook,
}) => {
  const dialogs = useDialog();
  const library = useChatLibrary();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [error, setError] = useState<ErrorDetails | null>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [pendingAgent, setPendingAgent] = useState<AgentPending[]>([]);
  const [undoNote, setUndoNote] = useState<string | null>(null);
  const [view, setView] = useState<'chat' | 'library'>('chat');
  // Active library session backing this chat. Null = ephemeral draft that
  // becomes a persisted session on its first message.
  const [librarySessionId, setLibrarySessionId] = useState<string | null>(null);
  const librarySessionIdRef = useRef<string | null>(null);
  const persistedCount = useRef(0);

  const serializeMeta = (m: ChatMessage): string | null => {
    const meta: Record<string, unknown> = {};
    if (m.citations?.length) meta.citations = m.citations;
    if (m.degraded) meta.degraded = m.degraded;
    return Object.keys(meta).length ? JSON.stringify(meta) : null;
  };

  // Persist every posted turn to the shared chat library. Centralized here so
  // chat, agent, search and quick-action paths all persist identically: only
  // the delta since the last sync is appended, and a shorter list means the
  // chat was replaced (session opened / new chat) and only re-anchors.
  useEffect(() => {
    if (messages.length < persistedCount.current) {
      persistedCount.current = messages.length;
      return;
    }
    if (messages.length === persistedCount.current) return;
    const delta = messages.slice(persistedCount.current);
    persistedCount.current = messages.length;
    void (async () => {
      try {
        let sid = librarySessionIdRef.current;
        if (!sid) {
          const firstUser = messages.find((m) => m.role === 'user');
          const title = (firstUser?.content ?? 'Conversation').slice(0, 60);
          const row = await library.create(title, 'copilot');
          sid = row.id;
          librarySessionIdRef.current = sid;
          setLibrarySessionId(sid);
        }
        for (const m of delta) {
          await library.append(sid, m.role, m.content, serializeMeta(m));
        }
      } catch (e) {
        console.error('Chat persist failed:', e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const openLibrarySession = useCallback(async (entry: ChatLibrarySession) => {
    const rows = await library.loadMessages(entry.id);
    if (!rows.length && entry.origin === 'notebook') {
      setError(createUserErrorDetails('No synced transcript yet for this Notebook chat. Open it in Notebook (or press “Continue in Co-Pilot” there) to sync it here.'));
    }
    persistedCount.current = rows.length;
    librarySessionIdRef.current = entry.id;
    setLibrarySessionId(entry.id);
    setMessages(
      rows.map((r) => {
        let citations: Citation[] | undefined;
        let degraded: string | null = null;
        try {
          const meta = r.metadata ? JSON.parse(r.metadata) : null;
          if (Array.isArray(meta?.citations)) citations = meta.citations;
          if (typeof meta?.degraded === 'string') degraded = meta.degraded;
        } catch { /* untyped legacy metadata */ }
        return { role: r.role, content: r.content, citations, degraded } as ChatMessage;
      }),
    );
    setView('chat');
  }, [library]);

  const startNewChat = useCallback(() => {
    librarySessionIdRef.current = null;
    setLibrarySessionId(null);
    setMessages([]);
  }, []);

  // Deep-link from the Notebook library: open a shared session here.
  // Guarded: StrictMode double-invokes effects in dev; opening is idempotent
  // but should still run once per request.
  const openConsumedTs = useRef<number | null>(null);
  useEffect(() => {
    if (!openRequest || openConsumedTs.current === openRequest.ts) return;
    openConsumedTs.current = openRequest.ts;
    void (async () => {
      try {
        // Fresh list (the panel's may predate the link) + panel sync.
        const rows = await knowledge.listChats(null, null, 200);
        await library.refresh();
        const entry = rows.find((s) => s.id === openRequest.sessionId);
        if (!entry) throw new Error('Shared chat not found in this vault.');
        await openLibrarySession(entry);
      } catch (e) {
        showError(e, 'Could not open the shared chat.');
      } finally {
        onOpenRequestConsumed?.();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest?.ts]);

  const showError = (errorValue: unknown, fallback: string) => {
    setError(createErrorDetails(errorValue, fallback));
  };

  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Stick-to-bottom: follow new messages only while the user is already near
  // the bottom. Scrolling up to read history un-sticks (no more yank-down);
  // sending a message re-sticks.
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => {
    if (stickToBottom) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, pendingAgent, stickToBottom]);

  const handleViewportScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  // Poll agent pending approvals (10m expiry, vault generation bound) — only when agent mode active
  useEffect(() => {
    if (!agentMode) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const list = await knowledge.agentPending();
        if (!cancelled) setPendingAgent(list);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 3000);
    const unlistenKnowledge = (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        return await listen('knowledge-event', (e: any) => {
          const kind = e?.payload?.kind as string | undefined;
          if (kind === 'agent_approval_required' || kind === 'agent_applied' || kind === 'note_changed') tick();
        });
      } catch { return () => {}; }
    })();
    return () => { cancelled = true; clearInterval(id); unlistenKnowledge.then((fn) => fn()); };
  }, [agentMode]);

  const isConfigured = !!config.baseUrl && !!config.model;

  const handleSend = async (text: string = inputValue) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    if (!isConfigured) {          setError(createUserErrorDetails('AI is not configured. Please enter your API Key and Base URL in Settings.'));
      return;
    }

    setError(null);
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    if (text === inputValue) setInputValue('');
    setIsLoading(true);

    try {
      // Build a full prompt context using the active note if it exists
      const fullMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
        {
          role: 'system',
          content: buildChatSystemPrompt(note),
        },
      ];

      // Add chat history — capped to the last 12 turns so long sessions
      // don't overflow the model's context window (Gemini surfaces that as
      // "Error code: Out of Memory").
      messages.slice(-12).forEach((msg) => {
        fullMessages.push({ role: msg.role, content: msg.content });
      });

      // Add current message
      fullMessages.push({ role: 'user', content: trimmed });

      // Retrieval-augmented: vault-aware context (active note + linked + backlinks + semantic + tags) is injected server-side.
      const activeForRetrieval = note ? { title: note.title, path: note.path, content: note.content } : null;
      const { text: response, retrieval } = await sendChatMessageWithRetrieval(config, fullMessages, activeForRetrieval);
      setMessages((prev) => [...prev, { role: 'assistant', content: response, citations: retrieval?.citations ?? undefined, degraded: retrieval?.degraded ?? null, retrievedBlocks: retrieval?.blocks ?? undefined }]);
    } catch (err: any) {
      showError(err, 'An error occurred.');
    } finally {
      setIsLoading(false);
    }
  };

  // Model-driven tool calls are emitted as fenced ```json blocks holding
  // exactly one {"tool", "input"} call each (provider-agnostic — the model
  // only ever sees plain messages via `execute_model`).
  const extractToolCalls = (text: string): Array<{ tool: string; input: unknown }> => {
    const calls: Array<{ tool: string; input: unknown }> = [];
    const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
    let m: RegExpExecArray | null;
    while ((m = fence.exec(text)) !== null) {
      const raw = m[1].trim();
      if (!raw.startsWith('{') && !raw.startsWith('[')) continue;
      try {
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : parsed.tool ? [parsed] : [];
        for (const item of items) {
          if (item && typeof item.tool === 'string' && item.input !== undefined) {
            calls.push({ tool: item.tool, input: item.input });
          }
        }
      } catch { /* prose code block, not a tool call */ }
    }
    return calls;
  };

  const postApprovalMessage = async (tool: string, preview: string | null) => {
    setMessages((prev) => [...prev, { role: 'assistant', content: `Agent prepared \`${tool}\` — review the preview below and Approve to apply.\n\nPreview:\n\`\`\`diff\n${preview ?? '(no preview)'}\n\`\`\`` }]);
    try { const list = await knowledge.agentPending(); setPendingAgent(list); } catch {}
  };

  const handleAgentTurn = async (trimmed: string) => {
    if (isLoading) return true;
    // Manual fast-path: a raw {"tool":..., "input":...} message dispatches
    // directly to the Tool Bus without involving the model.
    const asTool = (() => { try { return JSON.parse(trimmed); } catch { return null; } }) as any;
    if (asTool && typeof asTool.tool === 'string' && asTool.input !== undefined) {
      setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
      setInputValue(''); setIsLoading(true);
      try {
        const res = await knowledge.agentCall(asTool.tool, asTool.input);
        if (res.requiresApproval && res.approvalId) {
          await postApprovalMessage(res.tool, res.preview);
        } else {
          setMessages((prev) => [...prev, { role: 'assistant', content: `Tool \`${res.tool}\` result:\n\`\`\`json\n${JSON.stringify(res.result, null, 2)}\n\`\`\`` }]);
        }
      } catch (err: any) { showError(err, 'Agent tool failed.'); } finally { setIsLoading(false); }
      return true;
    }
    // Model-driven loop: the model gets the Tool Bus registry (reads + edit
    // tools) so agent mode can read and edit notes through conversation.
    // Writes still stop at the preview + user-approval gate — the model can
    // prepare edits, never apply them silently.
    if (!isConfigured) {
      setError(createUserErrorDetails('AI is not configured. Please enter your API Key and Base URL in Settings.'));
      return true;
    }
    setInputValue(''); setError(null);
    // Fetch the Tool Bus registry first: when it is unreachable we fall back
    // to plain chat (`handleSend` posts the user bubble itself).
    let registry: AgentToolDefinition[] = [];
    try { registry = await knowledge.agentTools(); } catch { registry = []; }
    if (!registry.length) { await handleSend(trimmed); return true; }
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    setIsLoading(true);
    try {
      const activeForRetrieval = note ? { title: note.title, path: note.path, content: note.content } : null;
      const history = messages.slice(-12).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      const work: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
        { role: 'system', content: `${buildChatSystemPrompt(note)}\n\n${buildAgentSystemPrompt(registry)}` },
        ...history,
        { role: 'user', content: trimmed },
      ];
      let finished = false;
      for (let round = 0; round < MAX_AGENT_ROUNDS && !finished; round++) {
        const { text: response } = await sendChatMessageWithRetrieval(config, work, activeForRetrieval);
        work.push({ role: 'assistant', content: response });
        const calls = extractToolCalls(response);
        if (!calls.length) {
          setMessages((prev) => [...prev, { role: 'assistant', content: response }]);
          finished = true;
          break;
        }
        setMessages((prev) => [...prev, { role: 'assistant', content: `Agent: calling ${calls.map((c) => `\`${c.tool}\``).join(', ')}…` }]);
        for (const call of calls) {
          let res;
          try {
            res = await knowledge.agentCall(call.tool, call.input);
          } catch (err: any) {
            const details = createErrorDetails(err, 'Agent tool failed.');
            work.push({ role: 'user', content: `Tool ${call.tool} failed: ${details.human} Adjust the call and retry, or explain the problem to the user.` });
            continue;
          }
          if (res.requiresApproval && res.approvalId) {
            await postApprovalMessage(res.tool, res.preview);
            work.push({ role: 'user', content: `Tool ${call.tool} prepared a preview (approval id ${res.approvalId}) now waiting for the user's decision. Do not call further write tools. Summarize what you prepared and ask for approval.` });
            // One more model pass for the summary, then end the turn — the
            // user's Approve/Deny resolves the pending edit via the review UI.
            try {
              const { text: summary } = await sendChatMessageWithRetrieval(config, work, activeForRetrieval);
              if (!extractToolCalls(summary).length) {
                setMessages((prev) => [...prev, { role: 'assistant', content: summary }]);
              }
            } catch { /* preview message above already informs the user */ }
            finished = true;
            break;
          }
          const resultJson = JSON.stringify(res.result ?? res.error ?? null, null, 2);
          const clipped = resultJson.length > MAX_TOOL_RESULT_CHARS
            ? `${resultJson.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[tool result truncated]`
            : resultJson;
          work.push({ role: 'user', content: `Tool ${call.tool} result:\n${clipped}\nContinue: call another tool if needed, or answer the user (no json blocks).` });
        }
      }
      if (!finished) {
        setMessages((prev) => [...prev, { role: 'assistant', content: 'Agent reached its step limit. Review any prepared previews below, or ask me to continue.' }]);
      }
    } catch (err: any) {
      showError(err, 'Agent turn failed.');
    } finally {
      setIsLoading(false);
    }
    return true;
  };

  const handleSearch = async (query: string) => {
    if (!query || isSearching) return;

    setIsSearching(true);
    setError(null);
    setMessages((prev) => [...prev, { role: 'user', content: `🔍 Search: ${query}` }]);

    try {
      const results = await tauriAPI.webSearch(query);
      if (results.length === 0) {
        setMessages((prev) => [...prev, { role: 'assistant', content: `No results found for "${query}".` }]);
        return;
      }
      const formatted = results.map((r, i) => 
        `${i + 1}. **[${r.title}](${r.url})**\n   ${r.snippet}`
      ).join('\n\n');
      setMessages((prev) => [...prev, { role: 'assistant', content: formatted }]);
    } catch (err: any) {
      showError(err, 'Search failed.');
    } finally {
      setIsSearching(false);
    }
  };

  const handleSubmit = async () => {
    setStickToBottom(true);
    if (searchMode) {
      const query = inputValue.trim();
      setInputValue('');
      await handleSearch(query);
    } else if (agentMode && inputValue.trim()) {
      const v = inputValue.trim();
      if (await handleAgentTurn(v)) return;
      await handleSend(v);
    } else {
      await handleSend();
    }
  };

  const runQuickAction = async (action: 'summarize' | 'connect' | 'metadata') => {
    if (!note) return;
    if (!isConfigured) {          setError(createUserErrorDetails('AI is not configured. Please enter your API Key and Base URL in Settings.'));
      return;
    }

    setError(null);
    setIsLoading(true);
    setStickToBottom(true);

    const userMessageContent = 
      action === 'summarize' ? `Summarize this note: "${note.title}"` :
      action === 'connect' ? `Suggest wiki-link connections for note: "${note.title}"` :
      `Generate Frontmatter / tags metadata for note: "${note.title}"`;

    setMessages((prev) => [...prev, { role: 'user', content: userMessageContent }]);

    try {
      let response = '';
      if (action === 'summarize') {
        response = await summarizeNote(config, note.title, note.content ?? '');
      } else if (action === 'connect') {
        response = await suggestConnections(
          config,
          note.title,
          note.content ?? '',
          allNotes.map((n) => ({ title: n.title, content: n.content ?? '' }))
        );
      } else {
        response = await suggestMetadata(config, note.title, note.content ?? '');
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: response }]);
    } catch (err: any) {
      showError(err, 'An error occurred.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="ai-sidebar w-full min-w-0 box-border border-l border-[var(--color-border)] bg-panel flex flex-col h-full select-none rounded-l-2xl">
      {/* Header */}
      <div className="p-4 border-b border-[var(--color-border)] flex flex-wrap gap-3 items-center justify-between bg-panel">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4.5 h-4.5 text-brand-400 animate-pulse" />
          <h2 className="text-sm font-bold text-slate-100">AI Co-Pilot</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView('chat')}
            aria-pressed={view === 'chat'}
            className="runtime-button"
            title="Current conversation"
          >
            Chat
          </button>
          <button
            onClick={() => { setView('library'); void library.refresh(); }}
            aria-pressed={view === 'library'}
            className="runtime-button"
            title="Shared chat library (Co-Pilot + Notebook history)"
          >
            <History className="w-3 h-3" /> Library
          </button>
          <button
            onClick={() => setAgentMode((v) => !v)}
            title={agentMode ? 'Agent: ON — can read and prepare note edits (writes need your approval)' : 'Agent: OFF — chat only'}
            aria-pressed={agentMode}
            className="runtime-button"
          >
            <ShieldCheck className="w-3 h-3" /> Agent {agentMode ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={startNewChat}
            className="gloss-text-button ai-reset-button text-[10px] font-semibold text-slate-500 hover:text-slate-300 transition-colors"
            title="Start a new chat (history is kept in the Library)"
          >
            <Plus className="w-3 h-3" /> New
          </button>
        </div>
      </div>

      {/* Connection warning */}
      {!isConfigured && (
        <div className="ai-integration-warning m-3 p-3 bg-brand-950/20 border border-brand-900/50 rounded-xl flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-brand-400 shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <h4 className="ai-integration-title text-[11px] font-semibold text-brand-200 leading-none">AI Integration Offline</h4>
            <p className="ai-integration-copy text-[10px] text-slate-400 leading-relaxed">
              API keys or endpoints are missing. Paste your credentials to enable chat & note analysis.
            </p>
            <button
              onClick={onOpenSettings}
              className="ai-integration-action text-[10px] font-bold text-brand-400 hover:text-brand-300 flex items-center gap-0.5"
            >
              Configure Now →
            </button>
          </div>
        </div>
      )}

      {/* Main chat viewport */}
      <div ref={viewportRef} onScroll={handleViewportScroll} className="flex-1 overflow-y-auto p-4 space-y-4 select-text">
        {view === 'library' ? (
          <ChatLibraryPanel
            activeId={librarySessionId}
            onOpen={(entry) => { void openLibrarySession(entry); }}
            onNew={() => { startNewChat(); setView('chat'); }}
            onDeleted={(id) => { if (id === librarySessionIdRef.current) startNewChat(); }}
            onOpenInNotebook={onOpenInNotebook}
          />
        ) : messages.length === 0 ? (
          <div className="h-full flex flex-col justify-center text-center space-y-4 py-8 select-none">
            <div className="w-12 h-12 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center mx-auto text-brand-400/80">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="space-y-1 max-w-xs mx-auto">
              <h3 className="text-xs font-semibold text-slate-300">Ask Prism Co-Pilot</h3>
              <p className="text-[10px] text-slate-500 leading-relaxed">
                Connect ideas, find links, generate summaries, or chat recursively with your note's context using AI routing.
              </p>
            </div>
            
            {/* Quick Actions drawer if a note is selected */}
            {note && isConfigured && (
              <div className="pt-4 max-w-xs mx-auto space-y-2">
                <span className="text-[9px] font-bold text-slate-500 tracking-wider uppercase block text-left">QUICK NOTE ACTIONS</span>
                
                <button
                  onClick={() => runQuickAction('summarize')}
                  className="w-full bg-slate-900/60 hover:bg-slate-900 border border-border text-[11px] text-slate-300 rounded-lg p-2 flex items-center gap-2 transition-all text-left"
                >
                  <BookOpen className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <div>
                    <div className="font-semibold text-slate-200">Summarize Note</div>
                    <div className="text-[9px] text-slate-500">Create beautiful summary blocks</div>
                  </div>
                </button>

                <button
                  onClick={() => runQuickAction('connect')}
                  className="w-full bg-slate-900/60 hover:bg-slate-900 border border-border text-[11px] text-slate-300 rounded-lg p-2 flex items-center gap-2 transition-all text-left"
                >
                  <Link2 className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                  <div>
                    <div className="font-semibold text-slate-200">Suggest Connections</div>
                    <div className="text-[9px] text-slate-500">Find files to link via [[WikiLinks]]</div>
                  </div>
                </button>

                <button
                  onClick={() => runQuickAction('metadata')}
                  className="w-full bg-slate-900/60 hover:bg-slate-900 border border-border text-[11px] text-slate-300 rounded-lg p-2 flex items-center gap-2 transition-all text-left"
                >
                  <Hash className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                  <div>
                    <div className="font-semibold text-slate-200">Generate Frontmatter</div>
                    <div className="text-[9px] text-slate-500">Paste tags & YAML headers at top</div>
                  </div>
                </button>
              </div>
            )}
          </div>
        ) : (
          messages.map((msg, index) => {
            const isUser = msg.role === 'user';
            return (
              <div 
                key={index} 
                className={`flex flex-col max-w-[85%] ${isUser ? 'ml-auto items-end' : 'mr-auto items-start'}`}
              >
                <span className="text-[9px] font-bold text-slate-500 mb-0.5">
                  {isUser ? 'YOU' : 'PRISM AI'}
                </span>
<div 
                   className={`text-xs p-3 rounded-2xl leading-relaxed ${
                     isUser 
                       ? 'bg-brand-500 text-[#0F172A] font-semibold rounded-tr-none' 
                       : 'bg-surface border border-border text-slate-200 rounded-tl-none font-sans prose prose-invert prose-sm max-w-none'
                   }`}
                 >
                    {!isUser && <AssistantMessage content={msg.content} />}
                    {isUser && msg.content}
                 </div>
                 {!isUser && msg.degraded && (
                   <div className="mt-1 text-[10px] text-amber-400/80 bg-amber-950/20 border border-amber-900/40 rounded-lg px-2 py-1 max-w-full">{msg.degraded}</div>
                 )}
                 {!isUser && msg.citations && msg.citations.length > 0 && (
                   <div className="mt-1.5 flex flex-wrap gap-1 max-w-full">
                     {msg.citations.slice(0, 6).map((c, ci) => {
                       const label = c.blockId ? `${c.title}#${c.blockId.slice(0, 6)}` : c.title || c.path.split('/').pop() || c.path;
                       const hover = c.anchor ? `${c.path}#^${c.anchor}` : c.blockId ? `${c.path}#${c.blockId}` : c.path;
                       return (
                         <span key={ci} title={hover} onClick={() => msg.retrievedBlocks?.[ci] && onInsertText(`[[${c.path}]]`)} className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 cursor-pointer transition-colors">
                           <FileText className="w-3 h-3 shrink-0" />
                           <span className="truncate max-w-[18ch]">{label}</span>
                         </span>
                       );
                     })}
                   </div>
                 )}
              </div>
            );
          })
        )}

        {/* Loading Indicator */}
        {isLoading && (
          <div className="flex flex-col items-start max-w-[85%] mr-auto">
            <span className="text-[9px] font-bold text-slate-500 mb-0.5">PRISM AI</span>
            <div className="bg-slate-900 border border-border p-3.5 rounded-2xl rounded-tl-none flex items-center gap-2.5">
              <Loader2 className="w-4 h-4 text-brand-400 animate-spin" />
              <span className="text-xs text-slate-400">Fetching response...</span>
            </div>
          </div>
        )}

        {/* Errors display */}
        {error && (
          <div className="p-3 bg-rose-950/20 border border-rose-900/50 rounded-xl flex items-start gap-2.5 text-rose-300 text-[11px]">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <span className="font-bold leading-none block">Error</span>
              <span>{error.human}</span>
              <details className="pt-1 text-[10px] text-rose-400/70">
                <summary className="cursor-pointer hover:text-rose-300">Raw error</summary>
                <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono">{error.raw}</pre>
              </details>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
        {!stickToBottom && messages.length > 0 && (
          <div className="sticky bottom-1 flex justify-center pt-1">
            <button
              type="button"
              onClick={() => setStickToBottom(true)}
              className="inline-flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1 rounded-full bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 transition-colors cursor-pointer"
            >
              <ChevronDown className="w-3 h-3" /> Latest
            </button>
          </div>
        )}
      </div>

      {/* Input section */}
      {agentMode && pendingAgent.length > 0 && (
        <div className="agent-review">
          <div className="text-[10px] font-bold tracking-wider text-[var(--color-text-hi)] flex items-center gap-1"><Eye className="w-3 h-3" /> PENDING APPROVALS ({pendingAgent.length})</div>
          {pendingAgent.map((p) => (
            <article key={p.id}>
              <div className="text-[11px] font-semibold text-[var(--color-text-hi)]">{p.tool} · <span className="text-[var(--color-text-body)]">{p.notePath}</span></div>
              <pre >{p.preview || '(no preview)'}</pre>
              <div className="runtime-actions">
                <button onClick={async () => { try { const r = await knowledge.agentApprove(p.id, true); setMessages((m) => [...m, { role: 'assistant', content: `Approved \`${p.tool}\`${(r as any)?.result ? ` — ${JSON.stringify((r as any).result)}` : ''}` }]); const list = await knowledge.agentPending(); setPendingAgent(list); setUndoNote(p.notePath); onVaultChanged?.((r as any)?.result?.newPath ?? (r as any)?.result?.notePath ?? p.notePath); } catch (e: any) { showError(e, 'Approval failed.'); } }} className="runtime-button runtime-primary"><Check className="w-3 h-3" /> Approve</button>
                <button onClick={async () => { try { await knowledge.agentApprove(p.id, false); const list = await knowledge.agentPending(); setPendingAgent(list); setMessages((m) => [...m, { role: 'assistant', content: `Denied \`${p.tool}\`` }]); } catch (e: any) { showError(e, 'Deny failed.'); } }} className="runtime-button"><X className="w-3 h-3" /> Deny</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {agentMode && undoNote && (
        <div className="agent-undo">
          <span className="text-[10px] text-slate-400">Last edit recoverable via history</span>
          <button onClick={async () => { try { const r = await knowledge.agentUndo(undoNote); setMessages((m) => [...m, { role: 'assistant', content: `Undid last change to \`${r.relativePath}\`\n\`\`\`diff\n${r.preview}\n\`\`\`` }]); onVaultChanged?.(undoNote); } catch (e: any) { showError(e, 'Undo failed.'); } }} className="runtime-button"><Undo2 className="w-3 h-3" /> Undo last edit</button>
        </div>
      )}
      {view === 'chat' && <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        className="w-full min-w-0 box-border p-3 border-t border-slate-900 bg-panel flex items-center gap-2"
      >
        <button
          type="button"
          onClick={() => setSearchMode((m) => !m)}
          title={searchMode ? 'Switch to chat mode' : 'Switch to search mode'}
          className={`shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all border ${
            searchMode
              ? 'bg-brand-600 hover:bg-brand-500 border-brand-400/40 text-white shadow-[0_0_12px_var(--color-brand-400)]'
              : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-400 hover:text-slate-200'
          }`}
        >
          <Globe className="w-3.5 h-3.5" />
        </button>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder={searchMode ? 'Search the web...' : (note ? 'Chat with active note context...' : 'Ask Prism AI anything...')}
          className="min-w-0 flex-1 bg-slate-900/60 border border-border focus:border-slate-700 text-xs rounded-xl px-3.5 py-2 text-slate-200 focus:outline-none transition-colors"
        />
        <button
          type="submit"
          disabled={!inputValue.trim() || isLoading || isSearching}
          className={`${searchMode ? 'bg-brand-600 hover:bg-brand-500 border-brand-400/20 shadow-[0_0_10px_var(--color-brand-400)]' : 'bg-brand-600 hover:bg-brand-500 border-brand-500/20'} disabled:opacity-30 disabled:pointer-events-none text-white w-9 h-8 shrink-0 p-0 rounded-xl transition-all flex items-center justify-center border`}
        >
          {(isLoading || isSearching) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        </button>
      </form>}
    </div>
  );
};

import React, { useState, useRef, useEffect } from 'react';
import { 
  Sparkles, Send, Loader2, RefreshCw, FileText, 
  BookOpen, Link2, Hash, AlertTriangle, Globe, ShieldCheck, Undo2, Eye, Check, X 
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { NoteFile, OmniRouteConfig, tauriAPI } from '../types';
import { summarizeNote, suggestConnections, suggestMetadata, sendChatMessage, sendChatMessageWithRetrieval } from '../services/apiService';
import { buildChatSystemPrompt } from '../services/systemMessages';
import { knowledge } from '../services/knowledge';
import type { Citation, RetrievedBlock, AgentPending } from '../services/knowledge';
import { createErrorDetails, createUserErrorDetails, ErrorDetails } from '../utils/errors';

interface AISidebarProps {
  note: NoteFile | null;
  allNotes: NoteFile[];
  config: OmniRouteConfig;
  onOpenSettings: () => void;
  onInsertText: (text: string) => void;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  degraded?: string | null;
  retrievedBlocks?: RetrievedBlock[];
}

export const AISidebar: React.FC<AISidebarProps> = ({
  note,
  allNotes,
  config,
  onOpenSettings,
  onInsertText,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [error, setError] = useState<ErrorDetails | null>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [pendingAgent, setPendingAgent] = useState<AgentPending[]>([]);
  const [undoNote, setUndoNote] = useState<string | null>(null);

  const showError = (errorValue: unknown, fallback: string) => {
    setError(createErrorDetails(errorValue, fallback));
  };

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Auto scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, pendingAgent]);

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

  const handleAgentTurn = async (trimmed: string) => {
    // Minimal agent loop: call agent tool via Rust bus (reads auto, writes preview+approve)
    // For now the sidebar routes the user's raw message as context to plan; model-side tool-calling
    // will drive this in the next iteration. This path at least surfaces the Tool Bus manually.
    // If the message looks like a tool call JSON, dispatch it; otherwise fall through to retrieval chat.
    const asTool = (() => { try { return JSON.parse(trimmed); } catch { return null; } }) as any;
    if (asTool && typeof asTool.tool === 'string' && asTool.input !== undefined) {
      setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
      setInputValue(''); setIsLoading(true);
      try {
        const res = await knowledge.agentCall(asTool.tool, asTool.input);
        if (res.requiresApproval && res.approvalId) {
          setMessages((prev) => [...prev, { role: 'assistant', content: `Agent prepared \`${res.tool}\` — review the preview below and Approve to apply.\n\nPreview:\n\`\`\`diff\n${res.preview ?? '(no preview)'}\n\`\`\`` }]);
          const list = await knowledge.agentPending(); setPendingAgent(list);
        } else {
          setMessages((prev) => [...prev, { role: 'assistant', content: `Tool \`${res.tool}\` result:\n\`\`\`json\n${JSON.stringify(res.result, null, 2)}\n\`\`\`` }]);
        }
      } catch (err: any) { showError(err, 'Agent tool failed.'); } finally { setIsLoading(false); }
      return true;
    }
    return false;
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
            onClick={() => setAgentMode((v) => !v)}
            title={agentMode ? 'Agent: ON — writes need approval' : 'Agent: OFF — chat only'}
            aria-pressed={agentMode}
            className="runtime-button"
          >
            <ShieldCheck className="w-3 h-3" /> Agent {agentMode ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={() => setMessages([])}
            className="gloss-text-button ai-reset-button text-[10px] font-semibold text-slate-500 hover:text-slate-300 transition-colors"
            title="Clear Chat History"
          >
            Reset
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
      <div className="flex-1 overflow-y-auto p-4 space-y-4 select-text">
        {messages.length === 0 ? (
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
                   {!isUser && <ReactMarkdown>{msg.content}</ReactMarkdown>}
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
                <button onClick={async () => { try { const r = await knowledge.agentApprove(p.id, true); setMessages((m) => [...m, { role: 'assistant', content: `Approved \`${p.tool}\`${(r as any)?.result ? ` — ${JSON.stringify((r as any).result)}` : ''}` }]); const list = await knowledge.agentPending(); setPendingAgent(list); setUndoNote(p.notePath); } catch (e: any) { showError(e, 'Approval failed.'); } }} className="runtime-button runtime-primary"><Check className="w-3 h-3" /> Approve</button>
                <button onClick={async () => { try { await knowledge.agentApprove(p.id, false); const list = await knowledge.agentPending(); setPendingAgent(list); setMessages((m) => [...m, { role: 'assistant', content: `Denied \`${p.tool}\`` }]); } catch (e: any) { showError(e, 'Deny failed.'); } }} className="runtime-button"><X className="w-3 h-3" /> Deny</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {agentMode && undoNote && (
        <div className="agent-undo">
          <span className="text-[10px] text-slate-400">Last edit recoverable via history</span>
          <button onClick={async () => { try { const r = await knowledge.agentUndo(undoNote); setMessages((m) => [...m, { role: 'assistant', content: `Undid last change to \`${r.relativePath}\`\n\`\`\`diff\n${r.preview}\n\`\`\`` }]); } catch (e: any) { showError(e, 'Undo failed.'); } }} className="runtime-button"><Undo2 className="w-3 h-3" /> Undo last edit</button>
        </div>
      )}
      <form 
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
      </form>
    </div>
  );
};

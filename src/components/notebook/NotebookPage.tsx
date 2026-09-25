import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { BookOpen, Plus, ArrowLeft, Upload, RefreshCw, Send, X, Settings2, Search, Headphones, Wand2, FolderOpen, Pencil, ChevronDown, ChevronUp, History, ExternalLink } from 'lucide-react';
import { NotebookClient, notebookRuntime, CHAT_COLLAPSE_THRESHOLD, recordId } from '../../services/notebook';
import type { AppSettings, NoteFile } from '../../types';
import type { NotebookResponse, SourceListResponse, SourceResponse, NoteResponse, ChatSessionResponse, ChatSessionWithMessagesResponse, SourceChatSessionWithMessagesResponse, ChatMessage, BuildContextResponse, SourceInsightResponse, TransformationResponse, SearchResponse, ModelResponse } from '../../types/notebook-api';
import type { ChatLibrarySession } from '../../services/knowledge';
import { useChatLibrary } from '../../services/chatLibrary';
import { useDialog } from '../DialogProvider';
import { ResizeHandle } from '../ResizeHandle';
import { NotebookManage } from './NotebookManage';
import './notebook.css';

export const Button = ({ children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" className={`nb-button ${className}`} {...props}>{children}</button>;
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  return <div className="nb-label"><label htmlFor={id}>{label}</label>{React.isValidElement<{ id?: string }>(children) ? React.cloneElement(children, { id }) : children}</div>;
}

/** Settle a request without throwing, so one half of `refreshNotebook` can
 *  succeed while the other fails (notes still render if sources error). */
async function settled<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try { return { ok: true, value: await promise }; }
  catch (error) { return { ok: false, error }; }
}

/**
 * One Notebook conversation reply: assistant answers longer than
 * CHAT_COLLAPSE_THRESHOLD start collapsed behind a "View response" toggle.
 * The preview is a plain-text snippet; full markdown only renders expanded.
 */
function NotebookChatMessage({ message, onReference }: { message: ChatMessage; onReference: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (message.content.length <= CHAT_COLLAPSE_THRESHOLD) {
    return <NotebookMarkdown text={message.content} onReference={onReference} />;
  }
  return <div className="nb-stack">
    {expanded
      ? <NotebookMarkdown text={message.content} onReference={onReference} />
      : <div className="nb-message"><span>{message.content.slice(0, CHAT_COLLAPSE_THRESHOLD)}…</span></div>}
    <div className="nb-tabs">
      <Button onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>
        {expanded ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}
        {expanded ? 'Show less' : `View response (${message.content.length} chars)`}
      </Button>
    </div>
  </div>;
}

export function NotebookMarkdown({ text, onReference }: { text: string; onReference: (id: string) => void }) {
  const linked = text.replace(/\[\[?((?:source|note|source_insight|insight):[a-zA-Z0-9_-]+)\]?\]/g, (_, id) => `[${id}](prism:${id})`);
  return <div className="nb-message"><ReactMarkdown urlTransform={url => url.startsWith('prism:') ? url : defaultUrlTransform(url)} components={{ a: ({ href, children }) => href?.startsWith('prism:')
    ? <button className="nb-citation" onClick={() => onReference(href.slice(6))}>{children}</button>
    : <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{linked}</ReactMarkdown></div>;
}

/** Deep-link / cross-open request from the shared chat library. */
export interface NotebookChatOpenRequest {
  notebookId?: string;
  sourceId?: string;
  sessionId?: string;
  /** Continue a Co-Pilot transcript here: creates a backend session seeded
   *  with the transcript as its opening context message. */
  seed?: { title: string; transcript: string };
  ts: number;
}

interface Props {
  active: boolean;
  vaultPath: string;
  vaultNotes: NoteFile[];
  settings: AppSettings;
  onSelectVault: () => void;
  onVaultExport: () => Promise<void>;
  openChatRequest?: NotebookChatOpenRequest | null;
  onOpenChatRequestConsumed?: () => void;
  /** Continue a Notebook session in Co-Pilot (receives the library id). */
  onContinueInCopilot?: (sessionId: string) => void;
}

export function NotebookPage(props: Props) {
  const [client, setClient] = useState<NotebookClient | null>(null);
  const clientRef = useRef<NotebookClient | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!props.active || !props.vaultPath || clientRef.current) return;
    let disposed = false;
    setStarting(true); setError('');
    notebookRuntime.start(props.vaultPath).then(status => {
      if (disposed || !status.workspaceId) return;
      const next = new NotebookClient(status.workspaceId);
      clientRef.current = next; setClient(next);
    }).catch(e => { if (!disposed) setError(String(e)); }).finally(() => { if (!disposed) setStarting(false); });
    return () => { disposed = true; };
  }, [props.active, props.vaultPath, attempt]);
  useEffect(() => () => { clientRef.current?.dispose(); void notebookRuntime.stop(); }, []);
  const restart = async () => {
    clientRef.current?.dispose(); clientRef.current = null; setClient(null);
    await notebookRuntime.stop(); setAttempt(n => n + 1);
  };
  useEffect(() => {
    if (!client || !props.active) return;
    let disposed = false;
    const timer = setInterval(() => {
      notebookRuntime.status().then(s => { if (!disposed && s.state !== 'ready') setError(s.message ?? 'Notebook stopped. Restart to recover.'); }).catch(e => { if (!disposed) setError(String(e)); });
    }, 10000);
    return () => { disposed = true; clearInterval(timer); };
  }, [client, props.active]);
  return <section className="notebook-page" aria-label="Notebook" style={{ display: props.active ? undefined : 'none' }}>
    {error && <div role="alert" className="nb-error"><span>{error}</span><Button onClick={() => void restart()}>Retry</Button></div>}
    {!props.vaultPath ? <div className="nb-center"><div className="nb-stack"><BookOpen size={36} className="mx-auto text-brand-400"/><h2>Research, connected to your vault</h2><p className="nb-muted">Open a vault to start your notebook workspace.</p><Button onClick={props.onSelectVault}><FolderOpen size={16}/>Open a vault</Button></div></div>
      : client ? <NotebookWorkspace key={client.workspaceId} client={client} {...props} onRestart={restart}/>
      : <div className="nb-center"><div className="nb-stack"><BookOpen size={36} className="mx-auto text-brand-400"/><h2>{starting ? 'Starting Notebook…' : 'Notebook'}</h2><p className="nb-muted">{starting ? 'Preparing your private research workspace. First startup may take a minute.' : 'Your sources, conversations, and discoveries in one place.'}</p></div></div>}
  </section>;
}

function NotebookWorkspace({ client, vaultPath, vaultNotes, settings, onVaultExport, onRestart, openChatRequest, onOpenChatRequestConsumed, onContinueInCopilot }: Props & { client: NotebookClient; onRestart: () => Promise<void> }) {
  const dialogs = useDialog();
  const library = useChatLibrary();
  const storageKey = `prism_notebook_${vaultPath}`;
  const [notebooks, setNotebooks] = useState<NotebookResponse[]>([]);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(`${storageKey}_selected`));
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [section, setSection] = useState<'workspace' | 'search' | 'chats' | 'transformations' | 'podcasts' | 'settings'>('workspace');
  const [sources, setSources] = useState<SourceListResponse[]>([]);
  const [notes, setNotes] = useState<NoteResponse[]>([]);
  const [sessions, setSessions] = useState<ChatSessionResponse[]>([]);
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions;
  const [session, setSession] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatSource, setChatSource] = useState<string>('');
  const chatSourceRef = useRef(chatSource); chatSourceRef.current = chatSource;
  // Deep-link target session id, consumed once the sessions list arrives.
  const pendingOpenSession = useRef<string | null>(null);
  const [models, setModels] = useState<ModelResponse[]>([]);
  const [model, setModel] = useState('');
  const [sourceContext, setSourceContext] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<SourceResponse | null>(null);
  const [insights, setInsights] = useState<SourceInsightResponse[]>([]);
  const [transformations, setTransformations] = useState<TransformationResponse[]>([]);
  const [transformation, setTransformation] = useState('');
  const [draft, setDraft] = useState<NoteResponse | null>(null);
  const [dirty, setDirty] = useState(false);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mobilePane, setMobilePane] = useState('chat');
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  // Stick-to-bottom: follow new chat messages only while already near the
  // bottom, so reading history is never yanked away. Sending re-sticks.
  const [chatStick, setChatStick] = useState(true);
  const [sourceWidth, setSourceWidth] = useState(() => Math.min(480, Math.max(200, Number(localStorage.getItem('prism_notebook_source_width')) || settings.notebook.sourcePanelWidth)));
  const [noteWidth, setNoteWidth] = useState(() => Math.min(480, Math.max(200, Number(localStorage.getItem('prism_notebook_note_width')) || settings.notebook.notesPanelWidth)));
  useEffect(() => { localStorage.setItem('prism_notebook_source_width', String(sourceWidth)); }, [sourceWidth]);
  useEffect(() => { localStorage.setItem('prism_notebook_note_width', String(noteWidth)); }, [noteWidth]);
  const [showImport, setShowImport] = useState(false);
  const [sourceForm, setSourceForm] = useState<'link' | 'text' | null>(null);
  const [sourceText, setSourceText] = useState('');
  const [sourceTitle, setSourceTitle] = useState('');
  const [embedSources, setEmbedSources] = useState(settings.notebook.embedByDefault);
  const [importPaths, setImportPaths] = useState<string[]>([]);
  const [importSearch, setImportSearch] = useState('');
  const [search, setSearch] = useState('');
  const [searchType, setSearchType] = useState('text');
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [archived, setArchived] = useState(false);
  const alive = useRef(true);
  const chatGeneration = useRef(0);
  const previewGeneration = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Dedupe identical consecutive errors so a persistent backend failure
  // (e.g. 422) shows one banner instead of flickering on every poll.
  const lastError = useRef('');
  const reportError = useCallback((message: string) => {
    if (!alive.current || message === lastError.current) return;
    lastError.current = message;
    setError(message);
  }, []);
  const clearError = useCallback(() => { lastError.current = ''; setError(''); }, []);
  const run = useCallback(async (operation: () => Promise<void>, opts?: { silent?: boolean }) => {
    setPending(n => n + 1); if (!opts?.silent) clearError();
    try { await operation(); if (opts?.silent && alive.current) clearError(); }
    catch (e) {
      const message = String(e);
      if (opts?.silent) { if (alive.current && !lastError.current) { lastError.current = message; setError(message); } }
      else reportError(message);
    }
    finally { if (alive.current) setPending(n => n - 1); }
  }, [clearError, reportError]);
  const refreshLibrary = useCallback(async () => {
    const rows = await client.request<NotebookResponse[]>('/notebooks');
    if (!alive.current) return;
    setNotebooks(rows);
    if (selectedRef.current && !rows.some(n => n.id === selectedRef.current)) { selectedRef.current = null; setSelected(null); }
  }, [client]);
  const refreshNotebook = useCallback(async () => {
    const id = selectedRef.current; if (!id) return;
    // Sources are paged server-side (max 100/page); notes fetch has no limit
    // param. Settled separately so a sources failure can't blank the notes.
    const [s, n] = await Promise.all([
      settled(client.listAllSources(id)),
      settled(client.request<NoteResponse[]>(`/notes?notebook_id=${encodeURIComponent(id)}`)),
    ]);
    if (!alive.current || selectedRef.current !== id) return;
    let failure: unknown = null;
    if (s.ok) setSources(s.value); else failure = s.error;
    if (n.ok) setNotes(n.value); else failure = failure ?? n.error;
    if (failure) throw failure;
  }, [client]);
  useEffect(() => { void run(async () => { await refreshLibrary(); setModels(await client.request<ModelResponse[]>('/models')); setTransformations(await client.request<TransformationResponse[]>('/transformations')); }); }, [client]);
  useEffect(() => {
    setSources([]); setNotes([]); setPreview(null); setInsights([]); setDraft(null); setDirty(false); setChatSource(''); setSession(''); setMessages([]); setSourceContext({}); setQuestion('');
    chatGeneration.current++; previewGeneration.current++;
    if (selected) { localStorage.setItem(`${storageKey}_selected`, selected); void run(refreshNotebook); }
    else localStorage.removeItem(`${storageKey}_selected`);
  }, [selected]);
  useEffect(() => {
    if (!selected) return;
    const timer = setInterval(() => { if (sources.some(s => ['new', 'pending', 'running', 'queued', 'processing'].includes(s.status ?? ''))) void run(refreshNotebook, { silent: true }); }, 3000);
    return () => clearInterval(timer);
  }, [selected, sources, refreshNotebook]);
  const sessionPath = chatSource ? `/sources/${recordId(chatSource)}/chat/sessions` : '/chat/sessions';
  // Backend (human/ai) -> library (user/assistant) transcript mapping.
  const toLibraryTranscript = (msgs: ChatMessage[]) =>
    msgs.map((m) => ({ role: (m.type === 'human' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content ?? '' }));
  // Mirror backend sessions + transcript into the shared chat library
  // (best-effort: the library must never break Notebook itself). Merges
  // rather than overwrites: turns continued in Co-Pilot (cached locally but
  // absent from the backend) are preserved after the backend transcript.
  // Returns the linked library id (or null when the mirror failed).
  const mirrorTranscript = (sid: string, msgs: ChatMessage[], notebookId: string | null, sourceId: string | null, titleOverride?: string, modelOverride?: string | null): Promise<string | null> => {
    const row = sessionsRef.current.find((r) => r.id === sid);
    return (async () => {
      try {
        const title = titleOverride ?? row?.title ?? (sourceId ? 'Source conversation' : 'Research conversation');
        const model = modelOverride ?? (row as { model_override?: string | null } | undefined)?.model_override ?? null;
        const linked = await library.linkNotebook(sid, title, notebookId, sourceId, model);
        const backend = toLibraryTranscript(msgs);
        const have = new Set(backend.map((m) => `${m.role}\n${m.content}`));
        let extras: Array<{ role: 'user' | 'assistant'; content: string; metadata?: string | null }> = [];
        try {
          const cached = await library.loadMessages(linked.id);
          extras = cached
            .filter((c) => !have.has(`${c.role}\n${c.content}`))
            .map((c) => ({ role: c.role, content: c.content, metadata: c.metadata }));
        } catch { /* first mirror: no cache yet */ }
        await library.syncTranscript(linked.id, [...backend, ...extras]);
        return linked.id;
      } catch { /* library mirror is best-effort */ return null; }
    })();
  };
  const linkSessionRows = (rows: ChatSessionResponse[], notebookId: string | null, sourceId: string | null) => {
    void (async () => {
      try {
        for (const r of rows) {
          await library.linkNotebook(
            r.id, r.title || (sourceId ? 'Source conversation' : 'Research conversation'),
            notebookId, sourceId,
            (r as { model_override?: string | null }).model_override ?? null,
          );
        }
      } catch { /* library mirror is best-effort */ }
    })();
  };
  useEffect(() => {
    if (!selected) return;
    const generation = ++chatGeneration.current;
    setSessions([]); setSession(''); setMessages([]);
    void run(async () => {
      const rows = await client.request<ChatSessionResponse[]>(chatSource ? sessionPath : `${sessionPath}?notebook_id=${encodeURIComponent(selected)}`);
      if (generation !== chatGeneration.current) return;
      setSessions(rows);
      linkSessionRows(rows, chatSource ? null : selected, chatSource || null);
      const pending = pendingOpenSession.current;
      if (pending && rows.some((r) => r.id === pending)) {
        pendingOpenSession.current = null;
        setSession(pending);
        return;
      }
      pendingOpenSession.current = null;
      const saved = localStorage.getItem(`${storageKey}_session_${chatSource || selected}`);
      const id = rows.find(r => r.id === saved)?.id ?? rows[0]?.id ?? '';
      setSession(id);
    });
  }, [selected, chatSource]);
  useEffect(() => {
    if (chatStick) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, session, chatStick]);
  const handleChatScroll = () => {
    const el = chatScrollRef.current;
    if (!el) return;
    setChatStick(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };
  useEffect(() => {
    const generation = ++chatGeneration.current;
    setMessages([]);
    setChatStick(true);
    if (!session) return;
    localStorage.setItem(`${storageKey}_session_${chatSource || selected}`, session);
    void run(async () => {
      const data = await client.request<ChatSessionWithMessagesResponse>(`${sessionPath}/${recordId(session)}`);
      if (generation !== chatGeneration.current) return;
      setMessages(data.messages ?? []);
      mirrorTranscript(session, data.messages ?? [], chatSource ? null : selected, chatSource || null);
    });
  }, [session]);

  const discardDraft = async () => !dirty || await dialogs.confirm('Discard the unsaved changes to this notebook note?', { title: 'Unsaved note', confirmLabel: 'Discard', danger: true });
  const selectNotebook = async (id: string | null) => { if (!(await discardDraft())) return; selectedRef.current = id; setSelected(id); setSection('workspace'); };
  const exportText = async (title: string, text: string) => { const name = await client.export(title, text); await onVaultExport(); setNotice(`Saved ${name} to your vault.`); };
  const openSource = async (id: string) => {
    const generation = ++previewGeneration.current;
    const [s, i] = await Promise.all([client.request<SourceResponse>(`/sources/${recordId(id)}`), client.request<SourceInsightResponse[]>(`/sources/${recordId(id)}/insights`)]);
    if (generation !== previewGeneration.current) return;
    setPreview(s); setInsights(i); setMobilePane('sources'); setSection('workspace');
  };
  const openReference = (id: string) => void run(async () => {
    if (id.startsWith('source:')) await openSource(id);
    else if (id.startsWith('note:')) { if (!(await discardDraft())) return; const loaded = await client.request<NoteResponse>(`/notes/${recordId(id)}`); draftSnapshot.current = loaded; setDraft(loaded); setDirty(false); setMobilePane('notes'); }
    else { const insight = await client.request<SourceInsightResponse>(`/insights/${recordId(id)}`); await openSource(insight.source_id); }
  });

  const addSource = (type: 'upload' | 'text' | 'link') => {
    if (type !== 'upload') { setSourceForm(type); setSourceText(''); setSourceTitle(''); return; }
    void run(async () => {
    if (!selected) return;
    const fields: Record<string, string> = { type, notebook_id: selected, embed: String(embedSources), async_processing: 'true' };
    await client.source(fields, true); await refreshNotebook();
    });
  };
  const importNotes = () => void run(async () => {
    if (!selected) return;
    const id = selected;
    const key = `${storageKey}_imports_${id}`;
    let imports: Record<string, string> = {};
    try { imports = JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { /* Old/corrupt metadata is disposable. */ }
    for (const path of importPaths) {
      if (selectedRef.current !== id) return;
      const old = imports[path];
      if (old && !(await dialogs.confirm(`Replace the previously imported snapshot of ${path}? Existing references to the old source will no longer resolve.`, { title: 'Reimport source', confirmLabel: 'Replace' }))) continue;
      const text = await client.readVaultNote(path);
      const result = await client.source({ type: 'text', notebook_id: id, title: path, content: `Original Prism note: ${path}\n\n${text}`, embed: String(embedSources), async_processing: 'false' });
      if (result) {
        // Commit the new mapping before deleting the old snapshot, so a failed
        // deletion cannot lose the successfully imported replacement.
        imports[path] = result.id; localStorage.setItem(key, JSON.stringify(imports));
        if (old) await client.request(`/sources/${recordId(old)}`, 'DELETE');
      }
    }
    setImportPaths([]); setShowImport(false); await refreshNotebook();
  });
  const newSession = async () => {
    const row = await client.request<ChatSessionResponse>(sessionPath, 'POST', chatSource ? { source_id: chatSource, title: 'Source conversation', model_override: model || null } : { notebook_id: selected, title: 'Research conversation', model_override: model || null });
    setSessions(rows => [row, ...rows]); setSession(row.id);
    linkSessionRows([row], chatSource ? null : selected, chatSource || null);
    return row.id;
  };
  const send = () => { setChatStick(true); void run(async () => {
    if (!question.trim() || !selected) return;
    const questionText = question; setQuestion('');
    const notebookId = selected; const scope = chatSource;
    const sid = session || await newSession();
    try {
      if (scope) {
        const result = await client.request<{ stream: string }>(`${sessionPath}/${recordId(sid)}/messages`, 'POST', { message: questionText, model_override: model || null });
        for (const line of result.stream.split('\n')) {
          if (line.startsWith('data: ')) { const event = JSON.parse(line.slice(6)); if (event.type === 'error') throw new Error(event.message || event.error || 'Source chat failed'); }
        }
      } else {
        const context = await client.request<BuildContextResponse>('/chat/context', 'POST', { notebook_id: notebookId, context_config: { sources: Object.fromEntries(sources.map(s => [s.id, sourceContext[s.id] ?? 'full content'])), notes: Object.fromEntries(notes.map(n => [n.id, 'full content'])) } });
        await client.request('/chat/execute', 'POST', { session_id: sid, message: questionText, context: context.context, model_override: model || null });
      }
      const data = await client.request<ChatSessionWithMessagesResponse>(`${sessionPath}/${recordId(sid)}`);
      if (selectedRef.current === notebookId) {
        setMessages(data.messages ?? []);
        mirrorTranscript(sid, data.messages ?? [], scope ? null : notebookId, scope || null);
      }
    } catch (e) { setQuestion(questionText); throw e; }
  }); };
  // Open a backend session from the shared library (deep-link): switch
  // scope when needed and let the sessions-list effect consume the pending id.
  const openNotebookSession = async (notebookId: string | null, sourceId: string | null, sessionId: string) => {
    setSection('workspace'); setMobilePane('chat');
    if (notebookId && notebookId !== selectedRef.current) {
      pendingOpenSession.current = sessionId;
      await selectNotebook(notebookId);
      if (selectedRef.current !== notebookId) pendingOpenSession.current = null;
      return;
    }
    if (sourceId && sourceId !== chatSourceRef.current) {
      pendingOpenSession.current = sessionId;
      setChatSource(sourceId);
      return;
    }
    if (sessionsRef.current.some((r) => r.id === sessionId)) setSession(sessionId);
    else pendingOpenSession.current = sessionId;
  };
  // Continue a Co-Pilot transcript here: create a backend session seeded with
  // the transcript as its opening context message (the backend has no raw
  // message-insert API, so continuation runs one model turn over it).
  const seedBackendFromTranscript = async (title: string, transcriptText: string) => {
    const nid = selectedRef.current;
    if (!nid) { setNotice('Select a notebook first to continue this chat there.'); return; }
    const row = await client.request<ChatSessionResponse>('/chat/sessions', 'POST', { notebook_id: nid, title: `From Co-Pilot: ${title}`, model_override: model || null });
    if (transcriptText.trim()) {
      const context = await client.request<BuildContextResponse>('/chat/context', 'POST', { notebook_id: nid, context_config: { sources: Object.fromEntries(sources.map(s => [s.id, sourceContext[s.id] ?? 'full content'])), notes: Object.fromEntries(notes.map(n => [n.id, 'full content'])) } });
      await client.request('/chat/execute', 'POST', { session_id: row.id, message: `Continuing a Co-Pilot conversation ("${title}"). Transcript so far:\n\n${transcriptText}\n\nPlease continue.`, context: context.context, model_override: model || null });
    }
    const rows = await client.request<ChatSessionResponse[]>(`/chat/sessions?notebook_id=${encodeURIComponent(nid)}`);
    if (alive.current && selectedRef.current === nid) { setSessions(rows); setSession(row.id); }
  };
  // Consumed-request guard: StrictMode double-invokes effects in dev, and the
  // seed flow creates backend state — it must run exactly once per request.
  const openChatConsumedTs = useRef<number | null>(null);
  useEffect(() => {
    if (!openChatRequest || openChatConsumedTs.current === openChatRequest.ts) return;
    openChatConsumedTs.current = openChatRequest.ts;
    void (async () => {
      try {
        const req = openChatRequest;
        if (req.seed) {
          setSection('workspace');
          await run(async () => { await seedBackendFromTranscript(req.seed!.title, req.seed!.transcript); });
          return;
        }
        if (req.sessionId) await openNotebookSession(req.notebookId ?? null, req.sourceId ?? null, req.sessionId);
      } finally {
        onOpenChatRequestConsumed?.();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChatRequest?.ts]);
  // Shared-library entry actions (Chats section).
  const librarySessionPath = (entry: ChatLibrarySession) =>
    entry.sourceId && entry.notebookSessionId
      ? `/sources/${recordId(entry.sourceId)}/chat/sessions/${recordId(entry.notebookSessionId)}`
      : `/chat/sessions/${recordId(entry.notebookSessionId ?? '')}`;
  const openLibraryEntry = (entry: ChatLibrarySession) => {
    if (entry.origin === 'notebook' && entry.notebookSessionId) {
      void run(() => openNotebookSession(entry.notebookId, entry.sourceId, entry.notebookSessionId!));
    } else {
      onContinueInCopilot?.(entry.id);
    }
  };
  const continueLibraryEntryInCopilot = (entry: ChatLibrarySession) => void run(async () => {
    if (entry.origin === 'notebook' && entry.notebookSessionId) {
      // Ensure the cached transcript is fresh, then hand over (merging keeps
      // any turns previously continued in Co-Pilot).
      const data = await client.request<ChatSessionWithMessagesResponse | SourceChatSessionWithMessagesResponse>(librarySessionPath(entry));
      // Wait for the merge before navigating so Co-Pilot opens the full copy.
      const linkedId = await mirrorTranscript(entry.notebookSessionId, data.messages ?? [], entry.notebookId, entry.sourceId, entry.title, entry.model);
      onContinueInCopilot?.(linkedId ?? entry.id);
    } else {
      onContinueInCopilot?.(entry.id);
    }
  });
  const continueCopilotEntryHere = (entry: ChatLibrarySession) => void run(async () => {
    const rows = await library.loadMessages(entry.id);
    const text = rows.map((m) => `${m.role === 'user' ? 'You' : 'Assistant'}: ${m.content}`).join('\n\n');
    await seedBackendFromTranscript(entry.title, text);
  });
  const renameLibraryEntry = (entry: ChatLibrarySession) => void run(async () => {
    const title = await dialogs.prompt('Chat title', { title: 'Rename chat', initialValue: entry.title });
    if (!title?.trim() || title.trim() === entry.title) return;
    if (entry.origin === 'notebook' && entry.notebookSessionId) {
      await client.request(librarySessionPath(entry), 'PUT', { title: title.trim() });
      setSessions((rows) => rows.map((r) => r.id === entry.notebookSessionId ? { ...r, title: title.trim() } : r));
      await library.linkNotebook(entry.notebookSessionId, title.trim(), entry.notebookId, entry.sourceId, entry.model);
    } else {
      await library.rename(entry.id, title.trim());
    }
  });
  const deleteLibraryEntry = (entry: ChatLibrarySession) => void run(async () => {
    if (entry.origin === 'notebook' && entry.notebookSessionId) {
      if (!(await dialogs.confirm(`Delete "${entry.title}" from Notebook? Its library link is removed too.`, { title: 'Delete chat', confirmLabel: 'Delete', danger: true }))) return;
      await client.request(librarySessionPath(entry), 'DELETE');
      setSessions((rows) => rows.filter((r) => r.id !== entry.notebookSessionId));
      if (session === entry.notebookSessionId) setSession('');
      try { await library.unlinkNotebook(entry.notebookSessionId); } catch { /* best-effort */ }
    } else {
      if (!(await dialogs.confirm(`Delete "${entry.title}" and its history? This cannot be undone.`, { title: 'Delete chat', confirmLabel: 'Delete', danger: true }))) return;
      await library.remove(entry.id);
    }
  });
  // Snapshot of the note as loaded from the API — Cancel restores this
  // without any mutation; a failed Save keeps the user's unsaved draft.
  const draftSnapshot = useRef<NoteResponse | null>(null);
  const noteTitleRef = useRef<HTMLInputElement | null>(null);
  const saveNoteInFlight = useRef(false);
  const [savingNote, setSavingNote] = useState(false);
  // Direct edit: fetch + populate the editor for exactly this note, with no
  // prior selection step required from the caller.
  const editNote = async (id: string) => {
    if (!(await discardDraft())) return;
    const loaded = await client.request<NoteResponse>(`/notes/${recordId(id)}`);
    if (!alive.current) return;
    draftSnapshot.current = loaded;
    setDraft(loaded); setDirty(false); setMobilePane('notes');
    requestAnimationFrame(() => noteTitleRef.current?.focus());
  };
  const cancelNoteEdit = async () => {
    if (dirty && !(await discardDraft())) return;
    // Restore the original value; never touches the API.
    setDraft(draftSnapshot.current); setDirty(false);
  };
  const saveNote = async () => {
    if (!draft || saveNoteInFlight.current) return;
    saveNoteInFlight.current = true; setSavingNote(true);
    try {
      const result = await client.request<NoteResponse>(draft.id ? `/notes/${recordId(draft.id)}` : '/notes', draft.id ? 'PUT' : 'POST', { title: draft.title, content: draft.content ?? '', note_type: draft.note_type ?? 'human', ...(!draft.id && { notebook_id: selected }) });
      if (!alive.current) return;
      draftSnapshot.current = result;
      setDraft(result); setDirty(false);
      // Update the list immediately without waiting for a full refresh.
      setNotes(rows => {
        const next = rows.some(r => r.id === result.id)
          ? rows.map(r => r.id === result.id ? result : r)
          : [...rows, result];
        return [...next].sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
      });
      await refreshNotebook();
    } finally {
      saveNoteInFlight.current = false;
      if (alive.current) setSavingNote(false);
    }
  };
  const notebook = notebooks.find(n => n.id === selected);
  const busy = pending > 0;

  return <>
    <div className="nb-toolbar">
      {selected && <Button aria-label="Notebook library" onClick={() => void run(() => selectNotebook(null))}><ArrowLeft size={16}/></Button>}
      <BookOpen size={18} className="text-brand-400"/><h1 className="text-sm font-semibold flex-1 truncate">{notebook?.name ?? 'Notebooks'}</h1>
      <div className="nb-tabs">{([['workspace', BookOpen, 'Research'], ['search', Search, 'Search'], ['chats', History, 'Chats'], ['transformations', Wand2, 'Transform'], ['podcasts', Headphones, 'Podcasts'], ['settings', Settings2, 'Manage']] as const).map(([key, Icon, label]) => <Button key={key} aria-pressed={section === key} onClick={() => setSection(key)}><Icon size={14}/>{label}</Button>)}</div>
      <Button title="Refresh" aria-label="Refresh notebooks" disabled={busy} onClick={() => void run(async () => { await refreshLibrary(); await refreshNotebook(); })}><RefreshCw size={14}/></Button>
    </div>
    {error && <div className="nb-error" role="alert"><span>{error}</span><Button aria-label="Dismiss error" onClick={clearError}><X size={14}/></Button></div>}
    {notice && <div className="nb-toolbar nb-muted" role="status"><span className="flex-1">{notice}</span><Button aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={14}/></Button></div>}
    {busy && <div className="h-0.5 bg-brand-500 animate-pulse" role="status" aria-label="Notebook is working"/>}
    {section === 'search' ? <div className="nb-scroll nb-stack">
      <form className="nb-toolbar" onSubmit={e => { e.preventDefault(); void run(async () => setResults(await client.request<SearchResponse>('/search', 'POST', { query: search, type: searchType, notebook_id: selected, limit: 100, search_sources: true, search_notes: true }))); }}>
        <input className="nb-input flex-1" aria-label="Search notebook content" value={search} onChange={e => setSearch(e.target.value)} placeholder={selected ? 'Search this notebook…' : 'Search all notebooks…'}/>
        <select className="nb-input w-auto" aria-label="Search type" value={searchType} onChange={e => setSearchType(e.target.value)}><option value="text">Full text</option><option value="vector">Semantic</option></select><Button type="submit" disabled={busy || !search.trim()}>Search</Button>
      </form>
      {results && <p className="nb-muted">{results.total_count} results</p>}
      {results?.results.map((r, i) => <article className="nb-card nb-stack" key={String(r.id ?? i)}><h3>{String(r.title ?? r.name ?? 'Result')}</h3><NotebookMarkdown text={String(r.content ?? r.full_text ?? r.text ?? '')} onReference={openReference}/><Button onClick={() => openReference(String(r.id))}>Open result</Button></article>)}
    </div> : section === 'chats' ? <div className="nb-scroll nb-stack">
      <div className="nb-toolbar"><div className="flex-1"><h2 className="text-lg">Chat library</h2><p className="nb-muted">Co-Pilot and Notebook conversations in this vault, shared both ways.</p></div><input className="nb-input" style={{ maxWidth: 220 }} placeholder="Search chats…" aria-label="Search chats" value={library.search} onChange={e => library.setSearch(e.target.value)}/></div>
      {!library.sessions.length && <p className="nb-muted">No chats yet. Notebook conversations appear here automatically; Co-Pilot chats arrive as you talk.</p>}
      {library.sessions.map(entry => <article className="nb-card nb-stack" key={entry.id}>
        <h3 className="font-semibold">{entry.title}</h3>
        <p className="nb-muted">{entry.origin === 'notebook' ? 'Notebook' : 'Co-Pilot'} · {entry.messageCount} msgs · {new Date(entry.updatedAt * 1000).toLocaleString()}</p>
        <div className="nb-tabs">
          {entry.origin === 'notebook'
            ? <><Button disabled={busy} onClick={() => openLibraryEntry(entry)}>Open</Button><Button disabled={busy} onClick={() => continueLibraryEntryInCopilot(entry)}><ExternalLink size={14}/> Continue in Co-Pilot</Button></>
            : <><Button disabled={busy} onClick={() => continueCopilotEntryHere(entry)}>Continue here</Button><Button disabled={busy} onClick={() => onContinueInCopilot?.(entry.id)}><ExternalLink size={14}/> Open in Co-Pilot</Button></>}
          <Button disabled={busy} onClick={() => renameLibraryEntry(entry)}>Rename</Button>
          <Button disabled={busy} onClick={() => deleteLibraryEntry(entry)}>Delete</Button>
        </div>
      </article>)}
    </div> : section !== 'workspace' ? <NotebookManage key={section} section={section} client={client} notebookId={selected} config={settings.omniRoute} workerConcurrency={settings.notebook.workerConcurrency} onExport={exportText} onReference={openReference} onRestart={onRestart}/>
    : !selected ? <div className="nb-scroll nb-stack">
      <div className="nb-toolbar"><div className="flex-1"><h2 className="text-lg">Your research library</h2><p className="nb-muted">Bring sources together. Ask questions. Keep what you discover.</p></div><label className="nb-muted"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)}/> Archived</label><Button className="primary" disabled={busy} onClick={() => void run(async () => { const name = await dialogs.prompt('Notebook name', { title: 'Create notebook' }); if (!name?.trim()) return; const row = await client.request<NotebookResponse>('/notebooks', 'POST', { name: name.trim(), description: '' }); await refreshLibrary(); await selectNotebook(row.id); })}><Plus size={14}/>New notebook</Button></div>
      {!notebooks.length && <div className="nb-center"><div className="nb-stack"><BookOpen size={44} className="text-brand-400 mx-auto"/><p>Create your first notebook to start researching.</p></div></div>}
      <div className="nb-grid">{notebooks.filter(n => n.archived === archived).map(n => <article className="nb-card nb-stack" key={n.id}><button className="text-left" onClick={() => void run(() => selectNotebook(n.id))}><h3 className="font-semibold">{n.name}</h3><p className="nb-muted mt-2">{n.description || 'A space for your next discovery'}</p></button><p className="nb-muted">{n.source_count} sources · {n.note_count} notes</p><div className="nb-tabs"><Button disabled={busy} onClick={() => void run(async () => { const name = await dialogs.prompt('Notebook name', { initialValue: n.name }); if (!name?.trim()) return; const description = await dialogs.prompt('Description', { initialValue: n.description }); if (description === null) return; await client.request(`/notebooks/${recordId(n.id)}`, 'PUT', { name, description }); await refreshLibrary(); })}>Edit</Button><Button disabled={busy} onClick={() => void run(async () => { await client.request(`/notebooks/${recordId(n.id)}`, 'PUT', { archived: !n.archived }); await refreshLibrary(); })}>{n.archived ? 'Restore' : 'Archive'}</Button><Button disabled={busy} onClick={() => void run(async () => { const preview = await client.request<{ note_count: number; exclusive_source_count: number }>(`/notebooks/${recordId(n.id)}/delete-preview`); if (!(await dialogs.confirm(`Delete ${n.name}, ${preview.note_count} notes and ${preview.exclusive_source_count} exclusive sources?`, { danger: true, confirmLabel: 'Delete' }))) return; await client.request(`/notebooks/${recordId(n.id)}`, 'DELETE'); await refreshLibrary(); })}>Delete</Button></div></article>)}</div>
    </div> : <>
      <div className="nb-toolbar nb-mobile-tabs">{['sources', 'chat', 'notes'].map(p => <Button key={p} aria-pressed={mobilePane === p} onClick={() => setMobilePane(p)}>{p[0].toUpperCase() + p.slice(1)}</Button>)}</div>
      <div className="nb-workspace">
        <aside className="nb-pane" data-active={mobilePane === 'sources'} style={{ width: sourceWidth }} aria-label="Sources">
          <div className="nb-toolbar"><h2 className="font-semibold flex-1 text-sm">Sources</h2><Button disabled={busy} onClick={() => addSource('upload')} aria-label="Upload source"><Upload size={14}/></Button></div>
          <div className="nb-scroll nb-stack">
            <div className="nb-tabs"><Button disabled={busy} onClick={() => addSource('link')}>URL</Button><Button disabled={busy} onClick={() => addSource('text')}>Text</Button><Button onClick={() => setShowImport(v => !v)}>From vault</Button></div>
            <label className="nb-muted"><input type="checkbox" checked={embedSources} onChange={e => setEmbedSources(e.target.checked)}/>Embed new sources for semantic search</label>
            {sourceForm && <form className="nb-card nb-stack" onSubmit={e => { e.preventDefault(); void run(async () => {
              if (!selected || !sourceText.trim()) return;
              await client.source({ type: sourceForm, notebook_id: selected, title: sourceTitle || (sourceForm === 'text' ? 'Text source' : sourceText), [sourceForm === 'text' ? 'content' : 'url']: sourceText, embed: String(embedSources), async_processing: 'true' });
              setSourceForm(null); setSourceText(''); await refreshNotebook();
            }); }}><Field label="Source title"><input className="nb-input" value={sourceTitle} onChange={e => setSourceTitle(e.target.value)}/></Field><Field label={sourceForm === 'text' ? 'Source text' : 'Web page or video URL'}>{sourceForm === 'text' ? <textarea className="nb-input" rows={6} required value={sourceText} onChange={e => setSourceText(e.target.value)}/> : <input className="nb-input" type="url" required value={sourceText} onChange={e => setSourceText(e.target.value)}/>}</Field><div className="nb-tabs"><Button type="submit" disabled={busy || !sourceText.trim()}>Add source</Button><Button disabled={busy} onClick={() => setSourceForm(null)}>Cancel</Button></div></form>}
            {showImport && <div className="nb-card nb-stack"><input className="nb-input" placeholder="Find a vault note…" aria-label="Filter vault notes" value={importSearch} onChange={e => setImportSearch(e.target.value)}/><div className="max-h-48 overflow-auto nb-stack">{vaultNotes.filter(n => n.relativePath.toLowerCase().includes(importSearch.toLowerCase())).map(n => <label key={n.relativePath} className="nb-muted"><input type="checkbox" checked={importPaths.includes(n.relativePath)} onChange={e => setImportPaths(p => e.target.checked ? [...p, n.relativePath] : p.filter(x => x !== n.relativePath))}/>{n.relativePath}</label>)}</div><Button disabled={busy || !importPaths.length} onClick={importNotes}>Import {importPaths.length || ''} selected</Button></div>}
            {!sources.length && <p className="nb-muted">Add a document, web page, video, recording, or vault note.</p>}
            <div className="nb-source-list">{sources.map(s => <div key={s.id} className="nb-source" aria-current={preview?.id === s.id}><div className="min-w-0 flex-1"><button className="text-left text-sm w-full truncate" onClick={() => void run(() => openSource(s.id))}>{s.title || 'Untitled source'}</button><p className="nb-muted">{s.status || (s.embedded ? 'Indexed' : 'Ready')}</p><select className="nb-input mt-1 text-xs" aria-label={`Chat context for ${s.title}`} value={sourceContext[s.id] ?? 'full content'} onChange={e => setSourceContext(c => ({ ...c, [s.id]: e.target.value }))}><option>full content</option><option>insights</option><option>not in context</option></select></div></div>)}</div>
            {preview && <article className="nb-stack border-t border-slate-800 pt-3"><h3 className="font-semibold text-sm">{preview.title}</h3><div className="nb-tabs"><Button disabled={busy} onClick={() => { setChatSource(preview.id); setMobilePane('chat'); }}>Chat with source</Button><Button disabled={busy} onClick={() => void run(async () => { await client.request(`/sources/${recordId(preview.id)}/retry`, 'POST'); await refreshNotebook(); })}>Retry processing</Button><Button disabled={busy} onClick={() => void run(async () => { await client.request('/embed', 'POST', { item_id: preview.id, item_type: 'source', async_processing: true }); setNotice('Embedding queued.'); })}>Embed</Button><Button disabled={busy} onClick={() => void run(async () => { const title = await dialogs.prompt('Source title', { initialValue: preview.title ?? '' }); if (title === null) return; await client.request(`/sources/${recordId(preview.id)}`, 'PUT', { title }); await refreshNotebook(); await openSource(preview.id); })}>Rename</Button>{preview.file_available && <Button onClick={() => void run(async () => { await client.download(`/sources/${recordId(preview.id)}/download`, preview.title || 'source'); })}>Download</Button>}<Button disabled={busy} onClick={() => void run(async () => { if (!(await dialogs.confirm('Delete this source and its insights? Other notebooks using it are also affected.', { danger: true }))) return; await client.request(`/sources/${recordId(preview.id)}`, 'DELETE'); setPreview(null); await refreshNotebook(); })}>Delete</Button></div>
              {preview.asset?.url && <a className="nb-muted underline" href={/^https?:\/\//.test(preview.asset.url) ? preview.asset.url : undefined} target="_blank" rel="noreferrer">Original source</a>}
              <details><summary className="nb-muted cursor-pointer">Extracted text</summary><NotebookMarkdown text={preview.full_text || 'Source is still processing or has no extracted text.'} onReference={openReference}/></details>
              <Field label="Generate an insight"><select className="nb-input" value={transformation} onChange={e => setTransformation(e.target.value)}><option value="">Choose a transformation</option>{transformations.map(t => <option value={t.id} key={t.id}>{t.title}</option>)}</select></Field><Button disabled={busy || !transformation} onClick={() => void run(async () => { await client.request(`/sources/${recordId(preview.id)}/insights`, 'POST', { transformation_id: transformation, model_id: model || null }); setNotice('Insight generation queued. Use Refresh insights to retrieve the result.'); })}>Generate insight</Button><Button onClick={() => void run(() => openSource(preview.id))}>Refresh insights</Button>
              {insights.map(i => <div className="nb-card nb-stack" key={i.id}><h4 className="text-sm font-semibold">{i.insight_type}</h4><NotebookMarkdown text={i.content} onReference={openReference}/><Button onClick={() => void run(async () => { await client.request(`/insights/${recordId(i.id)}/save-as-note`, 'POST', { notebook_id: selected }); await refreshNotebook(); })}>Save as note</Button><Button onClick={() => void run(async () => { await client.request(`/insights/${recordId(i.id)}`, 'DELETE'); await openSource(preview.id); })}>Delete insight</Button></div>)}
            </article>}
          </div>
        </aside>
        <div className="nb-resize"><ResizeHandle direction="horizontal" onResize={d => setSourceWidth(w => Math.min(480, Math.max(200, w + d)))}/></div>
        <main className="nb-pane flex-1" data-active={mobilePane === 'chat'} aria-label="Notebook chat">
          <div className="nb-toolbar"><h2 className="font-semibold text-sm flex-1">{chatSource ? 'Source conversation' : 'Notebook conversation'}</h2>{chatSource && <Button disabled={busy} onClick={() => setChatSource('')}>All sources</Button>}<Button disabled={busy} onClick={() => void run(async () => { await newSession(); })}><Plus size={14}/>Chat</Button></div>
          <div className="nb-toolbar"><select className="nb-input flex-1" aria-label="Conversation" value={session} disabled={busy} onChange={e => setSession(e.target.value)}><option value="">New conversation</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select>{session && <><Button disabled={busy} onClick={() => void run(async () => { const title = await dialogs.prompt('Conversation title'); if (!title?.trim()) return; await client.request(`${sessionPath}/${recordId(session)}`, 'PUT', { title }); setSessions(rows => rows.map(r => r.id === session ? { ...r, title } : r)); linkSessionRows([{ ...sessionsRef.current.find(r => r.id === session), id: session, title } as ChatSessionResponse], chatSourceRef.current ? null : selected, chatSourceRef.current || null); })}>Rename</Button><Button disabled={busy} onClick={() => void run(async () => { if (!(await dialogs.confirm('Delete this conversation?', { danger: true }))) return; await client.request(`${sessionPath}/${recordId(session)}`, 'DELETE'); setSessions(rows => rows.filter(r => r.id !== session)); setSession(''); try { await library.unlinkNotebook(session); } catch { /* best-effort */ } })}>Delete</Button><Button disabled={busy} title="Open this chat in the Co-Pilot sidebar (transcript is synced to the shared library)" onClick={() => void run(async () => { const row = sessionsRef.current.find(r => r.id === session); const linked = await library.linkNotebook(session, row?.title || 'Research conversation', chatSourceRef.current ? null : selected, chatSourceRef.current || null, (row as { model_override?: string | null } | undefined)?.model_override ?? null); await library.syncTranscript(linked.id, toLibraryTranscript(messages)); onContinueInCopilot?.(linked.id); })}>Continue in Co-Pilot</Button></>}</div>
          <div ref={chatScrollRef} onScroll={handleChatScroll} className="nb-scroll nb-stack flex-1" aria-live="polite">{!messages.length && <div className="nb-center nb-muted">Ask a question about your sources. Choose which sources to include using the context controls.</div>}{messages.map(m => <article key={m.id} className="nb-card nb-stack"><span className="nb-muted">{m.type === 'human' ? 'You' : 'Notebook'}</span>{m.type !== 'human' ? <NotebookChatMessage message={m} onReference={openReference}/> : <NotebookMarkdown text={m.content} onReference={openReference}/>}{m.type !== 'human' && <div className="nb-tabs"><Button onClick={() => void run(async () => { await client.request('/notes', 'POST', { title: 'Research answer', content: m.content, note_type: 'ai', notebook_id: selected }); await refreshNotebook(); })}>Save as note</Button><Button onClick={() => void run(() => exportText('Research answer', m.content))}>Save to vault</Button></div>}</article>)}<div ref={chatEndRef}/>{!chatStick && messages.length > 0 && <div className="nb-toolbar justify-center"><Button onClick={() => setChatStick(true)}><ChevronDown size={14}/> Latest</Button></div>}</div>
          <form className="nb-compose" onSubmit={e => { e.preventDefault(); send(); }}><select className="nb-input text-xs" aria-label="Chat model" value={model} onChange={e => setModel(e.target.value)}><option value="">Default chat model</option>{models.filter(m => m.type === 'language').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><textarea className="nb-input" aria-label="Question" rows={3} value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ask about your research…"/><Button type="submit" className="primary justify-self-end" disabled={busy || !question.trim()}><Send size={14}/>Send</Button></form>
        </main>
        <div className="nb-resize"><ResizeHandle direction="horizontal" onResize={d => setNoteWidth(w => Math.min(480, Math.max(200, w - d)))}/></div>
        <aside className="nb-pane" style={{ width: noteWidth }} data-active={mobilePane === 'notes'} aria-label="Notebook notes"><div className="nb-toolbar"><h2 className="font-semibold text-sm flex-1">Notes</h2><Button disabled={busy} aria-label="New note" onClick={() => void run(async () => { if (!(await discardDraft())) return; draftSnapshot.current = null; setDraft({ id: '', title: 'New note', content: '', note_type: 'human', created: '', updated: '' }); setDirty(true); requestAnimationFrame(() => noteTitleRef.current?.focus()); })}><Plus size={14}/></Button></div><div className="nb-scroll nb-stack">{notes.map(n => <div key={n.id} className="nb-note-row flex items-center gap-1"><Button className="flex-1 text-left" aria-pressed={draft?.id === n.id} onClick={() => void run(() => editNote(n.id))}>{n.title || 'Untitled note'}</Button><Button aria-label={`Edit ${n.title || 'untitled note'}`} title="Edit note" disabled={busy} onClick={() => void run(() => editNote(n.id))}><Pencil size={14}/></Button></div>)}{!notes.length && !draft && <p className="nb-muted">Write a note or save an answer from your conversation.</p>}{draft && <div className="nb-stack"><Field label="Title"><input ref={noteTitleRef} className="nb-input" value={draft.title ?? ''} onChange={e => { setDraft({ ...draft, title: e.target.value }); setDirty(true); }}/></Field><Field label="Note"><textarea className="nb-input min-h-64" value={draft.content ?? ''} onChange={e => { setDraft({ ...draft, content: e.target.value }); setDirty(true); }}/></Field><div className="nb-tabs"><Button disabled={busy || savingNote || !dirty} className="primary" onClick={() => void run(saveNote)}>{savingNote ? 'Saving…' : 'Save'}</Button><Button disabled={busy || savingNote} onClick={() => void cancelNoteEdit()}>Cancel</Button><Button disabled={busy || savingNote} onClick={() => void run(() => exportText(draft.title || 'Note', draft.content || ''))}>Save to vault</Button>{draft.id && <Button disabled={busy || savingNote} onClick={() => void run(async () => { if (!(await dialogs.confirm('Delete this notebook note?', { danger: true }))) return; await client.request(`/notes/${recordId(draft.id)}`, 'DELETE'); draftSnapshot.current = null; setDraft(null); setDirty(false); await refreshNotebook(); })}>Delete</Button>}</div></div>}</div></aside>
      </div>
    </>}
  </>;
}

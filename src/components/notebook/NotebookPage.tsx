import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { BookOpen, Plus, ArrowLeft, Upload, RefreshCw, Send, X, Settings2, Search, Headphones, Wand2, FolderOpen } from 'lucide-react';
import { NotebookClient, notebookRuntime, recordId } from '../../services/notebook';
import type { AppSettings, NoteFile } from '../../types';
import type { NotebookResponse, SourceListResponse, SourceResponse, NoteResponse, ChatSessionResponse, ChatSessionWithMessagesResponse, ChatMessage, BuildContextResponse, SourceInsightResponse, TransformationResponse, SearchResponse, ModelResponse } from '../../types/notebook-api';
import { useDialog } from '../DialogProvider';
import { ResizeHandle } from '../ResizeHandle';
import { NotebookManage } from './NotebookManage';
import './notebook.css';

export const Button = ({ children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" className={`nb-button ${className}`} {...props}>{children}</button>;
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  return <div className="nb-label"><label htmlFor={id}>{label}</label>{React.isValidElement<{ id?: string }>(children) ? React.cloneElement(children, { id }) : children}</div>;
}

export function NotebookMarkdown({ text, onReference }: { text: string; onReference: (id: string) => void }) {
  const linked = text.replace(/\[\[?((?:source|note|source_insight|insight):[a-zA-Z0-9_-]+)\]?\]/g, (_, id) => `[${id}](prism:${id})`);
  return <div className="nb-message"><ReactMarkdown urlTransform={url => url.startsWith('prism:') ? url : defaultUrlTransform(url)} components={{ a: ({ href, children }) => href?.startsWith('prism:')
    ? <button className="nb-citation" onClick={() => onReference(href.slice(6))}>{children}</button>
    : <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{linked}</ReactMarkdown></div>;
}

interface Props {
  active: boolean;
  vaultPath: string;
  vaultNotes: NoteFile[];
  settings: AppSettings;
  onSelectVault: () => void;
  onVaultExport: () => Promise<void>;
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

function NotebookWorkspace({ client, vaultPath, vaultNotes, settings, onVaultExport, onRestart }: Props & { client: NotebookClient; onRestart: () => Promise<void> }) {
  const dialogs = useDialog();
  const storageKey = `prism_notebook_${vaultPath}`;
  const [notebooks, setNotebooks] = useState<NotebookResponse[]>([]);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(`${storageKey}_selected`));
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [section, setSection] = useState<'workspace' | 'search' | 'transformations' | 'podcasts' | 'settings'>('workspace');
  const [sources, setSources] = useState<SourceListResponse[]>([]);
  const [notes, setNotes] = useState<NoteResponse[]>([]);
  const [sessions, setSessions] = useState<ChatSessionResponse[]>([]);
  const [session, setSession] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatSource, setChatSource] = useState<string>('');
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

  const run = useCallback(async (operation: () => Promise<void>) => {
    setPending(n => n + 1); setError('');
    try { await operation(); }
    catch (e) { if (alive.current) setError(String(e)); }
    finally { if (alive.current) setPending(n => n - 1); }
  }, []);
  const refreshLibrary = useCallback(async () => {
    const rows = await client.request<NotebookResponse[]>('/notebooks');
    if (!alive.current) return;
    setNotebooks(rows);
    if (selectedRef.current && !rows.some(n => n.id === selectedRef.current)) { selectedRef.current = null; setSelected(null); }
  }, [client]);
  const refreshNotebook = useCallback(async () => {
    const id = selectedRef.current; if (!id) return;
    const [s, n] = await Promise.all([client.request<SourceListResponse[]>(`/sources?notebook_id=${encodeURIComponent(id)}&limit=1000`), client.request<NoteResponse[]>(`/notes?notebook_id=${encodeURIComponent(id)}`)]);
    if (alive.current && selectedRef.current === id) { setSources(s); setNotes(n); }
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
    const timer = setInterval(() => { if (sources.some(s => ['new', 'pending', 'running', 'queued', 'processing'].includes(s.status ?? ''))) void run(refreshNotebook); }, 3000);
    return () => clearInterval(timer);
  }, [selected, sources, refreshNotebook]);
  const sessionPath = chatSource ? `/sources/${recordId(chatSource)}/chat/sessions` : '/chat/sessions';
  useEffect(() => {
    if (!selected) return;
    const generation = ++chatGeneration.current;
    setSessions([]); setSession(''); setMessages([]);
    void run(async () => {
      const rows = await client.request<ChatSessionResponse[]>(chatSource ? sessionPath : `${sessionPath}?notebook_id=${encodeURIComponent(selected)}`);
      if (generation !== chatGeneration.current) return;
      setSessions(rows);
      const saved = localStorage.getItem(`${storageKey}_session_${chatSource || selected}`);
      const id = rows.find(r => r.id === saved)?.id ?? rows[0]?.id ?? '';
      setSession(id);
    });
  }, [selected, chatSource]);
  useEffect(() => {
    const generation = ++chatGeneration.current;
    setMessages([]);
    if (!session) return;
    localStorage.setItem(`${storageKey}_session_${chatSource || selected}`, session);
    void run(async () => {
      const data = await client.request<ChatSessionWithMessagesResponse>(`${sessionPath}/${recordId(session)}`);
      if (generation === chatGeneration.current) setMessages(data.messages ?? []);
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
    else if (id.startsWith('note:')) { if (!(await discardDraft())) return; setDraft(await client.request<NoteResponse>(`/notes/${recordId(id)}`)); setDirty(false); setMobilePane('notes'); }
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
    setSessions(rows => [row, ...rows]); setSession(row.id); return row.id;
  };
  const send = () => void run(async () => {
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
      if (selectedRef.current === notebookId) setMessages(data.messages ?? []);
    } catch (e) { setQuestion(questionText); throw e; }
  });
  const saveNote = async () => {
    if (!draft) return;
    const result = await client.request<NoteResponse>(draft.id ? `/notes/${recordId(draft.id)}` : '/notes', draft.id ? 'PUT' : 'POST', { title: draft.title, content: draft.content ?? '', note_type: draft.note_type ?? 'human', ...(!draft.id && { notebook_id: selected }) });
    setDraft(result); setDirty(false); await refreshNotebook();
  };
  const notebook = notebooks.find(n => n.id === selected);
  const busy = pending > 0;

  return <>
    <div className="nb-toolbar">
      {selected && <Button aria-label="Notebook library" onClick={() => void run(() => selectNotebook(null))}><ArrowLeft size={16}/></Button>}
      <BookOpen size={18} className="text-brand-400"/><h1 className="text-sm font-semibold flex-1 truncate">{notebook?.name ?? 'Notebooks'}</h1>
      <div className="nb-tabs">{([['workspace', BookOpen, 'Research'], ['search', Search, 'Search'], ['transformations', Wand2, 'Transform'], ['podcasts', Headphones, 'Podcasts'], ['settings', Settings2, 'Manage']] as const).map(([key, Icon, label]) => <Button key={key} aria-pressed={section === key} onClick={() => setSection(key)}><Icon size={14}/>{label}</Button>)}</div>
      <Button title="Refresh" aria-label="Refresh notebooks" disabled={busy} onClick={() => void run(async () => { await refreshLibrary(); await refreshNotebook(); })}><RefreshCw size={14}/></Button>
    </div>
    {error && <div className="nb-error" role="alert"><span>{error}</span><Button aria-label="Dismiss error" onClick={() => setError('')}><X size={14}/></Button></div>}
    {notice && <div className="nb-toolbar nb-muted" role="status"><span className="flex-1">{notice}</span><Button aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={14}/></Button></div>}
    {busy && <div className="h-0.5 bg-brand-500 animate-pulse" role="status" aria-label="Notebook is working"/>}
    {section === 'search' ? <div className="nb-scroll nb-stack">
      <form className="nb-toolbar" onSubmit={e => { e.preventDefault(); void run(async () => setResults(await client.request<SearchResponse>('/search', 'POST', { query: search, type: searchType, notebook_id: selected, limit: 100, search_sources: true, search_notes: true }))); }}>
        <input className="nb-input flex-1" aria-label="Search notebook content" value={search} onChange={e => setSearch(e.target.value)} placeholder={selected ? 'Search this notebook…' : 'Search all notebooks…'}/>
        <select className="nb-input w-auto" aria-label="Search type" value={searchType} onChange={e => setSearchType(e.target.value)}><option value="text">Full text</option><option value="vector">Semantic</option></select><Button type="submit" disabled={busy || !search.trim()}>Search</Button>
      </form>
      {results && <p className="nb-muted">{results.total_count} results</p>}
      {results?.results.map((r, i) => <article className="nb-card nb-stack" key={String(r.id ?? i)}><h3>{String(r.title ?? r.name ?? 'Result')}</h3><NotebookMarkdown text={String(r.content ?? r.full_text ?? r.text ?? '')} onReference={openReference}/><Button onClick={() => openReference(String(r.id))}>Open result</Button></article>)}
    </div> : section !== 'workspace' ? <NotebookManage key={section} section={section} client={client} notebookId={selected} config={settings.omniRoute} onExport={exportText} onReference={openReference} onRestart={onRestart}/>
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
          <div className="nb-toolbar"><select className="nb-input flex-1" aria-label="Conversation" value={session} disabled={busy} onChange={e => setSession(e.target.value)}><option value="">New conversation</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select>{session && <><Button disabled={busy} onClick={() => void run(async () => { const title = await dialogs.prompt('Conversation title'); if (!title?.trim()) return; await client.request(`${sessionPath}/${recordId(session)}`, 'PUT', { title }); setSessions(rows => rows.map(r => r.id === session ? { ...r, title } : r)); })}>Rename</Button><Button disabled={busy} onClick={() => void run(async () => { if (!(await dialogs.confirm('Delete this conversation?', { danger: true }))) return; await client.request(`${sessionPath}/${recordId(session)}`, 'DELETE'); setSessions(rows => rows.filter(r => r.id !== session)); setSession(''); })}>Delete</Button></>}</div>
          <div className="nb-scroll nb-stack flex-1" aria-live="polite">{!messages.length && <div className="nb-center nb-muted">Ask a question about your sources. Choose which sources to include using the context controls.</div>}{messages.map(m => <article key={m.id} className="nb-card nb-stack"><span className="nb-muted">{m.type === 'human' ? 'You' : 'Notebook'}</span><NotebookMarkdown text={m.content} onReference={openReference}/>{m.type !== 'human' && <div className="nb-tabs"><Button onClick={() => void run(async () => { await client.request('/notes', 'POST', { title: 'Research answer', content: m.content, note_type: 'ai', notebook_id: selected }); await refreshNotebook(); })}>Save as note</Button><Button onClick={() => void run(() => exportText('Research answer', m.content))}>Save to vault</Button></div>}</article>)}</div>
          <form className="nb-compose" onSubmit={e => { e.preventDefault(); send(); }}><select className="nb-input text-xs" aria-label="Chat model" value={model} onChange={e => setModel(e.target.value)}><option value="">Default chat model</option>{models.filter(m => m.type === 'language').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><textarea className="nb-input" aria-label="Question" rows={3} value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ask about your research…"/><Button type="submit" className="primary justify-self-end" disabled={busy || !question.trim()}><Send size={14}/>Send</Button></form>
        </main>
        <div className="nb-resize"><ResizeHandle direction="horizontal" onResize={d => setNoteWidth(w => Math.min(480, Math.max(200, w - d)))}/></div>
        <aside className="nb-pane" style={{ width: noteWidth }} data-active={mobilePane === 'notes'} aria-label="Notebook notes"><div className="nb-toolbar"><h2 className="font-semibold text-sm flex-1">Notes</h2><Button disabled={busy} onClick={() => void run(async () => { if (!(await discardDraft())) return; setDraft({ id: '', title: 'New note', content: '', note_type: 'human', created: '', updated: '' }); setDirty(true); })}><Plus size={14}/></Button></div><div className="nb-scroll nb-stack">{notes.map(n => <Button key={n.id} aria-pressed={draft?.id === n.id} onClick={() => void run(async () => { if (!(await discardDraft())) return; setDraft(await client.request<NoteResponse>(`/notes/${recordId(n.id)}`)); setDirty(false); })}>{n.title || 'Untitled note'}</Button>)}{!notes.length && !draft && <p className="nb-muted">Write a note or save an answer from your conversation.</p>}{draft && <div className="nb-stack"><Field label="Title"><input className="nb-input" value={draft.title ?? ''} onChange={e => { setDraft({ ...draft, title: e.target.value }); setDirty(true); }}/></Field><Field label="Note"><textarea className="nb-input min-h-64" value={draft.content ?? ''} onChange={e => { setDraft({ ...draft, content: e.target.value }); setDirty(true); }}/></Field><div className="nb-tabs"><Button disabled={busy || !dirty} className="primary" onClick={() => void run(saveNote)}>Save</Button><Button disabled={busy} onClick={() => void run(() => exportText(draft.title || 'Note', draft.content || ''))}>Save to vault</Button>{draft.id && <Button disabled={busy} onClick={() => void run(async () => { if (!(await dialogs.confirm('Delete this notebook note?', { danger: true }))) return; await client.request(`/notes/${recordId(draft.id)}`, 'DELETE'); setDraft(null); setDirty(false); await refreshNotebook(); })}>Delete</Button>}</div></div>}</div></aside>
      </div>
    </>}
  </>;
}

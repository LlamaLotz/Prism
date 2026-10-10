import { FolderPicker } from './FolderPicker';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { documents, type ImportOptions, type ImportSummary, type ImportPreview, type PreviewOutput, type DocumentSource } from '../services/documents';
import { knowledge } from '../services/knowledge';
import './runtime.css';

const Context = createContext({ imports: [] as ImportSummary[], review: (_id: string) => {}, source: (_blockId: string) => {}, note: (_path: string) => {} });
export const useDocumentImports = () => useContext(Context);
/** Persists independently of the ingestion panel and collapsed navigation. */
export function DocumentImports({ children, onPublished, request, vaultPath, folders=[] }: { children: ReactNode; folders?:string[]; vaultPath?: string; onPublished: () => void; request?: {id:string;ts:number}|null }) {
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [block, setBlock] = useState<string | null>(null);
  useEffect(() => { if (request) setSelected(request.id); }, [request]);
  useEffect(() => {
    let alive = true;
    const refresh = async () => { try { const rows = await documents.list(); if (alive) setImports(rows); } catch { /* Runtime activity reports connection failures. */ } };
    const subscription = listen<{ kind?: string; type?: string }>('knowledge-event', () => void refresh());
    const timer = window.setInterval(refresh, 2000); void refresh();
    return () => { alive = false; clearInterval(timer); void subscription.then(stop => stop()).catch(() => {}); };
  }, []);
  return <Context.Provider value={{ imports, review: setSelected, source: setBlock, note: setNote }}>
    {children}
    {selected && <ImportReview folders={folders} vaultPath={vaultPath} key={selected} id={selected} state={imports.find(i => i.id === selected)?.state ?? 'review'} close={() => setSelected(null)} published={() => { setImports(rows => rows.filter(i => i.id !== selected)); onPublished(); }} />}
    {note && <NoteSources key={note} path={note} close={() => setNote(null)} choose={id => { setNote(null); setBlock(id); }} />}
    {block && <SourceDetails key={block} blockId={block} close={() => setBlock(null)} review={id => { setBlock(null); setSelected(id); }} />}
  </Context.Provider>;
}
function useModal(close: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal(); ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { ref.current?.close(); previous?.focus(); };
  }, []);
  return { ref, onCancel: (e: React.SyntheticEvent) => { e.preventDefault(); close(); }, onKeyDown: (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== 'Tab') return;
    const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,a[href]')).filter(el => el.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  } };
}
function OutputPreview({ output, id, index }: { output: PreviewOutput; id: string; index: number }) {
  const [part, setPart] = useState(0), [text, setText] = useState(output.markdown), [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async (next: number) => { setBusy(true); try { const page = await documents.preview(id, index, 1, next); setText(page.outputs[0]?.markdown ?? ''); setPart(next); setError(''); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  return <details className="document-output" open={index === 0}>
    <summary>{output.name}{output.conflict ? ' — conflict' : ''}</summary>
    <p>{output.path}</p>
    {output.conflict && <p className="runtime-error" role="alert">{output.conflict}</p>}
    <pre tabIndex={0} aria-label={`Markdown preview: ${output.name}`}>{text || '(Empty note)'}</pre>
    {output.totalChars > 8000 && <nav aria-label={`Preview pages: ${output.name}`} className="runtime-actions"><button className="runtime-button" disabled={busy || part === 0} onClick={() => void load(Math.max(0, part - 8000))}>Previous text</button><span>{part + 1}–{Math.min(part + 8000, output.totalChars)} of {output.totalChars} characters</span><button className="runtime-button" disabled={busy || part + 8000 >= output.totalChars} onClick={() => void load(part + 8000)}>Next text</button></nav>}
    {error && <p role="alert" className="runtime-error">{error}</p>}
  </details>;
}
export function ImportReview({folders=[], id, state, close, published, vaultPath }: { folders?:string[]; id: string; vaultPath?: string; state: string; close: () => void; published: () => void }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [options, setOptions] = useState<ImportOptions | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [stale, setStale] = useState(false);
  const [operation, setOperation] = useState<string | null>(null), [undone, setUndone] = useState(false);
  const modal = useModal(() => { if (!busy) close(); });
  useEffect(() => { let alive = true; void documents.preview(id).then(p => { if (alive) { setPreview(p); setOptions(p.options); } }).catch(e => { if (alive) setError(String(e)); }); return () => { alive = false; }; }, [id]);
  const change = (values: Partial<ImportOptions>) => { setOptions(o => o && ({ ...o, ...values })); setDirty(true); };
  const refresh = async () => { if (!options) return; setBusy(true); setError(''); try { await documents.update(id, options); const p = await documents.preview(id); setPreview(p); setOptions(p.options); setDirty(false); setStale(false); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const commit = async () => { if (!preview) return; setBusy(true); setError(''); try { const result = await documents.commit(id, preview.token); setOperation(result.operationId); if (vaultPath) window.dispatchEvent(new CustomEvent('study-import-published', {detail:{paths:result.paths,vault:vaultPath}})); published(); } catch (e) { setError(String(e)); setStale(true); } finally { setBusy(false); } };
  const page = async (offset: number) => { setBusy(true); try { setPreview(await documents.preview(id, offset)); setError(''); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  return <dialog {...modal} className="runtime-dialog runtime-surface document-dialog" aria-labelledby="document-review-title">
    <header className="runtime-heading"><h2 id="document-review-title">Review document import</h2><button className="runtime-button" disabled={busy} onClick={close} aria-label="Close import review">Close</button></header>
    <p>Extraction is staged. Notes are written only after you confirm this preview. Closing keeps the review in Jobs.</p>
    {error && <p className="runtime-error" role="alert">{error}</p>}
    {state === 'recovery_required' && <div className="runtime-local"><p>Publication was interrupted. Recovery versions are retained. Rollback checks every file first and stops if its state is ambiguous or changed.</p><button className="runtime-button" disabled={busy} onClick={async () => { setBusy(true); try { await documents.recover(id); published(); close(); } catch(e) { setError(String(e)); } finally { setBusy(false); } }}>Roll back interrupted import</button></div>}
    {!preview && !error && <p role="status">Loading preview…</p>}
    {preview && options && !operation && <>
      <fieldset className="runtime-settings document-options" disabled={busy || state !== 'review'}><legend>Output settings</legend>
        <label>Note name<input value={options.name} onChange={e => change({ name: e.target.value })} /></label>
        <FolderPicker folders={folders} value={options.folder} onChange={folder=>change({folder,requireExistingFolder:true})}/>
        <label>Split document<select value={options.splitLevel ?? ''} onChange={e => change({ splitLevel: e.target.value ? Number(e.target.value) : null })}><option value="">One note per source</option>{[2, 1, 3, 4, 5, 6].map(level => <option value={level} key={level}>Heading {level} (H{level})</option>)}</select></label>
        <label className="document-checkbox"><input type="checkbox" checked={options.keepSource} onChange={e => change({ keepSource: e.target.checked })} />Keep source in vault (immutable local copy)</label>
        <label className="document-checkbox"><input type="checkbox" checked={options.separateCopy} onChange={e => change({ separateCopy: e.target.checked })} />Import a separate copy with new filenames</label>
        <p>Splitting keeps introductory content and section links in a parent note. Edited, moved, deleted, or replaced generated notes cannot be overwritten. Choose a new name or folder for a separate copy.</p>
        <button className="runtime-button" onClick={() => void refresh()}>Refresh preview</button>
      </fieldset>
      {(dirty || stale || preview.needsRefresh) && <p role="status" className="runtime-error">Refresh the preview before confirming. Changes and restarts invalidate the previous approval.</p>}
      {preview.warnings.length > 0 && <details><summary>Extraction warnings ({preview.warnings.length})</summary><ul>{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
      {preview.retained.length > 0 && <details><summary>Previously generated notes retained ({preview.retainedTotal ?? preview.retained.length})</summary><ul>{preview.retained.map(path => <li key={path}>{path}</li>)}</ul></details>}
      <h3>Output outline · {preview.total} notes</h3>{preview.conflicts > 0 && <p className="runtime-error">{preview.conflicts} outputs have conflicts. Choose new destinations before confirming.</p>}
      {preview.outputs.map((output, index) => <div key={`${preview.token}:${output.path}`}><OutputPreview output={output} id={id} index={preview.offset + index} />{output.key !== 'root' && <button className="runtime-button" disabled={busy || options.excludedOutputs.includes(output.key)} onClick={() => change({ excludedOutputs: [...options.excludedOutputs, output.key] })}>Exclude {output.name}</button>}</div>)}
      {preview.skipped?.map(([key, name]) => <p key={key}>{name} — excluded <button className="runtime-button" disabled={busy} onClick={() => change({ excludedOutputs: options.excludedOutputs.filter(value => value !== key) })}>Include again</button></p>)}
      {Math.max(preview.total, preview.retainedTotal ?? 0, preview.skippedTotal ?? 0) > 100 && <nav className="runtime-actions" aria-label="Output pages"><button className="runtime-button" disabled={busy || preview.offset === 0} onClick={() => void page(Math.max(0, preview.offset - 100))}>Previous outputs</button><span>{preview.offset + 1}–{Math.min(preview.offset + 100, Math.max(preview.total, preview.retainedTotal ?? 0, preview.skippedTotal ?? 0))} of {Math.max(preview.total, preview.retainedTotal ?? 0, preview.skippedTotal ?? 0)}</span><button className="runtime-button" disabled={busy || preview.offset + 100 >= Math.max(preview.total, preview.retainedTotal ?? 0, preview.skippedTotal ?? 0)} onClick={() => void page(preview.offset + 100)}>Next outputs</button></nav>}
      <div className="runtime-actions"><button className="runtime-button" disabled={busy || state !== 'review'} onClick={async () => { setBusy(true); try { await knowledge.cancel(id); close(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}>Cancel import</button><button className="runtime-button runtime-primary" disabled={busy || state !== 'review' || dirty || stale || preview.needsRefresh || (preview.conflicts > 0 || preview.outputs.some(o => o.conflict)) || preview.total === 0} onClick={() => void commit()}>Confirm import · {preview.total} notes</button></div>
    </>}
    {operation && <div className="runtime-local"><p role="status">{undone ? 'Import undone.' : 'Notes imported. The complete import can be undone if its notes remain unchanged.'}</p>{!undone && <button className="runtime-button" disabled={busy} onClick={async () => { setBusy(true); try { await knowledge.agentUndoOperation(operation); setUndone(true); published(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}>Undo import</button>}</div>}
  </dialog>;
}
function SourceDetails({ blockId, close, review }: { blockId: string; close: () => void; review: (id:string) => void }) {
  const [source, setSource] = useState<DocumentSource | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const modal = useModal(close);
  useEffect(() => { let alive = true; void documents.source(blockId).then(s => { if (alive) setSource(s); }).catch(e => { if (alive) setError(String(e)); }); return () => { alive = false; }; }, [blockId]);
  return <dialog {...modal} className="runtime-dialog runtime-surface document-dialog" aria-labelledby="document-source-title"><header className="runtime-heading"><h2 id="document-source-title">Document source</h2><button className="runtime-button" onClick={close}>Close</button></header>
    {error && <p role="alert" className="runtime-error">{error}</p>}
    {source && <><dl className="runtime-details"><dt>Title</dt><dd>{source.title}</dd><dt>Original</dt><dd>{source.source}</dd><dt>Extractor</dt><dd>{source.extractor} · {source.extractorVersion}</dd><dt>Revision</dt><dd>{source.revision}</dd><dt>Location</dt><dd>{source.location ? Object.entries(source.location).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('–') : v}`).join(' · ') : 'Not supplied by the extractor'}</dd></dl>
      {source.modified && <p>This note block has changed since import. The excerpt below is the stored source version.</p>}
      <pre tabIndex={0}>{source.excerpt}</pre><p>{source.retained ? 'Retained original' : 'Original reference'} · {source.sourceStatus.replaceAll('_', ' ')}</p>
      <div className="runtime-actions">{source.sourceStatus === 'web_snapshot' && <button className="runtime-button" disabled={busy} onClick={async () => { setBusy(true); try { const p = await documents.prepare('url', source.source, 'yt-dlp', source.revision); review(p.id); } catch(e) { setError(String(e)); } finally { setBusy(false); } }}>Reuse saved revision</button>}
      <button className="runtime-button" disabled={busy || (!source.source.startsWith('http') && source.sourceStatus !== 'available')} onClick={async () => { setBusy(true); try { const p = await documents.prepare(source.sourceStatus === 'web_snapshot' ? 'url' : 'file', source.source); review(p.id); } catch(e) { setError(String(e)); } finally { setBusy(false); } }}>{source.sourceStatus === 'web_snapshot' ? 'Refresh source (privacy approval applies)' : 'Prepare reimport'}</button></div>
      <button className="runtime-button" disabled={source.sourceStatus !== 'available'} onClick={() => void documents.openSource(blockId).catch(e => setError(String(e)))}>Open original</button>
    </>}
  </dialog>;
}

export function DocumentSourcesButton({path}:{path:string}) { const {note}=useDocumentImports(); return <button className="runtime-button" title="Original document sources" onClick={() => note(path)}>Sources</button>; }
function NoteSources({path, close, choose}:{path:string;close:()=>void;choose:(id:string)=>void}) {
 const [page,setPage]=useState<Awaited<ReturnType<typeof documents.noteSources>>|null>(null),[error,setError]=useState('');
 const modal=useModal(close);
 useEffect(()=>{let alive=true;void documents.noteSources(path).then(p=>{if(alive)setPage(p);}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[path]);
 const load=async(offset:number)=>{try{setPage(await documents.noteSources(path,offset));setError('');}catch(e){setError(String(e));}};
 return <dialog {...modal} className="runtime-dialog runtime-surface document-dialog" aria-labelledby="note-sources-title"><header className="runtime-heading"><h2 id="note-sources-title">Original document sources</h2><button className="runtime-button" onClick={close}>Close</button></header>
 {error&&<p className="runtime-error" role="alert">{error}</p>}
 {page?.total===0&&<p>No original document provenance is recorded for this note. Existing notes are unchanged.</p>}
 {page?.entries.map(entry=><article className="runtime-job" key={entry.blockId}><p>Note line {entry.line} · {entry.excerpt}</p><button className="runtime-button" onClick={()=>choose(entry.blockId)}>Source details</button></article>)}
 {page&&page.total>100&&<nav className="runtime-actions"><button className="runtime-button" disabled={page.offset===0} onClick={()=>void load(Math.max(0,page.offset-100))}>Previous</button><button className="runtime-button" disabled={page.offset+100>=page.total} onClick={()=>void load(page.offset+100)}>Next</button></nav>}
 </dialog>;
}

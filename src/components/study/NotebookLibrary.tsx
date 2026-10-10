import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Grid2X2, Layers, Plus, Search, MoreHorizontal, ImagePlus } from 'lucide-react';
import type { Artifact, Collection } from '../../services/study';
import './notebook-library.css';

async function imageCover(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, or WebP image under 10 MB.');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('This image could not be read. Choose a valid PNG, JPEG, or WebP image.'); });
  try {
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('Image processing is unavailable.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/webp', .85);
    // WebKit may fall back to PNG when WebP encoding is unavailable.
    if (!/^data:image\/(webp|png);base64,/.test(data) || data.length > 2_800_000) throw new Error('This image is too large. Choose a smaller image.');
    return data;
  } finally { bitmap.close(); }
}
export function NotebookLibrary({ vaultPath, notebooks, materials, onOpen, onCreate, onRename, onDelete, onCover, busy = false }: {
  vaultPath: string; notebooks: Collection[]; materials: Artifact[]; onOpen: (id: string) => void; onCreate: () => void; onRename: (notebook: Collection) => Promise<void>; onDelete: (notebook: Collection) => Promise<void>; onCover: (notebook: Collection, cover: string) => Promise<void>; busy?: boolean;
}) {
  const [appearance, setAppearance] = useState(() => document.documentElement.className);
  useEffect(() => { const observer = new MutationObserver(() => setAppearance(document.documentElement.className)); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] }); return () => observer.disconnect(); }, []);
  const industrial = appearance.includes('theme-industrial');
  const archetype = industrial ? 'industrial' : appearance.includes('theme-gloss') ? 'gloss' : 'glass';
  const key = `prism.notebook.library:${vaultPath}:${archetype}`;
  const [coverFor, setCoverFor] = useState<Collection | null>(null);
  const [coverError, setCoverError] = useState('');
  const [savingCover, setSavingCover] = useState(false);
  const coverDialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = () => requestAnimationFrame(() => {
    const target = returnFocus.current;
    if (target?.isConnected && target.getClientRects().length) target.focus();
    else (track.current?.querySelector<HTMLElement>('[data-selected="true"] summary') ?? track.current?.querySelector<HTMLElement>('.notebook-cover__menu summary') ?? track.current?.querySelector<HTMLButtonElement>('.notebook-add-card'))?.focus();
  });
  const menuAction = async (target: HTMLElement, action: () => Promise<void>) => {
    returnFocus.current = target.closest('details')?.querySelector('summary') ?? null;
    try { await action(); } finally { restoreFocus(); }
  };
  useEffect(() => { if (coverFor) { setCoverError(''); coverDialog.current?.showModal(); return () => { coverDialog.current?.close(); restoreFocus(); }; } }, [coverFor]);
  const saveCover = async (value: string | File) => { if (!coverFor || savingCover) return; setSavingCover(true); setCoverError(''); try { await onCover(coverFor, typeof value === 'string' ? value : await imageCover(value)); setCoverFor(null); } catch (e) { setCoverError(String(e)); } finally { setSavingCover(false); } };
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState('cards');
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const closeMenus = (e: PointerEvent) => { if (!(e.target as Element).closest('.notebook-cover__menu')) track.current?.querySelectorAll('details[open]').forEach(menu => menu.removeAttribute('open')); };
    document.addEventListener('pointerdown', closeMenus);
    return () => document.removeEventListener('pointerdown', closeMenus);
  }, []);
  useEffect(() => { try { setMode(localStorage.getItem(key) || 'cards'); } catch { setMode('cards'); } }, [key]);
  const rows = notebooks.filter(n => n.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const index = selected === '__new__' ? rows.length : Math.max(0, rows.findIndex(n => n.id === selected));
  const active = rows[index];
  const select = (next: number) => { const i = Math.max(0, Math.min(rows.length, next)); setSelected(rows[i]?.id ?? '__new__'); };
  useEffect(() => { if (industrial && mode === 'cards') track.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' }); }, [selected, industrial, mode]);
  const changeMode = (value: string) => { setMode(value); try { localStorage.setItem(key, value); } catch { /* in-memory preference still works */ } };
  return <section className="notebook-library" aria-label="Notebook library">
    <header className="notebook-library__header"><div><span className="study-eyebrow">YOUR KNOWLEDGE, CONNECTED</span><h1>Notebooks</h1><p className="study-muted">A place for your sources, conversations, and study materials.</p></div></header>
    <div className="notebook-library__controls"><label className="notebook-search"><Search size={17}/><input aria-label="Search notebooks" placeholder="Search notebooks…" value={query} onChange={e => setQuery(e.target.value)}/></label><div aria-label="Library presentation"><button aria-pressed={mode === 'cards'} onClick={() => changeMode('cards')}><Layers size={16}/> Cards</button><button aria-pressed={mode === 'grid'} onClick={() => changeMode('grid')}><Grid2X2 size={16}/> Grid</button></div></div>
    {!rows.length && (query ? <p className="study-muted">No matching notebooks. Try a different title.</p> : <div className="study-empty"><h2>Start your first notebook</h2><p className="study-muted">Collect your notes and turn them into study materials.</p></div>)}
      <div ref={track} className={`notebook-covers notebook-covers--${mode}`} data-industrial={industrial} role="group" aria-label="Notebook covers" tabIndex={mode === 'cards' ? 0 : -1}
        onKeyDown={e => { if (mode !== 'cards' || e.target !== e.currentTarget) return; if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); select(index + (e.key === 'ArrowRight' ? 1 : -1)); } if (e.key === 'Enter' && e.target === e.currentTarget) active ? onOpen(active.id) : onCreate(); }}
        onPointerDown={e => { if ((e.target as HTMLElement).closest('details')) return; if (mode === 'cards') drag.current = { x: e.clientX, y: e.clientY, moved: false }; }}
        onPointerMove={e => { if (!drag.current) return; if (Math.abs(e.clientX - drag.current.x) > 12 && Math.abs(e.clientX - drag.current.x) > Math.abs(e.clientY - drag.current.y)) drag.current.moved = true; }}
        onPointerUp={e => { const start = drag.current; if (start?.moved) { select(index + Math.round((start.x - e.clientX) / 120 || (start.x > e.clientX ? 1 : -1))); e.preventDefault(); } setTimeout(() => { drag.current = null; }, 0); }} onPointerCancel={() => { drag.current = null; }}>
        {rows.map((notebook, i) => { const distance = i - index; const count = materials.filter(a => a.collectionId === notebook.id).length; const cover = notebook.cover ?? 'accent'; return <article key={notebook.id} className="notebook-cover" data-selected={i === index} style={{ '--cover-distance': distance, '--cover-depth': Math.abs(distance), zIndex: rows.length + 1 - Math.abs(distance) } as CSSProperties}>
          <button className="notebook-cover__open" tabIndex={mode === 'grid' || i === index ? 0 : -1} aria-label={`${notebook.title}, ${notebook.sourceIds.length} sources, ${count} materials`} onClick={() => { if (drag.current?.moved) return; if (mode === 'grid' || i === index) onOpen(notebook.id); else setSelected(notebook.id); }}>
            <span className="notebook-cover__art" data-cover={cover.startsWith('data:') ? 'image' : cover} aria-hidden="true">{/^data:image\/(webp|png);base64,/.test(cover) ? <img src={cover} alt=""/> : <BookOpen size={40}/>}<span className="notebook-cover__number">{String(i + 1).padStart(2, '0')}</span></span><span className="notebook-cover__caption"><strong>{notebook.title}</strong><small>{notebook.sourceIds.length} sources · {count} materials</small></span>
          </button>
          <details className="study-menu notebook-cover__menu" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onToggle={e => { if (e.currentTarget.open) { setSelected(notebook.id); track.current?.querySelectorAll('details[open]').forEach(menu => { if (menu !== e.currentTarget) menu.removeAttribute('open'); }); } }}>
            <summary aria-label={`Options for ${notebook.title}`} tabIndex={mode === 'grid' || i === index ? 0 : -1}><MoreHorizontal size={20}/></summary>
            <div className="study-menu-body" onClick={e => { if ((e.target as HTMLElement).closest('button')) e.currentTarget.parentElement?.removeAttribute('open'); }}>
              <button disabled={busy} onClick={e => void menuAction(e.currentTarget, () => onRename(notebook))}>Rename</button>
              <button disabled={busy} onClick={e => { returnFocus.current = e.currentTarget.closest('details')?.querySelector('summary') ?? null; setCoverFor(notebook); }}>Choose cover image</button>
              <button disabled={busy} onClick={e => void menuAction(e.currentTarget, () => onDelete(notebook))}>Delete notebook</button>
            </div>
          </details>
        </article>; })}
        <button className="notebook-add-card" disabled={busy} data-selected={index === rows.length} style={{ '--cover-distance': rows.length - index, '--cover-depth': Math.abs(rows.length - index), zIndex: index === rows.length ? rows.length + 2 : 0 } as CSSProperties} tabIndex={mode === 'grid' || index === rows.length ? 0 : -1} onClick={() => { if (drag.current?.moved) return; if (mode === 'grid' || index === rows.length) onCreate(); else select(rows.length); }}><Plus size={32}/><strong>Add notebook</strong><span>A new place for your ideas</span></button>
      </div>
      {mode === 'cards' && <footer className="notebook-library__caption"><button aria-label="Previous notebook" disabled={index === 0} onClick={() => select(index - 1)}><ArrowLeft size={18}/></button><div><h2>{active?.title ?? 'Add notebook'}</h2><p className="study-muted">{active ? `${active.sourceIds.length} sources · ${materials.filter(a => a.collectionId === active.id).length} materials` : 'Collect sources and start something new.'}</p>{active && <button onClick={() => onOpen(active.id)}>Open notebook <ArrowRight size={15}/></button>}</div><button aria-label="Next notebook" disabled={index === rows.length} onClick={() => select(index + 1)}><ArrowRight size={18}/></button></footer>}
      <dialog ref={coverDialog} className="study-generation-dialog notebook-cover-dialog" aria-labelledby="notebook-cover-title" onCancel={e => { if (savingCover) e.preventDefault(); else setCoverFor(null); }}>
        <h2 id="notebook-cover-title">Notebook cover</h2><p className="study-muted">Choose a colour or an image for {coverFor?.title}.</p>
        <div className="notebook-cover-choices">{['accent', 'black', 'grey'].map(value => <button key={value} disabled={savingCover} aria-pressed={(coverFor?.cover ?? 'accent') === value} data-cover={value} onClick={() => void saveCover(value)}>{value === 'accent' ? 'Accent colour' : value === 'black' ? 'Black' : 'Grey'}</button>)}</div>
        <label className="study-field"><span><ImagePlus size={16}/> Choose image</span><input type="file" aria-label="Cover image" accept="image/png,image/jpeg,image/webp" disabled={savingCover} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void saveCover(file); }}/></label>
        <p className="study-muted">PNG, JPEG or WebP, up to 10 MB. Saved locally with this notebook.</p>
        {coverError && <p role="alert">{coverError}</p>}{savingCover && <p role="status">Saving cover…</p>}
        <button disabled={savingCover} onClick={() => setCoverFor(null)}>Cancel</button>
      </dialog>
  </section>;
}

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Grid2X2, Layers, Plus, Search } from 'lucide-react';
import type { Artifact, Collection } from '../../services/study';
import './notebook-library.css';

/** Collections remain the storage identity; covers are local, deterministic artwork. */
function coverHue(id: string) { return [...id].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0, 17) % 360; }
export function NotebookLibrary({ vaultPath, notebooks, materials, onOpen, onCreate }: {
  vaultPath: string; notebooks: Collection[]; materials: Artifact[]; onOpen: (id: string) => void; onCreate: () => void;
}) {
  const [appearance, setAppearance] = useState(() => document.documentElement.className);
  useEffect(() => { const observer = new MutationObserver(() => setAppearance(document.documentElement.className)); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] }); return () => observer.disconnect(); }, []);
  const industrial = appearance.includes('theme-industrial');
  const archetype = industrial ? 'industrial' : appearance.includes('theme-gloss') ? 'gloss' : 'glass';
  const key = `prism.notebook.library:${vaultPath}:${archetype}`;
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState('cards');
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => { try { setMode(localStorage.getItem(key) || 'cards'); } catch { setMode('cards'); } }, [key]);
  const rows = notebooks.filter(n => n.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const index = Math.max(0, rows.findIndex(n => n.id === selected));
  const active = rows[index];
  const select = (next: number) => { if (rows.length) setSelected(rows[Math.max(0, Math.min(rows.length - 1, next))].id); };
  useEffect(() => { if (industrial && mode === 'cards') track.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' }); }, [selected, industrial, mode]);
  const changeMode = (value: string) => { setMode(value); try { localStorage.setItem(key, value); } catch { /* in-memory preference still works */ } };
  return <section className="notebook-library" aria-label="Notebook library">
    <header className="notebook-library__header"><div><span className="study-eyebrow">YOUR KNOWLEDGE, CONNECTED</span><h1>Notebooks</h1><p className="study-muted">A place for your sources, conversations, and study materials.</p></div><button onClick={onCreate}><Plus size={17}/> New notebook</button></header>
    <div className="notebook-library__controls"><label className="notebook-search"><Search size={17}/><input aria-label="Search notebooks" placeholder="Search notebooks…" value={query} onChange={e => setQuery(e.target.value)}/></label><div aria-label="Library presentation"><button aria-pressed={mode === 'cards'} onClick={() => changeMode('cards')}><Layers size={16}/> Cards</button><button aria-pressed={mode === 'grid'} onClick={() => changeMode('grid')}><Grid2X2 size={16}/> Grid</button></div></div>
    {!rows.length ? <div className="study-empty"><BookOpen size={40}/><h2>{query ? 'No matching notebooks' : 'Start your first notebook'}</h2><p>{query ? 'Try a different title.' : 'Collect your notes and turn them into study materials.'}</p>{!query && <button onClick={onCreate}>Create notebook</button>}</div> : <>
      <div ref={track} className={`notebook-covers notebook-covers--${mode}`} data-industrial={industrial} role="group" aria-label="Notebook covers" tabIndex={mode === 'cards' ? 0 : -1}
        onKeyDown={e => { if (mode !== 'cards' || (e.target as HTMLElement).tagName === 'INPUT') return; if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); select(index + (e.key === 'ArrowRight' ? 1 : -1)); } if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(active.id); }}
        onPointerDown={e => { if (mode === 'cards') drag.current = { x: e.clientX, y: e.clientY, moved: false }; }}
        onPointerMove={e => { if (!drag.current) return; if (Math.abs(e.clientX - drag.current.x) > 12 && Math.abs(e.clientX - drag.current.x) > Math.abs(e.clientY - drag.current.y)) drag.current.moved = true; }}
        onPointerUp={e => { const start = drag.current; if (start?.moved) { select(index + Math.round((start.x - e.clientX) / 120 || (start.x > e.clientX ? 1 : -1))); e.preventDefault(); } setTimeout(() => { drag.current = null; }, 0); }} onPointerCancel={() => { drag.current = null; }}>
        {rows.map((notebook, i) => { const distance = i - index; const count = materials.filter(a => a.collectionId === notebook.id).length; return <button key={notebook.id} className="notebook-cover" data-selected={i === index} tabIndex={mode === 'grid' || i === index ? 0 : -1} aria-label={`${notebook.title}, ${notebook.sourceIds.length} sources, ${count} materials`} style={{ '--cover-hue': coverHue(notebook.id), '--cover-distance': distance, '--cover-depth': Math.abs(distance), zIndex: rows.length - Math.abs(distance) } as CSSProperties} onClick={() => { if (drag.current?.moved) return; if (mode === 'grid' || i === index) onOpen(notebook.id); else setSelected(notebook.id); }}>
          <span className="notebook-cover__art" aria-hidden="true"><span className="notebook-cover__orbit"/><BookOpen size={40}/><span className="notebook-cover__number">{String(i + 1).padStart(2, '0')}</span></span><span className="notebook-cover__caption"><strong>{notebook.title}</strong><small>{notebook.sourceIds.length} sources · {count} materials</small></span>
        </button>; })}
      </div>
      {mode === 'cards' && <footer className="notebook-library__caption"><button aria-label="Previous notebook" disabled={index === 0} onClick={() => select(index - 1)}><ArrowLeft size={18}/></button><div><h2>{active.title}</h2><p className="study-muted">{active.sourceIds.length} sources · {materials.filter(a => a.collectionId === active.id).length} materials</p><button onClick={() => onOpen(active.id)}>Open notebook <ArrowRight size={15}/></button></div><button aria-label="Next notebook" disabled={index === rows.length - 1} onClick={() => select(index + 1)}><ArrowRight size={18}/></button></footer>}
    </>}
  </section>;
}

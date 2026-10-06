import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Columns3, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

export type StudyPane = 'sources' | 'chat' | 'tools';
const panes: StudyPane[] = ['sources', 'chat', 'tools'];
const labels = { sources: 'Sources', chat: 'Chat', tools: 'Tools' };
const minimum = { sources: 240, chat: 320, tools: 300 };
interface Layout { widths: number[]; collapsed: StudyPane[] }
const defaults: Layout = { widths: [24, 40, 36], collapsed: [] };
export function StudyPanels({ vaultPath, active, onActive, revealRevision, sources, chat, tools }: {
  revealRevision: number; vaultPath: string; active: StudyPane; onActive: (pane: StudyPane) => void;
  sources: ReactNode; chat: ReactNode; tools: ReactNode;
}) {
  const key = `prism_study_layout:${vaultPath}`;
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (saved?.widths?.length === 3 && saved.widths.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0) && Array.isArray(saved.collapsed)) {
        return { widths: saved.widths, collapsed: [...new Set<StudyPane>(saved.collapsed.filter((p: StudyPane) => panes.includes(p)))].slice(0, 2) };
      }
    } catch { /* Use the default layout if storage is unavailable. */ }
    return defaults;
  });
  const [expanded, setExpanded] = useState<StudyPane | null>(null);
  const [width, setWidth] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef<Partial<Record<StudyPane, HTMLButtonElement | null>>>({});
  const narrow = width > 0 && width < 960;
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(layout)); } catch { /* Session layout still works. */ } }, [key, layout]);
  const revealed = useRef({active, revealRevision});
  useEffect(() => { if(revealed.current.active===active&&revealed.current.revealRevision===revealRevision)return;revealed.current={active,revealRevision};setExpanded(null);setLayout(l=>({...l,collapsed:l.collapsed.filter(p=>p!==active)})); },[active,revealRevision]);
  const visible = panes.filter(p => !layout.collapsed.includes(p));
  const resize = (left: StudyPane, right: StudyPane, delta: number) => {
    const leftElement = root.current?.querySelector<HTMLElement>(`[data-panel="${left}"]`);
    const rightElement = root.current?.querySelector<HTMLElement>(`[data-panel="${right}"]`);
    if (!leftElement || !rightElement) return;
    const a = leftElement.getBoundingClientRect().width, b = rightElement.getBoundingClientRect().width;
    const next = Math.max(minimum[left], Math.min(a + b - minimum[right], a + delta));
    setLayout(l => { const widths = [...l.widths], i = panes.indexOf(left), j = panes.indexOf(right), sum = widths[i] + widths[j]; widths[i] = sum * next / (a + b); widths[j] = sum - widths[i]; return { ...l, widths }; });
  };
  const content = { sources, chat, tools };
  return <div ref={root} className="study-layout" data-narrow={narrow}>
    <nav className="study-area-tabs" aria-label="Notebook areas" hidden={!narrow}>{panes.map(p => <button key={p} aria-pressed={active === p} onClick={() => onActive(p)}>{labels[p]}</button>)}</nav>
    <div className="study-panes" onKeyDown={event => { if (event.key === 'Escape' && expanded && !(event.target as HTMLElement).closest('dialog')) { const previous = expanded; setExpanded(null); buttons.current[previous]?.focus(); } }}>
      {panes.map(p => {
        const collapsed = layout.collapsed.includes(p);
        const hidden = narrow ? active !== p : !!expanded && expanded !== p;
        const next = visible[visible.indexOf(p) + 1];
        return <div key={p} className="study-panel-group" hidden={hidden} style={{ flex: collapsed && !narrow && !expanded ? '0 0 44px' : `${layout.widths[panes.indexOf(p)]} 1 0`, minWidth: narrow || expanded || collapsed ? 0 : minimum[p] }}>
          <section className="study-panel" data-panel={p} data-collapsed={collapsed && !narrow && !expanded} aria-label={labels[p]}>
            <button className="study-panel-rail" aria-label={`Expand ${labels[p]}`} onClick={() => { setLayout(l => ({ ...l, collapsed: l.collapsed.filter(v => v !== p) })); requestAnimationFrame(() => buttons.current[p]?.focus()); }}><PanelLeftOpen size={17}/><span>{labels[p]}</span></button>
            <header className="study-panel-header"><h2>{labels[p]}</h2><div className="study-panel-actions">
              {!narrow && <><button ref={el => { buttons.current[p] = el; }} aria-label={`${expanded === p ? 'Restore' : 'Maximize'} ${labels[p]}`} title={`${expanded === p ? 'Restore' : 'Maximize'} ${labels[p]}`} onClick={() => setExpanded(v => v === p ? null : p)}>{expanded === p ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button>
              <button aria-label={`Collapse ${labels[p]}`} title={`Collapse ${labels[p]}`} disabled={visible.length === 1 || !!expanded} onClick={() => { setLayout(l => ({ ...l, collapsed: [...l.collapsed, p] })); requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-panel="${p}"] .study-panel-rail`)?.focus()); }}><PanelLeftClose size={16}/></button></>}
            </div></header>
            <div className="study-panel-content">{content[p]}</div>
          </section>
          {!narrow && !expanded && !collapsed && next && <div role="separator" tabIndex={0} aria-label={`Resize ${labels[p]} and ${labels[next]}`} aria-orientation="vertical" aria-valuemin={minimum[p]} aria-valuenow={Math.round(width * layout.widths[panes.indexOf(p)] / 100)} className="study-divider"
            onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(p, next, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10)); } }}
            onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.x = String(event.clientX); }}
            onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { resize(p, next, event.clientX - Number(event.currentTarget.dataset.x)); event.currentTarget.dataset.x = String(event.clientX); } }}
            onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />}
        </div>;
      })}
    </div>
    {layout.collapsed.length > 0 && !narrow && <button className="study-reset-layout" onClick={() => { setExpanded(null); setLayout(defaults); }}><Columns3 size={13}/> Reset layout</button>}
  </div>;
}

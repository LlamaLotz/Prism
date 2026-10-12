import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Columns2, Rows2, X } from 'lucide-react';
import { ResizeHandle } from './ResizeHandle';
import './note-graph-workspace.css';

export type Arrangement = 'side-by-side' | 'stacked';
interface Preferences { arrangement: Arrangement; ratios: Record<Arrangement, number> }
export const NOTE_GRAPH_LAYOUT_KEY = 'prism_note_graph_layout';
export function readWorkspacePreferences(raw: string | null): Preferences {
  const defaults: Preferences = { arrangement: 'side-by-side', ratios: { 'side-by-side': 0.5, stacked: 0.5 } };
  try {
    const value = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object') return defaults;
    if (value.arrangement === 'stacked') defaults.arrangement = 'stacked';
    for (const key of ['side-by-side', 'stacked'] as const) {
      const ratio = value.ratios?.[key];
      if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 && ratio < 1) defaults.ratios[key] = ratio;
    }
  } catch { /* Invalid or unavailable storage uses the default layout. */ }
  return defaults;
}

export function NoteGraphWorkspace({ editor, graph, showEditor, showGraph, onClose }: {
  editor: ReactNode; graph: ReactNode; showEditor: boolean; showGraph: boolean;
  onClose: (pane: 'editor' | 'graph') => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [preferences, setPreferences] = useState(() => {
    try { return readWorkspacePreferences(localStorage.getItem(NOTE_GRAPH_LAYOUT_KEY)); }
    catch { return readWorkspacePreferences(null); }
  });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const split = showEditor && showGraph;
  const stacked = preferences.arrangement === 'stacked';
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const available = Math.max(0, (stacked ? size.height : size.width) - 12);
  const minimum = Math.min(stacked ? 160 : 240, available / 2);
  const first = Math.max(minimum, Math.min(available - minimum, available * preferences.ratios[preferences.arrangement]));
  const save = (next: Preferences) => {
    setPreferences(next);
    try { localStorage.setItem(NOTE_GRAPH_LAYOUT_KEY, JSON.stringify(next)); } catch { /* Layout still works without persistence. */ }
  };
  const resized = (value: number): Preferences => ({ ...preferences, ratios: { ...preferences.ratios, [preferences.arrangement]: available ? value / available : 0.5 } });
  const reset = () => save({ ...preferences, ratios: { ...preferences.ratios, [preferences.arrangement]: 0.5 } });
  return <div ref={root} className="note-graph-workspace" hidden={!showEditor && !showGraph}
    data-arrangement={preferences.arrangement} data-split={split || undefined} data-resizing={dragging || undefined}>
    <section key="editor" className="workspace-pane" data-workspace-pane="editor" aria-label="Note pane" tabIndex={-1} hidden={!showEditor}
      style={{ flex: split ? `0 0 ${first}px` : '1 1 0' }}>
      {split && <div className="workspace-pane-controls">
        <button type="button" aria-label={stacked ? 'Arrange side by side' : 'Stack note and graph'} title={stacked ? 'Arrange side by side' : 'Stack note and graph'}
          onClick={() => save({ ...preferences, arrangement: stacked ? 'side-by-side' : 'stacked' })}>{stacked ? <Columns2 size={15}/> : <Rows2 size={15}/>}</button>
        <button type="button" aria-label="Close note pane" title="Close note pane" onClick={() => onClose('editor')}><X size={15}/></button>
      </div>}
      <div className="workspace-pane-content">{editor}</div>
    </section>
    {split && <ResizeHandle direction={stacked ? 'vertical' : 'horizontal'} label="Resize note and graph" value={first} min={minimum} max={available - minimum}
      onResize={() => {}} onValueChange={value => { if (value !== first && available > minimum * 2) setPreferences(resized(value)); }} onResizeStart={() => setDragging(true)}
      onResizeEnd={(value, changed) => { setDragging(false); if (changed && available > minimum * 2) save(resized(value)); }} onReset={reset} />}
    <section key="graph" className="workspace-pane" data-workspace-pane="graph" aria-label="Graph pane" tabIndex={-1} hidden={!showGraph} style={{ flex: '1 1 0' }}>
      {split && <div className="workspace-pane-controls"><button type="button" aria-label="Close graph pane" title="Close graph pane" onClick={() => onClose('graph')}><X size={15}/></button></div>}
      <div className="workspace-pane-content">{graph}</div>
    </section>
  </div>;
}

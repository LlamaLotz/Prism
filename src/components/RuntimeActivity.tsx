import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Activity, X } from 'lucide-react';
import { knowledge, type CloudApproval, type KnowledgeJob } from '../services/knowledge';
import './runtime.css';

const ActivityContext = createContext({ count: 0, open: false, toggle: (_button: HTMLButtonElement) => {} });
export function JobsButton() {
  const { count, open, toggle } = useContext(ActivityContext);
  return <button type="button" className="runtime-trigger" aria-label={`Jobs${count ? ` (${count})` : ''}`} title="Jobs" aria-expanded={open} aria-controls="runtime-jobs" onClick={e => toggle(e.currentTarget)}>
    <Activity size={16} aria-hidden="true" />{count > 0 && <span className="runtime-count">{count > 99 ? '99+' : count}</span>}
  </button>;
}
const taskLabel = (value: string) => ({ EMBED: 'Embeddings', INDEX: 'Indexing', CHAT: 'Chat', EXTRACT: 'Extraction', NOTEBOOK: 'Notebook' }[value.toUpperCase()] ?? value.replaceAll('_', ' ').toLowerCase());

/** The controller stays mounted even when navigation collapses. */
export function RuntimeActivity({ children }: { children?: ReactNode }) {
  const [approvals, setApprovals] = useState<CloudApproval[]>([]);
  const [jobs, setJobs] = useState<KnowledgeJob[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [approvalError, setApprovalError] = useState('');
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 70 });
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const deny = useRef<HTMLButtonElement>(null);
  const approval = approvals[0];
  const active = jobs.filter(j => ['queued', 'running', 'waiting_for_approval'].includes(j.state));
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try { const [a, j] = await Promise.all([knowledge.approvals(), knowledge.jobs()]); if (alive) { setApprovals(a); setJobs(j); setLoadError(''); } }
      catch { if (alive) setLoadError('Unable to refresh activity. Retrying…'); }
    };
    const subscription = listen('knowledge-event', refresh);
    const timer = window.setInterval(refresh, 2000);
    void refresh();
    return () => { alive = false; clearInterval(timer); void subscription.then(stop => stop()).catch(() => {}); };
  }, []);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const place = () => { const rect = trigger.current?.getBoundingClientRect(); setPosition({ left: Math.max(8, Math.min(rect?.left ?? 12, window.innerWidth - 368)), top: Math.min((rect?.bottom ?? 54) + 8, window.innerHeight - 150) }); };
    place(); panel.current?.focus();
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node) && !dialog.current?.open) setOpen(false); };
    window.addEventListener('resize', place); document.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('pointerdown', outside); };
  }, [open]);
  useEffect(() => {
    if (!approval) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal(); deny.current?.focus(); setApprovalError('');
    return () => { dialog.current?.close(); previous?.focus(); };
  }, [approval?.id]);
  const resolve = async (approved: boolean) => {
    if (!approval || busy) return;
    setBusy(true); setApprovalError('');
    try { await knowledge.approve(approval.id, approved); setApprovals(a => a.filter(x => x.id !== approval.id)); }
    catch (e) { setApprovalError(String(e)); }
    finally { setBusy(false); }
  };
  return <ActivityContext.Provider value={{ count: active.length, open, toggle: button => { trigger.current = button; setOpen(value => !value); } }}>
    {children}
    {open && <aside id="runtime-jobs" ref={panel} tabIndex={-1} aria-label="Background jobs" className="runtime-panel runtime-surface" style={{ ...position, maxHeight: `min(560px, calc(100dvh - ${position.top + 12}px))` }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
      <header className="runtime-heading"><div><h2>Background jobs</h2><p>{active.length ? `${active.length} active` : 'All caught up'}</p></div><button className="runtime-button" aria-label="Close jobs" onClick={close}><X size={16}/></button></header>
      {jobs.length === 0 && <p className="runtime-empty">No recent jobs. Indexing and AI activity will appear here.</p>}
      {jobs.map(job => <article className="runtime-job" key={job.id}>
        <div className="runtime-heading"><strong>{taskLabel(job.kind)}</strong><span className="runtime-state">{job.state.replaceAll('_', ' ')}</span></div>
        <progress aria-label={`${job.kind} progress`} max={1} value={job.progress} />
        {job.error && <p className="runtime-error">{job.error}</p>}
        {active.includes(job) && <button className="runtime-button" onClick={async () => { try { await knowledge.cancel(job.id); setJobs(await knowledge.jobs()); } catch(e) { setError(String(e)); } }}>Cancel</button>}
      </article>)}
      {(error || loadError) && <p role="alert" className="runtime-error">{error || loadError}</p>}
    </aside>}
    {approval && <dialog ref={dialog} aria-modal="true" aria-labelledby="cloud-title" aria-describedby="cloud-scope" className="runtime-dialog runtime-surface" onKeyDown={e => {
      if (e.key !== 'Tab') return;
      const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }} onCancel={e => { e.preventDefault(); void resolve(false); }}>
      <h2 id="cloud-title">Allow external processing?</h2>
      <dl className="runtime-details"><dt>Destination</dt><dd>{approval.destination}</dd><dt>Task</dt><dd>{taskLabel(approval.task)}</dd><dt>Content scope</dt><dd id="cloud-scope">{approval.scope}</dd></dl>
      <p>This approval applies only to this request. Your configured provider may process its content outside this device.</p>
      <div className="runtime-actions"><button ref={deny} className="runtime-button" disabled={busy} onClick={() => void resolve(false)}>Deny</button><button className="runtime-button runtime-primary" disabled={busy} onClick={() => void resolve(true)}>Allow this request</button></div>
      {approvalError && <p role="alert" className="runtime-error">{approvalError}</p>}
    </dialog>}
  </ActivityContext.Provider>;
}

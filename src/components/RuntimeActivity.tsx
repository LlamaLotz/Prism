import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { knowledge, type CloudApproval, type KnowledgeJob } from '../services/knowledge';

/** Always mounted: background Notebook requests also need visible consent. */
export function RuntimeActivity() {
  const [approvals, setApprovals] = useState<CloudApproval[]>([]);
  const [jobs, setJobs] = useState<KnowledgeJob[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const refresh = async () => {
      try { const [a, j] = await Promise.all([knowledge.approvals(), knowledge.jobs()]); if (alive.current) { setApprovals(a); setJobs(j); } }
      catch { if (alive.current) { setApprovals([]); setJobs([]); } }
    };
    const subscription = listen('knowledge-event', refresh);
    const timer = window.setInterval(refresh, 2000);
    void refresh();
    return () => { alive.current = false; clearInterval(timer); void subscription.then(stop => stop()); };
  }, []);
  const active = jobs.filter(j => ['queued', 'running', 'waiting_for_approval'].includes(j.state));
  const approval = approvals[0];
  return <>
    {(jobs.length > 0 || approvals.length > 0) && <button className="fixed bottom-3 right-3 z-[60] rounded border border-slate-600 bg-slate-900 px-3 py-2 text-xs text-white" onClick={() => setOpen(!open)}>Jobs {active.length ? `(${active.length})` : ''}</button>}
    {open && <aside aria-label="Background jobs" className="fixed bottom-14 right-3 z-[60] max-h-80 w-80 overflow-auto rounded border border-slate-600 bg-slate-900 p-3 text-sm text-white">
      <h2 className="mb-2 font-semibold">Background jobs</h2>
      {jobs.map(job => <div className="border-t border-slate-700 py-2" key={job.id}>
        <div>{job.kind} · {job.state.replaceAll('_', ' ')}</div>
        <progress aria-label={`${job.kind} progress`} max={1} value={job.progress} className="w-full" />
        {job.error && <p className="text-xs text-amber-200">{job.error}</p>}
        {active.includes(job) && <button className="underline" onClick={() => void knowledge.cancel(job.id).catch(e => setError(String(e)))}>Cancel</button>}
      </div>)}
      {error && <p role="alert">{error}</p>}
    </aside>}
    {approval && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby="cloud-title" className="w-full max-w-lg rounded-xl border border-slate-600 bg-slate-900 p-6 text-white shadow-xl">
        <h2 id="cloud-title" className="text-lg font-semibold">Allow external processing?</h2>
        <p className="mt-3 break-all">Destination: {approval.destination}</p>
        <p>Task: {approval.task}</p><p>{approval.scope}</p>
        <p className="mt-3 text-sm text-slate-300">This approval applies only to this request. Your configured provider may process its content outside this device.</p>
        <div className="mt-5 flex justify-end gap-3">{[false, true].map(approved => <button key={String(approved)} autoFocus={!approved} className="rounded border border-slate-500 px-4 py-2" onClick={() => void knowledge.approve(approval.id, approved).then(() => setApprovals(a => a.filter(x => x.id !== approval.id))).catch(e => setError(String(e)))}>{approved ? 'Allow this request' : 'Deny'}</button>)}</div>
        {error && <p role="alert">{error}</p>}
      </section>
    </div>}
  </>;
}

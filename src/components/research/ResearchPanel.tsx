import { useEffect, useRef, useState } from 'react';
import type { Collection } from '../../services/study';
import { knowledge, type CloudApproval } from '../../services/knowledge';
import { researchRuntime, type ResearchPreview } from '../../services/researchRuntime';
import type { ResearchCandidate, ResearchDepth } from '../../types';
import { CandidateCard } from './CandidateCard';
import './research.css';

export interface ResearchPanelProps {
  vaultPath: string;
  /** Fixed destination (Notebook collection). */
  collectionId?: string | null;
  /** When provided, the panel lets the user choose the destination notebook. */
  collections?: Collection[];
  initialQuery?: string;
  initialDepth?: ResearchDepth;
  includeWebDefault?: boolean;
  useSourcesDefault?: boolean;
  /** Sidebar runs start as soon as the panel opens. */
  autoStart?: boolean;
  onClose?: () => void;
  onAdded?: (collection: Collection) => void | Promise<void>;
}

const PHASE_LABELS: Record<string, string> = {
  planning: 'Planning sources',
  searching: 'Searching',
  reading: 'Reading pages',
  'reading pages': 'Reading pages',
  dedupe: 'Checking duplicates',
  deduping: 'Checking duplicates',
  'checking duplicates': 'Checking duplicates',
  duplicates: 'Checking duplicates',
  ranking: 'Ranking results',
  scoring: 'Ranking results',
  done: 'Done',
  complete: 'Done',
  completed: 'Done',
};

export function phaseLabel(phase: string): string {
  const key = String(phase ?? '').trim().toLowerCase();
  return PHASE_LABELS[key] ?? (key ? key.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');
}

function percent(progress: number): number {
  const value = Number.isFinite(progress) ? progress : 0;
  return Math.max(0, Math.min(100, Math.round(value <= 1 ? value * 100 : value)));
}

function errorDetail(error: unknown): string {
  const raw = String((error as { message?: string })?.message ?? error ?? '');
  return raw.replace(/^[A-Z_]+:\s*/, '').slice(0, 240);
}

export function ResearchPanel({
  vaultPath,
  collectionId,
  collections,
  initialQuery = '',
  initialDepth = 'discover',
  includeWebDefault = true,
  useSourcesDefault = false,
  autoStart = false,
  onClose,
  onAdded,
}: ResearchPanelProps) {
  const [topic, setTopic] = useState(initialQuery);
  const [includeWeb, setIncludeWeb] = useState(includeWebDefault);
  const [useSources, setUseSources] = useState(useSourcesDefault);
  const [depth] = useState<ResearchDepth>(initialDepth);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<{ phase: string; progress: number } | null>(null);
  const [candidates, setCandidates] = useState<ResearchCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [destination, setDestination] = useState(collectionId ?? '');
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [deepUnavailable, setDeepUnavailable] = useState(false);
  const [preview, setPreview] = useState<ResearchPreview | null>(null);
  const [approvals, setApprovals] = useState<CloudApproval[]>([]);
  const previewDialog = useRef<HTMLDialogElement>(null);
  const previewClose = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const runToken = useRef(0);
  const alive = useRef(true);
  const started = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stopRef.current?.();
      stopRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (collectionId) { setDestination(collectionId); return; }
    if (collections?.length) {
      setDestination((current) => collections.some((c) => c.id === current) ? current : collections[0].id);
    }
  }, [collectionId, collections]);

  const mergeCandidates = (rows: ResearchCandidate[]) => {
    if (!rows?.length) return;
    setCandidates((current) => {
      const merged = new Map(current.map((candidate) => [candidate.key, candidate]));
      rows.forEach((candidate) => merged.set(candidate.key, candidate));
      return [...merged.values()];
    });
  };

  async function start() {
    const query = topic.trim();
    if (!query || running) return;
    if (!vaultPath) { setError('Open a vault before starting research.'); return; }
    stopRef.current?.();
    stopRef.current = null;
    const token = ++runToken.current;
    setRunning(true);
    setError('');
    setNotice('');
    setDeepUnavailable(false);
    setPhase(null);
    setCandidates([]);
    setSelected(new Set());
    setPreview(null);
    try {
      const result = await researchRuntime.start({
        vaultPath,
        ...(collectionId ? { collectionId } : {}),
        query,
        depth,
        includeWeb,
        useSources,
        requestId: crypto.randomUUID(),
      });
      if (!alive.current || token !== runToken.current) return;
      jobIdRef.current = result.jobId;
      stopRef.current = researchRuntime.subscribe(result.jobId, {
        onPhase: (payload) => {
          if (!alive.current || token !== runToken.current) return;
          jobIdRef.current = payload.jobId;
          setPhase({ phase: payload.phase, progress: payload.progress });
          const terminal = ['done', 'complete', 'completed', 'failed', 'cancelled'];
          if (!terminal.includes(payload.phase)) return;
          setRunning(false);
          if (payload.phase === 'failed') {
            // Phase events do not carry the error; the persisted session does.
            void researchRuntime.get(payload.sessionId).then((session) => {
              if (!alive.current || token !== runToken.current) return;
              setError(errorDetail(session.error) || 'Research failed.');
            }).catch(() => { if (alive.current && token === runToken.current) setError('Research failed.'); });
          }
        },
        onCandidates: (payload) => {
          if (!alive.current || token !== runToken.current) return;
          jobIdRef.current = payload.jobId;
          mergeCandidates(payload.candidates ?? []);
        },
      });
      // Recover anything emitted between the start call and registration.
      try {
        const session = await researchRuntime.get(result.sessionId);
        if (!alive.current || token !== runToken.current) return;
        mergeCandidates(session.candidates ?? []);
        if (session.phase) setPhase({ phase: session.phase, progress: session.progress });
        if (session.status === 'done' || session.status === 'failed' || session.status === 'cancelled') {
          setRunning(false);
          if (session.status === 'failed' && session.error) setError(errorDetail(session.error) || 'Research failed.');
        }
      } catch { /* Live phase/candidate events still drive the panel. */ }
    } catch (e) {
      if (!alive.current || token !== runToken.current) return;
      setRunning(false);
      const message = String((e as { message?: string })?.message ?? e ?? '');
      if (/NOT_AVAILABLE/i.test(message)) {
        setDeepUnavailable(true);
      } else {
        const detail = errorDetail(e);
        setError(detail ? `Research could not start. ${detail}` : 'Research could not start.');
      }
    }
  }

  async function cancel() {
    const jobId = jobIdRef.current;
    runToken.current++;
    stopRef.current?.();
    stopRef.current = null;
    jobIdRef.current = null;
    setRunning(false);
    setPhase(null);
    setCandidates([]);
    setSelected(new Set());
    setError('');
    setDeepUnavailable(false);
    setNotice('');
    if (jobId) {
      try { await researchRuntime.cancel(jobId); }
      catch (e) { if (alive.current) setError(`Could not cancel research. ${errorDetail(e)}`.trim()); }
    }
  }

  function selectCandidate(key: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }

  async function addSelected() {
    const keys = [...selected].filter((key) => {
      const candidate = candidates.find((row) => row.key === key);
      return candidate && !candidate.duplicateOf;
    });
    if (!keys.length || !destination) return;
    setAdding(true);
    setError('');
    setNotice('');
    try {
      const collection = await researchRuntime.addSources(vaultPath, destination, keys);
      if (!alive.current) return;
      setNotice(`Added ${keys.length} source${keys.length === 1 ? '' : 's'} to “${collection.title}”.`);
      setSelected(new Set());
      await onAdded?.(collection);
    } catch (e) {
      if (alive.current) setError(`Could not add sources. ${errorDetail(e)}`.trim());
    } finally {
      if (alive.current) setAdding(false);
    }
  }

  async function openPreview(key: string) {
    setError('');
    try {
      const result = await researchRuntime.preview(key);
      if (alive.current) setPreview(result);
    } catch (e) {
      if (alive.current) setError(`Preview is unavailable. ${errorDetail(e)}`.trim());
    }
  }

  useEffect(() => {
    const dialog = previewDialog.current;
    if (!preview) {
      if (dialog?.open) dialog.close();
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    if (dialog && !dialog.open) dialog.showModal();
    const timer = window.setTimeout(() => previewClose.current?.focus(), 20);
    return () => {
      window.clearTimeout(timer);
      if (dialog?.isConnected && dialog.open) dialog.close();
      if (previous && previous !== document.body && previous.isConnected) previous.focus();
    };
  }, [preview]);

  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    if (topic.trim()) void start();
    // The panel is mounted per run; only the first mount should dispatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External requests wait on privacy consent. Surfacing the pending approval
  // here keeps a run from looking stalled at its first phase.
  useEffect(() => {
    if (!running) { setApprovals([]); return; }
    let alivePoll = true;
    const poll = async () => {
      try {
        const rows = await knowledge.approvals();
        if (alivePoll) setApprovals(Array.isArray(rows) ? rows : []);
      } catch { /* Approval state is best-effort. */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => { alivePoll = false; window.clearInterval(timer); };
  }, [running]);

  async function resolveApproval(id: string, approved: boolean) {
    try {
      await knowledge.approve(id, approved);
      setApprovals((current) => current.filter((row) => row.id !== id));
    } catch (e) {
      setError(`Approval failed. ${errorDetail(e)}`.trim());
    }
  }

  const progress = phase ? percent(phase.progress) : 0;
  const canAdd = selected.size > 0 && !!destination && !adding;
  const doneEmpty = !running && !error && phase?.phase === 'done' && candidates.length === 0;
  return <section className="research-panel" aria-label="Research">
    <header className="research-panel__head">
      <h3>Research {depth === 'deep' ? '· Deep' : ''}</h3>
      {onClose && <button type="button" className="research-panel__close" onClick={onClose} aria-label="Close research">Close</button>}
    </header>

    <label className="research-panel__field">Topic
      <input
        value={topic}
        disabled={running}
        onChange={(event) => setTopic(event.target.value)}
        placeholder="What should Prism look for?"
      />
    </label>

    <div className="research-panel__options">
      <label><input type="checkbox" checked={includeWeb} disabled={running} onChange={(event) => setIncludeWeb(event.target.checked)} /> Include web</label>
      <label><input type="checkbox" checked={useSources} disabled={running} onChange={(event) => setUseSources(event.target.checked)} /> Use my sources</label>
    </div>

    <div className="research-panel__actions">
      {running
        ? <button type="button" onClick={() => void cancel()}>Cancel</button>
        : <button type="button" onClick={() => void start()} disabled={!topic.trim() || !vaultPath}>Start research</button>}
    </div>

    {(phase || running) && <p className="research-progress" role="status">
      <span>{phase ? phaseLabel(phase.phase) : 'Starting research…'}</span>
      {phase && <progress value={progress} max={100} aria-label="Research progress">{progress}%</progress>}
      {phase && <span>{progress}%</span>}
    </p>}

    {approvals.length > 0 && <div className="research-approval" role="status">
      <p>Prism needs your approval to contact <strong>{approvals[0].destination}</strong>. Progress stays on hold until you decide.</p>
      <div className="research-approval__actions">
        <button type="button" onClick={() => void resolveApproval(approvals[0].id, true)}>Approve</button>
        <button type="button" onClick={() => void resolveApproval(approvals[0].id, false)}>Deny</button>
      </div>
    </div>}
    {deepUnavailable && <p className="research-notice" role="status">Deep Research is coming in a later update. Use Discover for now.</p>}
    {doneEmpty && <p className="research-notice" role="status">No new sources were found for this topic. Try a broader question.</p>}
    {error && <p className="research-error" role="alert">{error}</p>}

    {candidates.length > 0 && <ul className="research-candidates" aria-label="Research candidates">
      {candidates.map((candidate) => <li key={candidate.key}>
        <CandidateCard
          candidate={candidate}
          selected={selected.has(candidate.key)}
          onSelect={selectCandidate}
          onPreview={(key) => void openPreview(key)}
        />
      </li>)}
    </ul>}

    {(candidates.length > 0 || notice) && <footer className="research-footer">
      {collections && <label className="research-panel__field">Add to notebook
        <select value={destination} onChange={(event) => setDestination(event.target.value)} disabled={adding}>
          <option value="">Select notebook</option>
          {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.title}</option>)}
        </select>
      </label>}
      <button type="button" onClick={() => void addSelected()} disabled={!canAdd}>
        Add {selected.size} source{selected.size === 1 ? '' : 's'}
      </button>
    </footer>}
    {notice && <p className="research-success" role="status">{notice}</p>}
    {collections && !collections.length && <p className="research-panel__hint">Create a notebook to keep researched sources.</p>}

    <dialog
      ref={previewDialog}
      className="research-preview-dialog"
      aria-labelledby="research-preview-title"
      onCancel={(event) => { event.preventDefault(); setPreview(null); }}
    >
      {preview && <>
        <header className="research-preview-dialog__head">
          <h3 id="research-preview-title">{preview.title}</h3>
          <button ref={previewClose} type="button" onClick={() => setPreview(null)} aria-label="Close preview">Close</button>
        </header>
        {preview.url && <a href={preview.url} target="_blank" rel="noreferrer">Open page</a>}
        <pre>{preview.text}</pre>
      </>}
    </dialog>
  </section>;
}

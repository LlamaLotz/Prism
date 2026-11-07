import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, X, FolderOpen, File, AlertTriangle } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import {
  documents,
  type BatchCommitResult,
  type BatchPrepareResult,
} from '../services/documents';

type BatchPhase = 'idle' | 'committing' | 'committed' | 'error';
interface DocumentImportProgress {
  id: string;
  batchId: string | null;
  phase: 'verifying' | 'publishing' | 'done' | 'error';
  completed: number;
  total: number;
  title?: string;
}

interface BatchImportReviewProps {
  batch: BatchPrepareResult | null;
  onClose: () => void;
  onReview: (id: string) => void;
  onPublished: () => void;
}

export const BatchImportReview: React.FC<BatchImportReviewProps> = ({
  batch,
  onClose,
  onReview,
  onPublished,
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [phase, setPhase] = useState<BatchPhase>('idle');
  const [progress, setProgress] = useState<DocumentImportProgress | null>(null);
  const [result, setResult] = useState<BatchCommitResult | null>(null);
  const [error, setError] = useState('');
  const [imported, setImported] = useState<string[]>([]);

  useEffect(() => {
    if (!batch) return;
    setPhase('idle');
    setProgress(null);
    setResult(null);
    setError('');
    setImported([]);
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
      if (dialog?.isConnected && dialog.open) dialog.close();
    };
  }, [batch]);

  useEffect(() => {
    if (!batch || phase !== 'committing') return;
    let unlisten: (() => void) | undefined;
    void listen<DocumentImportProgress>('document-import-progress', (event) => {
      if (event.payload.batchId === batch.batchId) setProgress(event.payload);
    }).then((stop) => { unlisten = stop; }).catch(() => {});
    return () => { unlisten?.(); };
  }, [batch, phase]);

  if (!batch) return null;

  const committing = phase === 'committing';
  const committed = phase === 'committed';
  const ready = batch.imports.filter((item) => !imported.includes(item.id)).length;
  const canCommitAll = !committing && ready > 0;

  const commitAll = async () => {
    const readyCount = ready;
    setPhase('committing');
    setProgress(null);
    setError('');
    try {
      const outcome = await documents.commitBatch(batch.batchId);
      setResult(outcome);
      setImported((current) => [...new Set([...current, ...outcome.committed])]);
      if (outcome.committed.length > 0) onPublished();
      const fullSuccess = outcome.failed.length === 0 && outcome.skipped.length === 0 && outcome.committed.length === readyCount;
      setPhase('committed');
      if (fullSuccess) {
        closeTimer.current = window.setTimeout(() => onClose(), 900);
      }
    } catch (err) {
      setError(String(err));
      setPhase('error');
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="runtime-dialog runtime-surface document-dialog batch-import-dialog"
      aria-labelledby="batch-review-title"
      aria-busy={committing || undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!committing) onClose();
      }}
    >
      <header className="runtime-heading">
        <h2 id="batch-review-title">Review batch import</h2>
        <button className="runtime-button" disabled={committing} onClick={onClose} aria-label="Close batch review">
          Close
        </button>
      </header>

      <p>
        {batch.batchLabel} · {batch.imports.length} import(s)
        {batch.failures.length ? ` · ${batch.failures.length} failed` : ''}
        {batch.skipped.length ? ` · ${batch.skipped.length} skipped` : ''}
      </p>
      <p>
        Each file is its own note. Review individually or commit every clean import at once.
        Conflicts must be resolved in the individual review.
      </p>

      {committing && (
        <p role="status" aria-live="polite" className="runtime-local">
          {progress
            ? `Importing ${Math.max(progress.completed, 0)} of ${progress.total}${progress.title ? ` · ${progress.title}` : ''}`
            : 'Importing…'}
        </p>
      )}
      {committed && result && result.failed.length === 0 && result.skipped.length === 0 && (
        <p role="status" aria-live="polite" className="runtime-local">Imported {result.committed.length} note(s).</p>
      )}
      {error && <p className="runtime-error" role="alert">{error}</p>}

      {batch.failures.length > 0 && (
        <details open>
          <summary>Files that could not be prepared ({batch.failures.length})</summary>
          <ul>
            {batch.failures.map((failure) => (
              <li key={`${failure.source}:${failure.error}`}>
                <strong>{failure.source}</strong> — {failure.error}
              </li>
            ))}
          </ul>
        </details>
      )}

      {batch.skipped.length > 0 && (
        <details>
          <summary>Skipped files ({batch.skipped.length})</summary>
          <ul>
            {batch.skipped.map((failure) => (
              <li key={`${failure.source}:${failure.error}`}>
                <strong>{failure.source}</strong> — {failure.error}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="batch-import-list">
        {batch.imports.map((item) => {
          const isImported = imported.includes(item.id);
          return (
            <article className="runtime-job" key={item.id}>
              <div className="batch-import-row">
                {item.source.includes('/') || item.source.includes('\\') ? (
                  <FolderOpen className="w-4 h-4 text-brand-400 shrink-0" />
                ) : (
                  <File className="w-4 h-4 text-slate-400 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <strong>{item.title}</strong>
                  <p className="batch-import-destination">
                    {item.destination}.md{item.cached ? ' · cached' : ''}
                  </p>
                  <p className="batch-import-source" title={item.source}>
                    {item.source}
                  </p>
                </div>
                {isImported ? (
                  <span className="batch-import-status is-done">
                    <CheckCircle2 className="w-3.5 h-3.5" /> imported
                  </span>
                ) : (
                  <button
                    className="runtime-button"
                    disabled={committing}
                    onClick={() => onReview(item.id)}
                  >
                    Review
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {result && (result.skipped.length > 0 || result.failed.length > 0) && (
        <div className="runtime-local">
          <p role="status">
            Committed {result.committed.length} import(s).
            {result.skipped.length ? ` Skipped ${result.skipped.length}.` : ''}
            {result.failed.length ? ` Failed ${result.failed.length}.` : ''}
          </p>
          {result.skipped.length > 0 && (
            <ul>
              {result.skipped.map((item) => (
                <li key={`${item.source}:${item.error}`}>
                  {item.source} — {item.error}
                </li>
              ))}
            </ul>
          )}
          {result.failed.length > 0 && (
            <ul>
              {result.failed.map((item) => (
                <li key={`${item.source}:${item.error}`}>
                  {item.source} — {item.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {batch.failures.length > 0 && !result && (
        <p className="batch-import-note">
          <AlertTriangle className="w-4 h-4" />
          Failed files do not block the rest of the batch. They remain listed here for retry.
        </p>
      )}

      <div className="runtime-actions">
        <button className="runtime-button" disabled={committing} onClick={onClose}>
          Close
        </button>
        <button className="runtime-button runtime-primary" disabled={!canCommitAll} onClick={() => void commitAll()}>
          {committing ? 'Committing…' : `Commit all ready · ${ready}`}
        </button>
      </div>
    </dialog>
  );
};

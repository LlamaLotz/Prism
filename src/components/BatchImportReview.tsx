import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, X, FolderOpen, File, AlertTriangle } from 'lucide-react';
import {
  documents,
  type BatchCommitResult,
  type BatchPrepareResult,
} from '../services/documents';

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
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BatchCommitResult | null>(null);
  const [error, setError] = useState('');
  const [imported, setImported] = useState<string[]>([]);

  useEffect(() => {
    if (!batch) return;
    setResult(null);
    setError('');
    setImported([]);
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.isConnected && dialog.open) dialog.close();
    };
  }, [batch]);

  if (!batch) return null;

  const commitAll = async () => {
    setBusy(true);
    setError('');
    try {
      const outcome = await documents.commitBatch(batch.batchId);
      setResult(outcome);
      setImported((current) => [...new Set([...current, ...outcome.committed])]);
      if (outcome.committed.length > 0) onPublished();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const ready = batch.imports.filter((item) => !imported.includes(item.id)).length;
  const canCommitAll = !busy && ready > 0;

  return (
    <dialog
      ref={dialogRef}
      className="runtime-dialog runtime-surface document-dialog batch-import-dialog"
      aria-labelledby="batch-review-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="runtime-heading">
        <h2 id="batch-review-title">Review batch import</h2>
        <button className="runtime-button" disabled={busy} onClick={onClose} aria-label="Close batch review">
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
                    disabled={busy}
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

      {result && (
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
        <button className="runtime-button" disabled={busy} onClick={onClose}>
          Close
        </button>
        <button className="runtime-button runtime-primary" disabled={!canCommitAll} onClick={() => void commitAll()}>
          {busy ? 'Committing…' : `Commit all ready · ${ready}`}
        </button>
      </div>
    </dialog>
  );
};

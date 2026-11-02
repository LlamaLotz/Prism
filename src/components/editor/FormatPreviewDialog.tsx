import React, { useMemo } from 'react';
import type { NoteFormatPreview, StructureErrorInfo } from '../../services/structure';
import {
  boundedTextPreview,
  markdownOutline,
  outlineFromNodes,
  type OutlineEntry,
} from '../../utils/structurePreview';
import { OutlinePreview } from './OutlinePreview';
import { PreviewDialog } from './PreviewDialog';

interface FormatPreviewDialogProps {
  loading: boolean;
  preview: NoteFormatPreview | null;
  outlineBefore: OutlineEntry[];
  /** True when the deterministic TypeScript formatter supplied the preview. */
  usedFallback: boolean;
  error: StructureErrorInfo | null;
  staleError: string | null;
  applying: boolean;
  returnFocus?: HTMLElement | null;
  onRetry: () => void;
  onApply: () => void;
  onClose: () => void;
}

const formatCount = (value: number) => value.toLocaleString();

export const FormatPreviewDialog: React.FC<FormatPreviewDialogProps> = ({
  loading,
  preview,
  outlineBefore,
  usedFallback,
  error,
  staleError,
  applying,
  returnFocus,
  onRetry,
  onApply,
  onClose,
}) => {
  const bounded = useMemo(
    () => (preview ? boundedTextPreview(preview.content) : null),
    [preview?.content]
  );
  const outlineAfter = useMemo(
    () =>
      preview
        ? usedFallback
          ? markdownOutline(preview.content)
          : outlineFromNodes(preview.outline)
        : [],
    [preview, usedFallback]
  );
  const canApply = !!preview && preview.changed && !loading && !applying && !staleError;
  const showFormattedText = !!preview;

  return (
    <PreviewDialog
      title="Format preview"
      description="Review the safe formatting changes before applying them to this note."
      onClose={onClose}
      panelClassName="structure-dialog--format"
      returnFocus={returnFocus}
      footer={
        <>
          {staleError && (
            <button type="button" className="structure-button" onClick={onRetry}>
              Refresh preview
            </button>
          )}
          {error && !loading && !staleError && (
            <button type="button" className="structure-button" onClick={onRetry}>
              Try again
            </button>
          )}
          <button type="button" className="structure-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="structure-button structure-button--primary"
            onClick={onApply}
            disabled={!canApply}
          >
            {applying ? 'Applying…' : 'Apply formatting'}
          </button>
        </>
      }
    >
      {loading && (
        <p role="status" className="structure-muted">
          Building a safe format preview…
        </p>
      )}

      {error && (
        <div role="alert" className="structure-alert" data-error-code={error.code}>
          <strong>
            {error.title} <span className="structure-code">{error.code}</span>
          </strong>
          {error.detail && <p>{error.detail}</p>}
          <p>{error.action}</p>
          {usedFallback && (
            <p>
              The command preview was unavailable, so this preview uses Prism&apos;s built-in
              formatter. Nothing is applied until you confirm.
            </p>
          )}
        </div>
      )}

      {staleError && (
        <div role="alert" className="structure-alert">
          <strong>This note changed since the preview was built.</strong>
          <p>{staleError}</p>
          <p>Refresh the preview and review the new result before applying it.</p>
        </div>
      )}

      {preview && !loading && (
        <>
          <p className="structure-summary" role="status">
            {preview.changed
              ? 'This preview changes the note. Apply only when the outline and text look right.'
              : 'This note is already formatted. There is nothing to apply.'}
          </p>

          {preview.warnings.length > 0 && (
            <section className="structure-warnings" aria-label="Formatting warnings">
              <h3>Warnings</h3>
              <ul>
                {preview.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          <div className="structure-outline-grid">
            <OutlinePreview label="Before" entries={outlineBefore} />
            <OutlinePreview label="After" entries={outlineAfter} />
          </div>

          {showFormattedText && bounded && (
            <section className="structure-text-preview" aria-label="Formatted text preview">
              <div className="structure-text-preview__heading">
                <h3>Formatted text</h3>
                <span>
                  {formatCount(bounded.totalChars)} characters
                  {bounded.truncated ? ' · preview truncated' : ''}
                </span>
              </div>
              <pre tabIndex={0} aria-label="Formatted text">
                {bounded.text}
              </pre>
              {bounded.truncated && (
                <p className="structure-muted">
                  The preview is limited to the first part of the formatted note so a large note
                  never blocks the editor. Applying still uses the complete formatted text.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </PreviewDialog>
  );
};

import React, { useId, useMemo } from 'react';
import type {
  SplitOption,
  StructureErrorInfo,
  StructureInspection,
  StructureModelStatus,
  StructureSplitMode,
} from '../../services/structure';
import { outlineFromNodes } from '../../utils/structurePreview';
import { OutlinePreview } from './OutlinePreview';
import { PreviewDialog } from './PreviewDialog';

export interface SplitPreviewSection {
  title: string;
  fileName: string;
  content: string;
  startBlock: string | null;
  endBlock: string | null;
}

/** Normalized preview shape for both command plans and the built-in H2 fallback. */
export interface SplitPreviewPlan {
  mode: StructureSplitMode;
  level: number | null;
  modelUsed: boolean;
  parentContent: string;
  sections: SplitPreviewSection[];
  warnings: string[];
  stats: { blocks: number; sections: number; modelMs: number };
  source: 'command' | 'builtin';
}

interface SplitPreviewDialogProps {
  loading: boolean;
  loadError: StructureErrorInfo | null;
  inspection: StructureInspection | null;
  modelStatus: StructureModelStatus | null;
  modelStatusError: StructureErrorInfo | null;
  fallbackPlan: SplitPreviewPlan | null;
  mode: StructureSplitMode;
  headingLevel: number | null;
  plan: SplitPreviewPlan | null;
  planning: boolean;
  planError: StructureErrorInfo | null;
  applyError: StructureErrorInfo | null;
  staleError: string | null;
  applying: boolean;
  returnFocus?: HTMLElement | null;
  onModeChange: (mode: StructureSplitMode) => void;
  onHeadingLevelChange: (level: number) => void;
  onPlan: () => void;
  onUseFallback: () => void;
  onApply: () => void;
  onRetryLoad: () => void;
  onClose: () => void;
}

const sectionCount = (count: number) => `${count} ${count === 1 ? 'section' : 'sections'}`;

const optionFor = (options: SplitOption[] | undefined, mode: StructureSplitMode) =>
  options?.find((option) => option.mode === mode) ?? null;

const modeLabel = (mode: StructureSplitMode) =>
  mode === 'auto'
    ? 'Auto'
    : mode === 'headings'
      ? 'Headings'
      : mode === 'paragraph'
        ? 'Paragraph'
        : 'Topics';

const planModeLabel = (mode: StructureSplitMode, level: number | null) =>
  mode === 'headings' && level ? `Heading ${level}` : modeLabel(mode);

export const SplitPreviewDialog: React.FC<SplitPreviewDialogProps> = ({
  loading,
  loadError,
  inspection,
  modelStatus,
  modelStatusError,
  fallbackPlan,
  mode,
  headingLevel,
  plan,
  planning,
  planError,
  applyError,
  staleError,
  applying,
  returnFocus,
  onModeChange,
  onHeadingLevelChange,
  onPlan,
  onUseFallback,
  onApply,
  onRetryLoad,
  onClose,
}) => {
  const baseId = useId();
  const inspectionOutline = useMemo(
    () => outlineFromNodes(inspection?.outline),
    [inspection?.outline]
  );
  const headingOptions =
    inspection?.splitOptions?.filter((option) => option.mode === 'headings') ?? [];
  const usableHeadingOptions = headingOptions.filter((option) => option.sections >= 2);
  const paragraphOption = optionFor(inspection?.splitOptions, 'paragraph');
  const modelReady = modelStatus?.state === 'ready';
  const topicsDisabled = !inspection || !modelReady;
  const projectable = !!inspection && (inspection.blocks?.length ?? 0) >= 2;
  const canApply = !!plan && !planning && !applying && !staleError;
  const visibleSections = plan ? plan.sections.slice(0, 500) : [];
  const hiddenSections = plan ? plan.sections.length - visibleSections.length : 0;

  const topicsExplanation = modelReady
    ? 'Topics may use the local model only when the note has no usable heading outline.'
    : modelStatus
      ? `${modelStatus.message} Headings, Auto, and Paragraph still work.`
      : modelStatusError
        ? `${modelStatusError.detail || modelStatusError.title} Headings, Auto, and Paragraph still work.`
        : 'Checking the local structure model. Headings, Auto, and Paragraph still work.';

  const modeDescription = (value: StructureSplitMode) => {
    switch (value) {
      case 'headings':
        return headingOptions.length > 0
          ? `${headingOptions.length} heading ${headingOptions.length === 1 ? 'level' : 'levels'} found`
          : 'No heading levels found';
      case 'auto':
        return 'Best available headings, then paragraph chunks';
      case 'paragraph':
        return paragraphOption ? paragraphOption.label : 'Paragraph chunks';
      case 'topics':
        return modelReady ? 'Local model; used only without a usable outline' : 'Unavailable';
    }
  };

  const radioDescriptionId = (value: StructureSplitMode) => `${baseId}-mode-${value}-description`;

  return (
    <PreviewDialog
      title="Split note"
      description="Choose how to split this note, review every section, then confirm the split."
      onClose={onClose}
      panelClassName="structure-dialog--split"
      returnFocus={returnFocus}
      footer={
        <>
          {staleError && (
            <button type="button" className="structure-button" onClick={onPlan}>
              Refresh preview
            </button>
          )}
          {loadError && (
            <button type="button" className="structure-button" onClick={onRetryLoad}>
              Try again
            </button>
          )}
          <button type="button" className="structure-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="structure-button"
            onClick={onPlan}
            disabled={
              loading ||
              planning ||
              !projectable ||
              (topicsDisabled && mode === 'topics')
            }
          >
            {planning ? 'Building preview…' : 'Preview split'}
          </button>
          <button
            type="button"
            className="structure-button structure-button--primary"
            onClick={onApply}
            disabled={!canApply}
          >
            {applying ? 'Splitting…' : 'Split note'}
          </button>
        </>
      }
    >
      {loading && (
        <p role="status" className="structure-muted">
          Inspecting the note structure…
        </p>
      )}

      {loadError && (
        <div role="alert" className="structure-alert" data-error-code={loadError.code}>
          <strong>
            {loadError.title} <span className="structure-code">{loadError.code}</span>
          </strong>
          {loadError.detail && <p>{loadError.detail}</p>}
          <p>{loadError.action}</p>
          {fallbackPlan && (
            <div className="structure-alert__actions">
              <button type="button" className="structure-button" onClick={onUseFallback}>
                Use built-in heading split
              </button>
              <span>Keeps the previous H2-based behavior without the structure preview.</span>
            </div>
          )}
        </div>
      )}

      {inspection && !loading && (
        <>
          {(inspection.warnings?.length ?? 0) > 0 && (
            <section className="structure-warnings" aria-label="Structure warnings">
              <h3>Structure notes</h3>
              <ul>
                {inspection.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          {inspectionOutline.length > 0 && (
            <OutlinePreview label="Current headings" entries={inspectionOutline} />
          )}

          <fieldset className="structure-modes">
            <legend>Split by</legend>
            <div className="structure-mode-grid" role="radiogroup" aria-label="Split mode">
              {(['headings', 'auto', 'paragraph', 'topics'] as const).map((value) => {
                const disabled =
                  value === 'headings'
                    ? usableHeadingOptions.length === 0
                    : value === 'paragraph'
                      ? !paragraphOption
                      : value === 'topics'
                        ? topicsDisabled
                        : !projectable;
                return (
                  <label
                    key={value}
                    className="structure-mode"
                    data-disabled={disabled ? 'true' : undefined}
                  >
                    <input
                      type="radio"
                      name={`${baseId}-split-mode`}
                      value={value}
                      checked={mode === value}
                      disabled={disabled || loading}
                      aria-label={modeLabel(value)}
                      aria-describedby={radioDescriptionId(value)}
                      onChange={() => onModeChange(value)}
                    />
                    <span className="structure-mode__text">
                      <strong>{modeLabel(value)}</strong>
                      <span id={radioDescriptionId(value)}>{modeDescription(value)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {mode === 'headings' && headingOptions.length > 0 && (
            <fieldset className="structure-levels">
              <legend>Heading level</legend>
              <div className="structure-level-list">
                {headingOptions.map((option) => {
                  const disabled = option.sections < 2;
                  return (
                    <label
                      key={`heading-${option.level}`}
                      className="structure-level"
                      data-disabled={disabled ? 'true' : undefined}
                    >
                      <input
                        type="radio"
                        name={`${baseId}-heading-level`}
                        value={option.level ?? ''}
                        checked={headingLevel === option.level}
                        disabled={disabled}
                        onChange={() => option.level && onHeadingLevelChange(option.level)}
                        aria-label={option.label}
                      />
                      <span aria-hidden="true">{option.label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}

          {mode === 'topics' || topicsDisabled ? (
            <p
              className="structure-note"
              data-model-state={modelStatus?.state ?? 'unknown'}
              role={topicsDisabled ? 'note' : undefined}
            >
              <strong>{topicsDisabled ? 'Topics is unavailable.' : 'Topics preview.'}</strong>{' '}
              {topicsExplanation}
            </p>
          ) : null}
        </>
      )}

      {planError && (
        <div role="alert" className="structure-alert" data-error-code={planError.code}>
          <strong>
            {planError.title} <span className="structure-code">{planError.code}</span>
          </strong>
          {planError.detail && <p>{planError.detail}</p>}
          <p>{planError.action}</p>
          <div className="structure-alert__actions">
            <button type="button" className="structure-button" onClick={onPlan}>
              Refresh preview
            </button>
            {fallbackPlan && (
              <button type="button" className="structure-button" onClick={onUseFallback}>
                Use built-in heading split
              </button>
            )}
          </div>
        </div>
      )}

      {staleError && (
        <div role="alert" className="structure-alert">
          <strong>This note changed after the preview was built.</strong>
          <p>{staleError}</p>
          <p>Refresh the preview and review the new sections before applying the split.</p>
        </div>
      )}

      {applyError && (
        <div role="alert" className="structure-alert" data-error-code={applyError.code}>
          <strong>
            {applyError.title} <span className="structure-code">{applyError.code}</span>
          </strong>
          {applyError.detail && <p>{applyError.detail}</p>}
          <p>{applyError.action}</p>
        </div>
      )}

      {planning && (
        <p role="status" className="structure-muted">
          Building the split preview. The local model can take a little while…
        </p>
      )}

      {plan && !planning && (
        <section className="structure-plan" aria-label="Split preview">
          <div className="structure-plan__summary">
            <div>
              <h3>
                {sectionCount(plan.sections.length)} · {plan.stats.blocks} blocks
              </h3>
              <p>
                {planModeLabel(plan.mode, plan.level)} ·{' '}
                {plan.modelUsed
                  ? `Local model used${plan.stats.modelMs > 0 ? ` (${(plan.stats.modelMs / 1000).toFixed(1)}s)` : ''}`
                  : 'Deterministic split, no model used'}
              </p>
            </div>
            {plan.source === 'builtin' && (
              <span className="structure-code">Built-in H2 splitter</span>
            )}
          </div>

          <div className="structure-plan__table-wrap">
            <table className="structure-plan__table">
              <caption className="sr-only">Sections that will be created</caption>
              <thead>
                <tr>
                  <th scope="col">Section</th>
                  <th scope="col">Blocks</th>
                  <th scope="col">Characters</th>
                </tr>
              </thead>
              <tbody>
                {visibleSections.map((section, index) => (
                  <tr key={`${section.fileName}-${index}`}>
                    <td>
                      <span className="structure-plan__title">{section.title}</span>
                      <span className="structure-plan__file">{section.fileName}.md</span>
                    </td>
                    <td className="structure-plan__range">
                      {section.startBlock && section.endBlock
                        ? `${section.startBlock}–${section.endBlock}`
                        : '—'}
                    </td>
                    <td className="structure-plan__size">
                      {section.content.length.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hiddenSections > 0 && (
            <p className="structure-muted">
              … and {hiddenSections.toLocaleString()} more{' '}
              {hiddenSections === 1 ? 'section' : 'sections'}. The split still applies the complete
              plan.
            </p>
          )}

          {plan.warnings.length > 0 && (
            <section className="structure-warnings" aria-label="Split warnings">
              <h3>Warnings</h3>
              <ul>
                {plan.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          <p className="structure-muted">
            The original note becomes an index and keeps its frontmatter and introduction. Section
            text is rendered from the original blocks, never from model output.
          </p>
        </section>
      )}
    </PreviewDialog>
  );
};

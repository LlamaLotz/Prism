import type { ResearchCandidate } from '../../types';

/** Map the backend's 0..1 score to the percentage chip, tolerating 0..100. */
export function relevancePercent(score: number): number {
  const value = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(100, Math.round(value <= 1 ? value * 100 : value)));
}

export function CandidateCard({ candidate, selected, onSelect, onPreview }: {
  candidate: ResearchCandidate;
  selected: boolean;
  onSelect: (key: string, selected: boolean) => void;
  onPreview: (key: string) => void;
}) {
  const duplicate = !!candidate.duplicateOf;
  return <article className="research-candidate" data-duplicate={duplicate || undefined}>
    <div className="research-candidate__top">
      <input
        type="checkbox"
        checked={selected && !duplicate}
        disabled={duplicate}
        aria-label={`Select ${candidate.title}`}
        onChange={(event) => onSelect(candidate.key, event.target.checked)}
      />
      <div className="research-candidate__body">
        <a className="research-candidate__title" href={candidate.url} target="_blank" rel="noreferrer">
          {candidate.title}
        </a>
        <div className="research-candidate__meta">
          {candidate.domain && <span className="research-chip" title={candidate.url}>{candidate.domain}</span>}
          <span className="research-chip" data-relevance="true">
            {relevancePercent(candidate.relevance?.finalScore)}% relevant
          </span>
          {duplicate && <span className="research-chip" data-duplicate="true">Duplicate</span>}
        </div>
      </div>
    </div>
    {candidate.snippet && <p className="research-snippet">{candidate.snippet}</p>}
    {candidate.why && <p className="research-why">Why: {candidate.why}</p>}
    <div className="research-candidate__actions">
      <button type="button" onClick={() => onPreview(candidate.key)} aria-label={`Preview ${candidate.title}`}>
        Preview
      </button>
    </div>
  </article>;
}

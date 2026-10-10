import './StatusMark.css';

export type StatusState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

const SPOKEN: Record<StatusState, string> = {
  pending: 'Pending',
  running: 'In progress',
  done: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Lifecycle status glyph + label (React Bits StatusMark pattern, adapted to
 * Prism's archetypes with plain SVG/CSS instead of a motion library).
 *
 * The dashed idle ring fuses into an arc while running, then resolves into a
 * drawn check (done) or cross (failed/cancelled). Completed states stay
 * understated; failures stay legible so a retry affordance next to them reads
 * as the obvious next step. Labels are plain ReactNode so callers can keep
 * meaningful per-task text (e.g. "Generating Quiz…").
 */
export function StatusMark({ status, label, progress, size = 16, className = '' }: {
  status: StatusState;
  /** Text beside the glyph. Rendered muted once the task settles. */
  label?: React.ReactNode;
  /** 0..1 while running; omit for an indeterminate arc. */
  progress?: number;
  size?: number;
  className?: string;
}) {
  const determinate = status === 'running' && typeof progress === 'number' && Number.isFinite(progress);
  const spoken = SPOKEN[status] + (determinate ? `, ${Math.round(Math.min(1, Math.max(0, progress!)) * 100)}%` : '');
  return (
    <span className={`status-mark${className ? ` ${className}` : ''}`} data-status={status} data-indeterminate={status === 'running' && !determinate ? '' : undefined}>
      <svg style={{width:size,height:size}} className="status-mark__glyph" viewBox="0 0 24 24" width={size} height={size} role={label ? undefined : 'img'} aria-label={label ? undefined : spoken} aria-hidden={label ? true : undefined}>
        <circle className="status-mark__track" cx="12" cy="12" r="9" />
        <circle
          className="status-mark__ring"
          cx="12"
          cy="12"
          r="9"
          style={determinate ? { strokeDasharray: `${Math.min(1, Math.max(0, progress!)) * 56.5} 56.5` } : undefined}
        />
        {(status === 'pending' || status === 'running') && <circle className="status-mark__dot" cx="12" cy="12" r="2" fill="currentColor"/>}
        <path className="status-mark__check" d="M7.5 12.25 10.5 15.25 16.75 8.75" pathLength={1} />
        <path className="status-mark__cross" d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5" pathLength={1} />
      </svg>
      {label ? (
        <span className="status-mark__label">
          <span className="status-mark__sr">{spoken}: </span>
          {label}
        </span>
      ) : null}
    </span>
  );
}

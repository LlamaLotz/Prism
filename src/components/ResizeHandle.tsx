import React, { useEffect, useRef, useState } from 'react';
interface ResizeHandleProps {
  direction: 'vertical' | 'horizontal';
  onResize: (delta: number) => void;
  className?: string;
  label?: string;
  value?: number;
  min?: number;
  max?: number;
  /** Supplying onValueChange opts into absolute, drag-origin based sizing. */
  onValueChange?: (value: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: (value: number, changed: boolean) => void;
  sign?: 1 | -1;
}
export const ResizeHandle: React.FC<ResizeHandleProps> = (props) => {
  const { direction, className = '', label, value, min, max } = props;
  const vertical = direction === 'vertical';
  const latest = useRef(props); latest.current = props;
  const drag = useRef<{ pointer: number; origin: number; start: number; next: number; last: number; value: number } | null>(null);
  const frame = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const constrain = (n: number) => Math.max(latest.current.min ?? -Infinity, Math.min(latest.current.max ?? Infinity, n));
  const flush = () => {
    frame.current = null;
    const d = drag.current;
    if (!d) return;
    const p = latest.current;
    if (p.onValueChange) {
      d.value = constrain(d.start + (d.next - d.origin) * (p.sign ?? 1));
      p.onValueChange(d.value);
    } else p.onResize(d.next - d.last);
    d.last = d.next;
  };
  const finish = () => {
    if (!drag.current) return;
    if (frame.current !== null) { cancelAnimationFrame(frame.current); flush(); }
    const result = drag.current.value;
    const changed = result !== drag.current.start;
    drag.current = null;
    setDragging(false);
    latest.current.onResizeEnd?.(result, changed);
  };
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (drag.current) latest.current.onResizeEnd?.(drag.current.value, drag.current.value !== drag.current.start);
    drag.current = null;
  }, []);
  return <div role="separator" tabIndex={0}
    aria-label={label ?? (vertical ? 'Resize panel height' : 'Resize sidebar width')}
    aria-orientation={vertical ? 'horizontal' : 'vertical'} aria-valuenow={value === undefined ? undefined : Math.round(value)} aria-valuemin={min} aria-valuemax={max === undefined ? undefined : Math.round(max)}
    data-dragging={dragging || undefined}
    className={`resize-handle ${vertical ? 'resize-handle-row' : 'resize-handle-column'} ${className}`}
    onPointerDown={e => {
      if (e.button !== 0 || drag.current) return;
      e.preventDefault(); e.currentTarget.focus();
      e.currentTarget.setPointerCapture(e.pointerId);
      const pos = vertical ? e.clientY : e.clientX;
      drag.current = { pointer: e.pointerId, origin: pos, start: value ?? 0, next: pos, last: pos, value: value ?? 0 };
      setDragging(true); latest.current.onResizeStart?.();
    }}
    onPointerMove={e => {
      if (!drag.current || e.pointerId !== drag.current.pointer) return;
      drag.current.next = vertical ? e.clientY : e.clientX;
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    }}
    onPointerUp={e => {
      if (drag.current?.pointer !== e.pointerId) return;
      drag.current.next = vertical ? e.clientY : e.clientX;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      flush(); finish();
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    }}
    onLostPointerCapture={finish} onPointerCancel={finish}
    onKeyDown={e => {
      const p = latest.current;
      const delta = (vertical ? e.key === 'ArrowDown' : e.key === 'ArrowRight') ? 16 : (vertical ? e.key === 'ArrowUp' : e.key === 'ArrowLeft') ? -16 : 0;
      if (!delta && !(p.onValueChange && (e.key === 'Home' || e.key === 'End'))) return;
      e.preventDefault();
      if (p.onValueChange) {
        const next = constrain(e.key === 'Home' ? p.min ?? 0 : e.key === 'End' ? p.max ?? p.value ?? 0 : (p.value ?? 0) + delta * (e.shiftKey ? 4 : 1) * (p.sign ?? 1));
        p.onResizeStart?.(); p.onValueChange(next); p.onResizeEnd?.(next, next !== p.value);
      } else p.onResize(delta * (e.shiftKey ? 4 : 1));
    }}><span className="resize-handle-grip" /></div>;
};

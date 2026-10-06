import { useRef, type ReactNode } from 'react';
import './FlipCard.css';

/** The two opaque faces form one rotating surface. Controls stay outside it. */
export function FlipCard({ flipped, onFlip, front, back, header, footer, frontLabel = 'Show answer', backLabel = 'Show question', className = '', disabled = false }: {
  flipped: boolean; onFlip: () => void; front: ReactNode; back: ReactNode;
  header?: ReactNode; footer?: ReactNode; frontLabel?: string; backLabel?: string; className?: string; disabled?: boolean;
}) {
  const gesture = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const interactive = (target: EventTarget) => !!(target as HTMLElement).closest('a,button,input,select,textarea');
  const flip = () => { if (!disabled && !window.getSelection()?.toString()) onFlip(); };
  return <div className={`flip-card ${className}`} data-flipped={flipped || undefined}>
    {header}
    <div className="flip-card__stage" role="group" tabIndex={disabled ? -1 : 0} aria-label={flipped ? backLabel : frontLabel}
      onKeyDown={e => { if ((e.key === ' ' || e.key === 'Enter') && e.target === e.currentTarget) { e.preventDefault(); e.stopPropagation(); flip(); } }}
      onClick={e => { if (!interactive(e.target) && !gesture.current?.dragged) flip(); }}
      onPointerDown={e => { gesture.current = { x: e.clientX, y: e.clientY, dragged: false }; }}
      onPointerUp={e => { const start = gesture.current; if (start && Math.abs(e.clientX - start.x) > 55 && Math.abs(e.clientX - start.x) > Math.abs(e.clientY - start.y) * 1.5 && !interactive(e.target)) { start.dragged = true; flip(); } setTimeout(() => { gesture.current = null; }, 0); }}
      onPointerCancel={() => { gesture.current = null; }}
      onPointerMove={e => { if (e.pointerType !== 'mouse' || e.buttons || !matchMedia('(hover:hover)').matches) return; const r=e.currentTarget.getBoundingClientRect(); e.currentTarget.style.setProperty('--tilt-x', `${(e.clientY-r.top)/r.height* -4+2}deg`); e.currentTarget.style.setProperty('--tilt-y', `${(e.clientX-r.left)/r.width*4-2}deg`); }}
      onPointerLeave={e => { e.currentTarget.style.setProperty('--tilt-x','0deg');e.currentTarget.style.setProperty('--tilt-y','0deg'); }}>
      <div className="flip-card__rotor">
        <div className="flip-card__face flip-card__face--front" aria-hidden={flipped} inert={flipped}>{front}</div>
        <div className="flip-card__face flip-card__face--back" aria-hidden={!flipped} inert={!flipped}>{back}</div>
      </div>
    </div>
    <div className="flip-card__footer">{footer}<button type="button" disabled={disabled} onClick={flip}>{flipped ? backLabel : frontLabel}</button></div>
  </div>;
}

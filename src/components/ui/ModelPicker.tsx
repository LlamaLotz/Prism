import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './ModelPicker.css';
import './notebook-tokens.css';

export interface ModelPickerOption {
  /** Stable key (provider id or model id). Never rendered as the primary label. */
  value: string;
  /** Human-facing name shown on the chip and in the menu. */
  label: string;
  /** Short right-aligned metadata (provider, tier, capability). */
  tag?: string;
  /** Secondary line with supporting metadata (e.g. model name). */
  description?: string;
}

/**
 * Compact model chooser for prompt bars (GlideSelect interaction pattern,
 * adapted to Prism's archetypes and lucide-free — the chevron/check are CSS).
 *
 * A real combobox: Enter/Space or arrows open the popover, arrows + Home/End +
 * type-ahead move the active row, Enter/Space pick, Escape dismisses. The menu
 * is portalled and flips above the trigger when the prompt bar sits at the
 * bottom of a clipped panel.
 */
export function ModelPicker({ options, value, onChange, label = 'Chat model', placeholder = 'Select a model', unavailableLabel = 'Model unavailable', align = 'start', className = '', disabled=false }: {
  disabled?:boolean;
  options: ModelPickerOption[];
  /** Selected option value. Unknown values render as unavailable, never crash. */
  value: string;
  onChange: (value: string) => void | Promise<unknown>;
  /** Accessible name of the trigger. */
  label?: string;
  placeholder?: string;
  unavailableLabel?: string;
  /** Menu alignment against the trigger edge. */
  align?: 'start' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending,setPending]=useState(false);const [error,setError]=useState('');const saving=useRef(false);
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: '', at: 0 });
  const id = useId();
  const selected = options.find((o) => o.value === value);
  const selectedIndex = options.findIndex((o) => o.value === value);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  }, []);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openMenu = useCallback((fromKeyboard: boolean) => {
    place();
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
    if (fromKeyboard) requestAnimationFrame(() => menuRef.current?.focus({ preventScroll: true }));
  }, [place, selectedIndex]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
    const onResize = () => close(false);
    const onScroll = (e: Event) => {
      const target = e.target;
      const trigger = triggerRef.current;
      // Only scrolling an ancestor can move the trigger away from its portal.
      // Other panels and the menu itself have independent scroll positions.
      if (trigger && target instanceof Node && target.contains(trigger)) close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);

  const pick = async (index: number) => {
    const option = options[index];
    if (disabled || !option || saving.current) return;
    saving.current=true;setPending(true);setError('');
    try { if (option.value !== value) await onChange(option.value);close(true); } catch(e) {setError(String(e));} finally {saving.current=false;setPending(false);}
  };

  const move = (index: number) => {
    if (!options.length) return;
    const next=Math.min(options.length - 1, Math.max(0, index));setActive(next);document.getElementById(`${id}-${next}`)?.scrollIntoView({block:'nearest'});
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(active - 1); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      const buffer = now - typeahead.current.at < 800 ? typeahead.current.text + e.key : e.key;
      typeahead.current = { text: buffer.toLowerCase(), at: now };
      const found = options.findIndex((o) => o.label.toLowerCase().startsWith(typeahead.current.text));
      if (found >= 0) move(found);
    }
  };

  const below = !!rect && (rect.bottom + 8 + Math.min(320,options.length * 40 + 16) <= window.innerHeight || window.innerHeight-rect.bottom>rect.top);
  const menu = open && rect ? createPortal(
    <div
      ref={menuRef}
      id={`${id}-list`}
      role="listbox"
      aria-label={label}
      aria-activedescendant={`${id}-${active}`}
      aria-busy={pending}
      tabIndex={-1}
      className="model-picker__menu"
      data-align={align}
      onKeyDown={onTriggerKeyDown}
      style={{
        left: Math.max(8,Math.min(align === 'end' ? rect.right-280 : rect.left,window.innerWidth-288)),
        width: Math.min(280,window.innerWidth-16),
        maxHeight: Math.max(40, Math.min(320, below ? window.innerHeight-rect.bottom-16 : rect.top-16)),
        top: below ? rect.bottom + 8 : rect.top - 8,
      }}
      data-below={below ? '' : undefined}
    >
      {options.map((option, index) => (
        <div
          key={option.value || '(default)'}
          id={`${id}-${index}`}
          role="option"
          aria-selected={option.value === value}
          data-active={index === active ? '' : undefined}
          className="model-picker__option"
          onPointerEnter={() => setActive(index)}
          onClick={() => pick(index)}
        >
          <span className="model-picker__check" aria-hidden="true" />
          <span className="model-picker__names">
            <span className="model-picker__name">{option.label}</span>
            {option.description ? <span className="model-picker__desc">{option.description}</span> : null}
          </span>
          {option.tag ? <span className="model-picker__tag">{option.tag}</span> : null}
        </div>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={rootRef} className={`model-picker${className ? ` ${className}` : ''}`}>
      <button
        disabled={disabled||pending}
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={label}
        className="model-picker__trigger"
        data-unavailable={value && !selected ? '' : undefined}
        onClick={() => (open ? close(false) : openMenu(false))}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="model-picker__current">{pending ? 'Saving…' : selected?.label ?? (value ? unavailableLabel : placeholder)}</span>
        <span className="model-picker__chevron" aria-hidden="true" />
      </button>
      {menu}
      {error&&<span className="model-picker__error" role="alert">{error}</span>}
    </div>
  );
}

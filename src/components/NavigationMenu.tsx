import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

/** Temporary navigation disclosure shared by workspace and Notebook tools. */
export function NavigationMenu<T extends string>({ label, activeLabel, value, items, onSelect, align = 'start' }: {
  label: string;
  align?: 'start' | 'end';
  activeLabel?: string;
  value: string;
  items: readonly { value: T; label: string }[];
  onSelect: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<'first' | 'last'>('first');
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    buttons?.[initialFocus.current === 'last' ? buttons.length - 1 : 0]?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div ref={root} className="relative shrink-0" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-muted hover:text-offwhite hover:bg-surface-hover"
      onClick={() => { initialFocus.current = 'first'; setOpen(v => !v); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'first';
          setOpen(true);
        }
      }}>
      {label}{activeLabel ? ` · ${activeLabel}` : ''}<ChevronDown aria-hidden="true" size={14}/>
    </button>
    {open && <div ref={menu} id={id} role="menu" aria-label={label}
      className={`absolute ${align === 'end' ? 'right-0' : 'left-0'} top-full z-50 mt-1 min-w-40 max-w-[calc(100vw-2rem)] rounded border border-border bg-base p-1 shadow-xl`}
      onKeyDown={event => {
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        let next: number | undefined;
        if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
        if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = buttons.length - 1;
        if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      }}>
      {items.map(item => <button key={item.value} type="button" role="menuitemradio" aria-checked={value === item.value}
        tabIndex={-1} className="flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-xs text-text-muted hover:bg-surface-hover focus:bg-surface-hover focus:text-offwhite"
        onClick={() => { onSelect(item.value); close(true); }}>
        {item.label}{value === item.value && <Check aria-hidden="true" size={14}/>}
      </button>)}
    </div>}
  </div>;
}

import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
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
  const [position,setPosition] = useState({top:0,left:0});
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
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => { const rect = trigger.current?.getBoundingClientRect(); if (rect) setPosition({ top: Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - (menu.current?.offsetHeight ?? 180) - 8)), left: Math.max(8, Math.min(align === 'end' ? rect.right - 200 : rect.left, window.innerWidth - 208)) }); };
    update();window.addEventListener('resize',update);window.addEventListener('scroll',update,true);
    return()=>{window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);};
  },[open,align]);
  useEffect(() => {
    if (!open) return;
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    buttons?.[initialFocus.current === 'last' ? buttons.length - 1 : 0]?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div ref={root} className="relative shrink-0" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !menu.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
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
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label={label}
      className="prism-navigation-menu" style={{position:'fixed',top:position.top,left:position.left}}
      onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null)&&!root.current?.contains(event.relatedTarget as Node|null))setOpen(false);}}
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
        tabIndex={-1} className="prism-navigation-item"
        onClick={() => { onSelect(item.value); close(true); }}>
        {item.label}{value === item.value && <Check aria-hidden="true" size={14}/>}
      </button>)}
    </div>,document.body)}
  </div>;
}

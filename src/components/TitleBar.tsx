import { openPdf } from '../services/research';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, Copy, X, FileText, Sparkles } from 'lucide-react';
import { NavigationMenu } from './NavigationMenu';
import { getAppIcon } from '../services/appIcon';

const isMacOS = navigator.userAgent.includes('Mac');

import type { AppPage as Layout } from '../types';

interface TitleBarProps {
  appIcon?: string;
  /** Current theme mode — used to swap white logos to grey in light mode. */
  themeMode?: 'dark' | 'light';
  layout: Layout;
  onLayoutChange: (layout: Layout) => void;
  showAI: boolean;
  onToggleAI: () => void;
  onNewNote: () => void;
  onNewFolder: () => void;
  onOpenPrism: () => void;
  onIngestContent: () => void;
  onSettings: () => void;
  onReload: () => void;
  onToggleIngestionLogs: () => void;
  onToggleSidebar: () => void;
  sidebarVisible: boolean;
}

interface MenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  divider?: boolean;
  disabled?: boolean;
}

/**
 * Single-row title bar: menu labels → view tabs → spacer → AI toggle → window controls.
 * Clicking a menu label opens its dropdown; hovering another label while open
 * switches directly (macOS-style).
 */
export const TitleBar: React.FC<TitleBarProps> = ({
  appIcon = '',
  themeMode = 'dark',
  layout,
  onLayoutChange,
  showAI,
  onToggleAI,
  onNewNote,
  onNewFolder,
  onOpenPrism,
  onIngestContent,
  onSettings,
  onReload,
  onToggleIngestionLogs,
  onToggleSidebar,
  sidebarVisible,
}) => {
  const [maximized, setMaximized] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const menuRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pendingMenuFocusRef = useRef<'first' | 'last' | null>(null);
  const appWindow = useMemo(() => getCurrentWindow(), []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const syncWindowShape = async () => {
      try {
        const [m, full] = await Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()]);
        if (!disposed) { setMaximized(m); document.documentElement.classList.toggle('window-edge-to-edge', m || full); }
      } catch { /* Browser preview has no native window. */ }
    };
    void syncWindowShape();
    appWindow.onResized(async () => {
      await syncWindowShape();
    }).then((fn: () => void) => { unlisten = fn; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, [appWindow]);

  const closeMenu = useCallback(() => setOpenMenu(null), []);

  // Close on outside click
  useEffect(() => {
    if (!openMenu) return;
    const h = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) closeMenu();
    };
    window.addEventListener('mousedown', h, true);
    return () => window.removeEventListener('mousedown', h, true);
  }, [openMenu, closeMenu]);

  // Global keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // App-wide shortcuts must not fire behind a modal surface (native
      // <dialog> or the Settings/icon-preview overlays).
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      const k = e.key.toLowerCase();
      if (k === ',' && !e.shiftKey) { e.preventDefault(); onSettings(); }
      if (k === 'n' && !e.shiftKey) { e.preventDefault(); onNewNote(); }
      if (k === 'n' && e.shiftKey) { e.preventDefault(); onNewFolder(); }
      if (k === 'o' && !e.shiftKey) { e.preventDefault(); onOpenPrism(); }
      if (k === 'i' && e.shiftKey) { e.preventDefault(); onIngestContent(); }
      if (k === '1') { e.preventDefault(); onLayoutChange('editor'); }
      if (k === '2') { e.preventDefault(); onLayoutChange('graph'); }
      if (k === '3') { e.preventDefault(); onLayoutChange('topics'); }
      if (k === '5') { e.preventDefault(); onLayoutChange('notebook'); }
      if (k === '4') { e.preventDefault(); onLayoutChange('split'); }
      if (k === 'a' && e.shiftKey) { e.preventDefault(); onToggleAI(); }
      if (k === 's' && e.shiftKey) { e.preventDefault(); onToggleSidebar(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onSettings, onNewNote, onNewFolder, onOpenPrism, onIngestContent, onLayoutChange, onToggleAI, onToggleSidebar]);

  const menus: Record<string, { label: string; items: MenuItem[] }> = {
    prism: {
      label: 'Prism',
      items: [
        { label: 'Settings…', shortcut: 'Ctrl+,', action: () => { onSettings(); closeMenu(); } },
        { label: 'Reload App', action: () => { onReload(); closeMenu(); } },
      ],
    },
    file: {
      label: 'File',
      items: [
        { label: 'New Note', shortcut: 'Ctrl+N', action: () => { onNewNote(); closeMenu(); } },
        { label: 'New Folder', shortcut: 'Ctrl+Shift+N', action: () => { onNewFolder(); closeMenu(); } },
        { divider: true, label: '' },
        { label: 'Open a Prism…', shortcut: 'Ctrl+O', action: () => { onOpenPrism(); closeMenu(); } },
        { divider: true, label: '' },
        { label: 'Open PDF…', action: () => { onLayoutChange('editor'); openPdf(); closeMenu(); } },
        { label: 'Import content…', shortcut: 'Ctrl+Shift+I', action: () => { onIngestContent(); closeMenu(); } },
      ],
    },
    edit: {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', action: () => { document.execCommand('undo'); closeMenu(); } },
        { label: 'Redo', shortcut: 'Ctrl+Shift+Z', action: () => { document.execCommand('redo'); closeMenu(); } },
        { divider: true, label: '' },
        { label: 'Cut', shortcut: 'Ctrl+X', action: () => { document.execCommand('cut'); closeMenu(); } },
        { label: 'Copy', shortcut: 'Ctrl+C', action: () => { document.execCommand('copy'); closeMenu(); } },
        { label: 'Paste', shortcut: 'Ctrl+V', action: () => { document.execCommand('paste'); closeMenu(); } },
        { divider: true, label: '' },
        { label: 'Select All', shortcut: 'Ctrl+A', action: () => { document.execCommand('selectAll'); closeMenu(); } },
        { label: 'Find…', shortcut: 'Ctrl+F', action: () => { closeMenu(); } },
      ],
    },
    view: {
      label: 'View',
      items: [
        { label: 'Notes', shortcut: 'Ctrl+1', action: () => { onLayoutChange('editor'); closeMenu(); }, disabled: layout === 'editor' },
        { label: 'Graph', shortcut: 'Ctrl+2', action: () => { onLayoutChange('graph'); closeMenu(); }, disabled: layout === 'graph' },
        { label: 'Topics', shortcut: 'Ctrl+3', action: () => { onLayoutChange('topics'); closeMenu(); }, disabled: layout === 'topics' },
        { label: 'Notebook', shortcut: 'Ctrl+5', action: () => { onLayoutChange('notebook'); closeMenu(); }, disabled: layout === 'notebook' },
        { divider: true, label: '' },
        { label: 'Ingestion Logs', action: () => { onToggleIngestionLogs(); closeMenu(); } },
        { divider: true, label: '' },
        { label: `${showAI ? 'Hide' : 'Show'} AI assistant`, shortcut: 'Ctrl+Shift+A', action: () => { onToggleAI(); closeMenu(); } },
        { label: `${sidebarVisible ? 'Hide' : 'Show'} Sidebar`, shortcut: 'Ctrl+Shift+S', action: () => { onToggleSidebar(); closeMenu(); } },
      ],
    },
  };

  const menuOrder = ['prism', 'file', 'edit', 'view'] as const;

  const menuItemsFor = (key: string): HTMLElement[] => {
    const menu = menuRefs.current[key];
    if (!menu) return [];
    return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
  };

  const openMenuAt = (key: string, focus: 'first' | 'last' = 'first') => {
    pendingMenuFocusRef.current = focus;
    setOpenMenu(key);
  };

  // Move focus into the menu after it renders. Click, keyboard and
  // hover-switching while the menubar is already open all land on a menu item,
  // so arrow keys keep working without a second click.
  useEffect(() => {
    if (!openMenu) return;
    const focus = pendingMenuFocusRef.current;
    if (!focus) return;
    pendingMenuFocusRef.current = null;
    const items = menuItemsFor(openMenu);
    const target = focus === 'last' ? items[items.length - 1] : items[0];
    target?.focus();
  }, [openMenu]);

  const restoreTriggerFocus = (key: string) => {
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) {
        triggerRefs.current[key]?.focus();
      }
    });
  };

  const handleMenuTriggerKeyDown = (event: React.KeyboardEvent, key: string) => {
    const isOpen = openMenu === key;
    switch (event.key) {
      case 'Enter':
      case ' ':
      case 'ArrowDown':
        event.preventDefault();
        if (isOpen) {
          menuItemsFor(key)[0]?.focus();
        } else {
          openMenuAt(key, 'first');
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (isOpen) {
          menuItemsFor(key)[menuItemsFor(key).length - 1]?.focus();
        } else {
          openMenuAt(key, 'last');
        }
        break;
      case 'Escape':
        if (isOpen) {
          event.preventDefault();
          closeMenu();
          triggerRefs.current[key]?.focus();
        }
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        event.preventDefault();
        const index = menuOrder.indexOf(key as (typeof menuOrder)[number]);
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        const nextKey = menuOrder[(index + delta + menuOrder.length) % menuOrder.length];
        triggerRefs.current[nextKey]?.focus();
        if (isOpen) openMenuAt(nextKey, 'first');
        break;
      }
    }
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent, key: string) => {
    const items = menuItemsFor(key);
    if (!items.length) return;
    const current = document.activeElement as HTMLElement | null;
    const index = current ? items.indexOf(current) : -1;
    let nextIndex: number | null = null;

    switch (event.key) {
      case 'ArrowDown':
        nextIndex = index < 0 ? 0 : (index + 1) % items.length;
        break;
      case 'ArrowUp':
        nextIndex = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = items.length - 1;
        break;
      case 'Escape':
        event.preventDefault();
        closeMenu();
        triggerRefs.current[key]?.focus();
        return;
      case 'ArrowRight':
      case 'ArrowLeft': {
        event.preventDefault();
        const menuIndex = menuOrder.indexOf(key as (typeof menuOrder)[number]);
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        const nextKey = menuOrder[(menuIndex + delta + menuOrder.length) % menuOrder.length];
        openMenuAt(nextKey, 'first');
        return;
      }
      case 'Tab':
        // Let Tab leave the menu naturally; the menu closes on the way out.
        closeMenu();
        return;
      default:
        return;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      items[nextIndex]?.focus();
    }
  };

  const activateMenuItem = (item: MenuItem, key: string) => {
    if (item.disabled) return;
    item.action?.();
    // If the command did not move focus (e.g. Undo/Copy), return it to the
    // trigger. Navigation commands that focus an editor/dialog are left alone.
    restoreTriggerFocus(key);
  };

  const secondaryViews = [
    { value: 'graph', label: 'Graph' },
    { value: 'topics', label: 'Topics' },
    { value: 'notebook', label: 'Notebook' },
  ] as const;

  return (
    <div ref={barRef} data-tauri-drag-region data-material="chrome" className="liquid-gloss-header relative flex items-center h-9 bg-base shrink-0 select-none z-40 rounded-none">
      {/* ── macOS: left-side traffic lights (in-app approximation until the
             Tauri window can opt into native macOS chrome). ── */}
      {isMacOS && (
        <div className="mac-window-controls flex items-center gap-3 pl-3 pr-1 h-full shrink-0" aria-label="Window controls">
          <button type="button" onClick={() => appWindow.close()} title="Close" aria-label="Close window" className="mac-window-control mac-window-close rounded-full">
            <span aria-hidden="true">×</span>
          </button>
          <button type="button" onClick={() => appWindow.minimize()} title="Minimize" aria-label="Minimize window" className="mac-window-control mac-window-minimize rounded-full">
            <span aria-hidden="true">−</span>
          </button>
          <button type="button" onClick={() => appWindow.toggleMaximize()} title={maximized ? 'Restore' : 'Zoom'} aria-label={maximized ? 'Restore window' : 'Zoom window'} className="mac-window-control mac-window-maximize rounded-full">
            <span aria-hidden="true">{maximized ? '−' : '+'}</span>
          </button>
        </div>
      )}

      {/* ── Icon + app name ── */}
      <div
        data-tauri-drag-region
        className={`flex items-center h-full gap-1.5 cursor-default ${isMacOS ? 'pl-1' : 'pl-3'}`}
      >
        <img src={getAppIcon(appIcon, themeMode)} alt="" className="w-6 h-6 shrink-0 pointer-events-none object-contain" />

      </div>

      {/* ── Windows/Linux: menu bar ── */}
      {!isMacOS && (
        <>
          <div role="menubar" aria-label="Application menu" className="flex items-center">
            {menuOrder.map((key) => {
              const { label, items } = menus[key];
              const menuId = `titlebar-menu-${key}`;
              return (
                <div key={key} className="relative">
                  <button
                    ref={(el) => { triggerRefs.current[key] = el; }}
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={openMenu === key}
                    aria-controls={menuId}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (openMenu === key) {
                        closeMenu();
                        triggerRefs.current[key]?.focus();
                      } else {
                        openMenuAt(key, 'first');
                      }
                    }}
                    onMouseEnter={() => { if (openMenu && openMenu !== key) openMenuAt(key, 'first'); }}
                    onKeyDown={(e) => handleMenuTriggerKeyDown(e, key)}
                    className={`h-9 px-2 flex items-center text-[12px] transition-colors border-none bg-transparent titlebar-menu focus-visible:bg-surface-hover ${
                      openMenu === key
                        ? 'text-offwhite'
                        : 'text-text-muted hover:text-offwhite'
                    }`}
                  >
                    {label}
                  </button>

                  {openMenu === key && (
                    <div
                      id={menuId}
                      ref={(el) => { menuRefs.current[key] = el; }}
                      role="menu"
                      aria-label={label}
                      data-material="popover"
                      onKeyDown={(e) => handleMenuKeyDown(e, key)}
                      className="titlebar-menu-popover gloss-dropdown-surface absolute top-full left-0 min-w-[220px] py-1 z-50"
                    >
                      {items.map((item, i) =>
                        item.divider ? (
                          <div key={i} role="separator" aria-orientation="horizontal" className="my-1 border-t border-border" />
                        ) : (
                          <button
                            key={i}
                            type="button"
                            role="menuitem"
                            tabIndex={-1}
                            disabled={item.disabled}
                            onClick={() => activateMenuItem(item, key)}
                            className={`w-full px-3 py-1 flex items-center justify-between gap-6 text-left text-[12px] transition-colors titlebar-menu-dropdown focus:bg-brand-500/20 focus:text-offwhite ${
                              item.disabled ? 'text-text-muted/50 cursor-default' : 'text-slate-300 hover:bg-brand-500/20 hover:text-offwhite'
                            }`}
                          >
                            <span>{item.label}</span>
                            {item.shortcut && <span className="text-xs text-text-muted ml-4 whitespace-nowrap">{item.shortcut}</span>}
                          </button>
                        )
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div aria-hidden="true" className="mx-1 w-px h-4 bg-border pointer-events-none" />
        </>
      )}

      <div className="flex items-center gap-0.5 shrink-0">
        <button type="button" onClick={() => onLayoutChange('editor')} aria-pressed={layout === 'editor' || layout === 'split'}
          className={`titlebar-toggle flex items-center gap-1 rounded px-2 py-1 text-xs ${layout === 'editor' ? 'bg-surface text-brand-400' : 'text-text-body hover:text-offwhite hover:bg-surface-hover'}`}>
          <FileText aria-hidden="true" className="w-3.5 h-3.5"/>Notes
        </button>
        <NavigationMenu label="More" value={layout} items={secondaryViews}
          activeLabel={layout === 'split' ? 'Graph' : secondaryViews.find(view => view.value === layout)?.label} onSelect={onLayoutChange}/>
      </div>

      {/* ── Spacer (drag region) ── */}
      <div className="flex-1" data-tauri-drag-region />

      {/* ── AI toggle (star icon) ── */}
      <button
        onClick={onToggleAI}
        title="AI assistant"
        aria-label="AI assistant"
        aria-pressed={showAI}
        className={`titlebar-action mr-1 p-1.5 rounded transition-colors ${
          showAI ? 'text-brand-400 bg-brand-600/10' : 'text-text-body hover:text-offwhite hover:bg-surface-hover'
        }`}
      >
        <Sparkles className="w-3.5 h-3.5" />
      </button>

      {/* ── Windows/Linux window controls ── */}
      {!isMacOS && (
        <div className="titlebar-window-controls flex items-center h-full shrink-0">
          <button onClick={() => appWindow.minimize()} title="Minimize" className="titlebar-window-control w-11 h-full flex items-center justify-center text-text-muted hover:text-offwhite hover:bg-surface-hover transition-colors">
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => appWindow.toggleMaximize()} title={maximized ? 'Restore' : 'Maximize'} className="titlebar-window-control w-11 h-full flex items-center justify-center text-text-muted hover:text-offwhite hover:bg-surface-hover transition-colors">
            {maximized ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
          </button>
          <button onClick={() => appWindow.close()} title="Close" className="titlebar-window-control titlebar-close-control w-11 h-full flex items-center justify-center text-text-muted hover:text-white hover:bg-[#E81123] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
};

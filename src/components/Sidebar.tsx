import { JobsButton } from './RuntimeActivity';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Folder, FolderOpen, FolderPlus, FolderMinus, Plus, Search, FileText, Trash2, Edit3,
  RefreshCw, Terminal, Settings, ChevronRight, Play, PanelLeftClose,
  ArrowUp, ArrowDown, TerminalSquare, Pencil, MoreHorizontal
} from 'lucide-react';
import { NoteFile, tauriAPI } from '../types';
import { useIngestion } from '../services/ingestionStore';
import { knowledge, type SearchPage } from '../services/knowledge';
import { getAppIcon } from '../services/appIcon';

interface SidebarProps {
  notes: NoteFile[];
  /** Every folder under the vault (POSIX-style relative paths), including
   *  empty ones — used to render folders that hold no notes yet. */
  folders: string[];
  reveal?:{path:string;ts:number}|null;
  onSelectFolder?:(path:string)=>void;
  activeNote: NoteFile | null;
  onSelectNote: (note: NoteFile) => void;
  /** Double-click a note to open it in the full editor panel. */
  onOpenNote: (note: NoteFile) => void;
  onNoteMenu: (note: NoteFile, trigger: HTMLButtonElement) => void;
  /** Free-form status line beside the logo; {date}/{time} tokens supported. */
  statusText?: string;
  /** Custom app icon id from the rainbow logo registry (empty = default). */
  appIcon?: string;
  /** Current theme mode — used to swap white logos to grey in light mode. */
  themeMode?: 'dark' | 'light';
  onNewNote: () => void;
  onNewFolder: () => void;
  /** Delete a folder (and everything inside it). Receives the folder's
   *  POSIX-style relative path (e.g. `Projects/Book`). */
  onDeleteFolder: (folderPath: string) => void;
  onDeleteNote: (note: NoteFile) => void;
  onRenameNote: (note: NoteFile) => void;
  onMoveNote: (note: NoteFile, direction: 'up' | 'down') => void;
  /** Move a note into a target folder; empty target means the vault root. */
  onMoveNoteToFolder: (note: NoteFile, targetFolder: string) => void;
  /** Move a folder into a target folder; empty target means the vault root. */
  onMoveFolderToFolder: (folderPath: string, targetFolder: string) => void;
  vaultPath: string;
  onSelectVault: () => void;
  onRefresh: () => void;
  onRunIngest: () => void;
  isIngesting: boolean;
  onOpenSettings: () => void;
  onCollapse: () => void;
}

/** A single folder in the sidebar tree. */
interface FolderNode {
  name: string;
  /** POSIX-style relative path of this folder (e.g. `Projects/Book`). */
  relativePath: string;
  children: FolderNode[];
  notes: NoteFile[];
}

const EXPANDED_KEY = 'prism_expanded_folders';

function countNotes(folder: FolderNode): number {
  return folder.notes.length + folder.children.reduce((n, c) => n + countNotes(c), 0);
}

/** Groups notes into a nested folder tree. `onDiskFolders` (POSIX-style
 *  relative paths, incl. empty ones) seed the tree first so folders without
 *  any notes still render; notes are then dropped into their folder chain.
 *  Notes sitting directly in the vault root come back as `rootNotes`. */
function buildFolderTree(
  notes: NoteFile[],
  onDiskFolders: string[]
): { rootNotes: NoteFile[]; folders: FolderNode[] } {
  const folderMap = new Map<string, FolderNode>();
  const rootNotes: NoteFile[] = [];

  // Create a node for a folder path (and every ancestor), returning it.
  const ensureFolder = (path: string): FolderNode => {
    let node = folderMap.get(path);
    if (node) return node;
    const slashIdx = path.lastIndexOf('/');
    const name = slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
    node = { name, relativePath: path, children: [], notes: [] };
    folderMap.set(path, node);
    if (slashIdx >= 0) {
      ensureFolder(path.slice(0, slashIdx)).children.push(node);
    }
    return node;
  };

  // 1. Seed folders straight from disk (empty folders included).
  for (const f of onDiskFolders) {
    ensureFolder(f);
  }

  // 2. Drop each note into its folder chain.
  for (const note of notes) {
    const rel = note.relativePath.replace(/\\/g, '/');
    const parts = rel.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;
    // No folder segments left after the filename → the note sits directly in
    // the vault root (e.g. `relativePath === "note.md"`).
    if (parts.length === 0) {
      rootNotes.push(note);
      continue;
    }
    ensureFolder(parts.join('/')).notes.push(note);
  }

  const folders = Array.from(folderMap.values())
    .filter((f) => !f.relativePath.includes('/'))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Nested children were pushed in discovery order; sort them for a stable UI.
  const sortRecursive = (f: FolderNode) => {
    f.children.sort((a, b) => a.name.localeCompare(b.name));
    f.children.forEach(sortRecursive);
  };
  folders.forEach(sortRecursive);

  return { rootNotes, folders };
}

export const Sidebar: React.FC<SidebarProps> = ({
  notes,
  folders: foldersProp, reveal, onSelectFolder,
  activeNote,
  onSelectNote,
  onOpenNote, onNoteMenu,
  statusText = '',
  appIcon = '',
  themeMode = 'dark',
  onNewNote,
  onNewFolder,
  onDeleteFolder,
  onDeleteNote,
  onRenameNote,
  onMoveNote,
  onMoveNoteToFolder,
  onMoveFolderToFolder,
  vaultPath,
  onSelectVault,
  onRefresh,
  onRunIngest,
  isIngesting,
  onOpenSettings,
  onCollapse,
}) => {
  const [search, setSearch] = useState('');
  const { isMinimized, setMinimized, isHidden, setHidden, progress } = useIngestion();

  // Live status line beside the logo ({date}/{time} tokens). Only ticks when
  // the configured text actually uses the time token.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!statusText.includes('{time}')) return;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [statusText]);
  const statusLine = useMemo(() => {
    if (!statusText.trim()) return null;
    return statusText
      .replace('{date}', now.toLocaleDateString())
      .replace('{time}', now.toLocaleTimeString());
  }, [statusText, now]);

  // Collapsed folder set (relative paths), persisted so the tree reopens the
  // way it was left. Default: all folders expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]'));
    } catch {
      return new Set();
    }
  });
  useEffect(()=>{if(!reveal)return;setCollapsed(previous=>new Set([...previous].filter(path=>path!==reveal.path&&!reveal.path.startsWith(path+'/'))));requestAnimationFrame(()=>{document.querySelectorAll<HTMLElement>('[data-folder-path]').forEach(el=>{if(el.dataset.folderPath===reveal.path){el.scrollIntoView({block:'nearest'});el.focus();}});});},[reveal?.ts]);
  const toggleFolder = (relativePath: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(relativePath)) next.delete(relativePath);
      else next.add(relativePath);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // Storage unavailable — collapse state just won't persist this time.
      }
      return next;
    });
  };

  // Create-menu (the + button) dropdown state + outside-click/Escape close.
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!createMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) {
        setCreateMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCreateMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [createMenuOpen]);

  // Toggle the log window: hidden → open expanded; minimized (badge) → expand;
  // fully expanded → vanish.
  const toggleLogs = () => {
    if (isHidden) {
      setHidden(false);
      setMinimized(false);
    } else if (isMinimized) {
      setMinimized(false);
    } else {
      setHidden(true);
    }
  };

  const [searchResult, setSearchResult] = useState<SearchPage | null>(null);
  const [searchError, setSearchError] = useState('');
  const searchRevision = useRef(0);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    let cancelled = false;
    ++searchRevision.current; setLoadingMore(false);
    setSearchResult(null); setSearchError('');
    if (!search.trim()) return;
    const timer = window.setTimeout(() => {
      void knowledge.search(search).then(result => { if (!cancelled) setSearchResult(result); })
        .catch(error => { if (!cancelled) setSearchError(String(error)); });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [search, notes]);
  const filteredNotes = useMemo(() => {
    if (!search.trim()) return notes;
    const byPath = new Map(notes.map(note => [note.path, note]));
    return (searchResult?.items ?? []).flatMap(hit => {
      const note = byPath.get(hit.path); return note ? [note] : [];
    });
  }, [notes, search, searchResult]);

  const { rootNotes, folders } = useMemo(
    () => buildFolderTree(notes, foldersProp),
    [notes, foldersProp]
  );

  // Pointer-based in-app dragging is used instead of HTML5 drag events. It
  // works consistently in Tauri's WebView and supports dropping onto folders
  // or the sidebar background to move an item to the vault root.
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const notesRef = useRef(notes);
  const moveNoteRef = useRef(onMoveNoteToFolder);
  const moveFolderRef = useRef(onMoveFolderToFolder);
  const pointerDragRef = useRef<{
    type: 'note' | 'folder';
    path: string;
    startX: number;
    startY: number;
    dragging: boolean;
    target: string | null;
  } | null>(null);
  const suppressClickRef = useRef(false);
  notesRef.current = notes;
  moveNoteRef.current = onMoveNoteToFolder;
  moveFolderRef.current = onMoveFolderToFolder;

  const startPointerDrag = (
    event: React.PointerEvent,
    item: { type: 'note' | 'folder'; path: string }
  ) => {
    const target = event.target;
    if (event.button !== 0 || (target instanceof Element && target.closest('button'))) return;
    pointerDragRef.current = {
      ...item,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      target: null,
    };
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag) return;
      if (!drag.dragging) {
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (distance < 6) return;
        drag.dragging = true;
        suppressClickRef.current = true;
        setDraggingPath(drag.path);
        document.body.style.userSelect = 'none';
      }

      event.preventDefault();
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const folder = element?.closest('[data-folder-drop-target]') as HTMLElement | null;
      const sidebar = element?.closest('[data-region="sidebar"]');
      drag.target = folder?.dataset.folderDropTarget ?? (sidebar ? '' : null);
      setDragOverFolder(drag.target);
    };

    const handlePointerUp = () => {
      const drag = pointerDragRef.current;
      pointerDragRef.current = null;
      document.body.style.userSelect = '';
      setDragOverFolder(null);
      setDraggingPath(null);
      if (!drag?.dragging || drag.target === null) return;

      if (drag.type === 'note') {
        const note = notesRef.current.find((entry) => entry.path === drag.path);
        if (note) moveNoteRef.current(note, drag.target);
      } else {
        moveFolderRef.current(drag.path, drag.target);
      }
    };

    window.addEventListener('pointermove', handlePointerMove, { capture: true });
    window.addEventListener('pointerup', handlePointerUp, { capture: true });
    window.addEventListener('pointercancel', handlePointerUp, { capture: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerUp, true);
      document.body.style.userSelect = '';
      setDraggingPath(null);
    };
  }, []);

  const renderNote = (note: NoteFile, depth: number) => {
    const isActive = activeNote?.path === note.path;
    return (
      <div
        key={note.path}
        data-note-path={note.path}
        className={`sidebar-note-row group flex items-center justify-between text-xs px-3 py-2.5 rounded-lg transition-all ${
          draggingPath === note.path ? 'cursor-grabbing' : 'cursor-default'
        } ${
          isActive 
            ? 'sidebar-note-row-active bg-[var(--nb-card)] border-l-2 border-brand-400 text-[var(--nb-focus)] font-medium'
            : 'text-[var(--nb-secondary)] hover:text-[var(--nb-secondary)] hover:bg-brand-500/10'
        }`}
        style={{ paddingLeft: `min(${Math.min(depth, 4) * 12 + 12}px, max(12px, calc(100cqi - 160px)))` }}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          onSelectNote(note);
        }}
        onDoubleClick={() => onOpenNote(note)}
        onPointerDown={(e) => startPointerDrag(e, { type: 'note', path: note.path })}
        title="Double-click to open in the full editor; drag to move"
      >
        <div className="sidebar-note-content flex items-center gap-2 truncate flex-1 pr-2">
          <FileText className={`sidebar-note-icon w-4 h-4 shrink-0 ${isActive ? 'text-[var(--nb-focus)]' : 'text-[var(--nb-secondary)]'}`} />
          <span className="truncate">{note.title}</span>
        </div>

        {/* Note Hover Actions */}
        <div className="flex items-center gap-1.5 shrink-0 opacity-100 transition-opacity">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenNote(note);
            }}
            className="p-1 hover:bg-[var(--nb-card)] text-[var(--nb-secondary)] hover:text-[var(--nb-focus)] rounded transition-colors"
            title="Edit note (open in editor)"
            aria-label={`Edit ${note.title}`}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRenameNote(note);
            }}
            className="p-1 hover:bg-[var(--nb-card)] text-[var(--nb-secondary)] hover:text-[var(--nb-focus)] rounded transition-colors"
            data-secondary-action
            title="Rename Note"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDeleteNote(note);
            }}
            className="p-1 hover:bg-[var(--nb-card)] text-[var(--nb-secondary)] hover:text-rose-400 rounded transition-colors"
            data-secondary-action
            title="Delete Note"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button className="sidebar-compact-actions p-1 rounded" aria-label={`Actions for ${note.title}`} title="Note actions" aria-haspopup="menu"
            onClick={e => { e.stopPropagation(); onNoteMenu(note, e.currentTarget); }}><MoreHorizontal className="w-3.5 h-3.5" /></button>
        </div>
      </div>
    );
  };

  // Folder row: expand/collapse chevron, name, note count, and a delete
  // button in the pill (shown on hover) that removes the folder + contents.
  // Notes and folders are draggable; dropping onto a folder nests the item,
  // while dropping on the sidebar background moves it back to the vault root.
  const renderFolder = (folder: FolderNode, depth: number) => {
    const isCollapsed = collapsed.has(folder.relativePath);
    const total = countNotes(folder);
    return (
      <div key={folder.relativePath} data-folder-drop-target={folder.relativePath}>
        <div
          tabIndex={0}
          onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelectFolder?.(folder.relativePath);toggleFolder(folder.relativePath);}}}
          data-folder-path={folder.relativePath}
          className={`group flex items-center justify-between text-xs px-3 py-2 rounded-lg transition-all ${
            draggingPath === folder.relativePath ? 'cursor-grabbing' : 'cursor-default'
          } ${
            isCollapsed
              ? 'text-[var(--nb-secondary)] hover:text-[var(--nb-secondary)]'
              : 'text-[var(--nb-secondary)] hover:text-[var(--nb-secondary)] hover:bg-[var(--nb-card)]'
          } ${dragOverFolder === folder.relativePath ? 'ring-1 ring-brand-400 bg-brand-500/10' : ''}`}
          style={{ paddingLeft: `min(${Math.min(depth, 4) * 12 + 8}px, max(8px, calc(100cqi - 160px)))` }}
          onClick={() => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            onSelectFolder?.(folder.relativePath);
            toggleFolder(folder.relativePath);
          }}
          onPointerDown={(e) => startPointerDrag(e, { type: 'folder', path: folder.relativePath })}
          title={`${isCollapsed ? 'Expand' : 'Collapse'} ${folder.name}; drag to move or nest` }
        >
          <div className="flex items-center gap-1.5 truncate flex-1 pr-2">
            <ChevronRight
              className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                isCollapsed ? '' : 'rotate-90'
              }`}
            />
            {isCollapsed ? (
              <Folder className="w-4 h-4 shrink-0 text-[var(--nb-secondary)]" />
            ) : (
              <FolderOpen className="w-4 h-4 shrink-0 text-[var(--nb-focus)]" />
            )}
            <span className="truncate font-medium">{folder.name}</span>
            <span className="sidebar-secondary-label text-[10px] text-[var(--nb-secondary)] shrink-0 tabular-nums">
              {total} {total === 1 ? 'note' : 'notes'}
            </span>
          </div>

          {/* Folder Hover Actions — delete lives in the folder pill */}
          <div className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteFolder(folder.relativePath);
              }}
              className="p-1 hover:bg-[var(--nb-card)] text-[var(--nb-secondary)] hover:text-rose-400 rounded transition-colors"
              title={`Delete Folder "${folder.name}" (all contents)`}
            >
              <FolderMinus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {!isCollapsed && (
          <div>
            {folder.notes.map((note) => renderNote(note, depth + 1))}
            {folder.children.map((child) => renderFolder(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const showTree = search.trim() === '';

  return (
    <div
      data-region="sidebar"
      className={`sidebar w-full border-r border-[var(--nb-border)] bg-panel flex flex-col h-full select-none ${
        dragOverFolder === '' ? 'ring-1 ring-inset ring-brand-400/60' : ''
      }`}

    >
      {/* App Header */}
      <div className="sidebar-header p-4 border-b border-[var(--nb-border)] flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <img
            src={getAppIcon(appIcon, themeMode)}
            alt="Prism logo"
            className="w-[38px] h-[38px] shrink-0 object-contain"
          />
          {statusLine && (
            <p className="sidebar-status-copy text-[10px] text-[var(--nb-secondary)] leading-tight line-clamp-2">{statusLine}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onCollapse}
            className="sidebar-toolbar-button text-[var(--nb-secondary)] hover:text-[var(--nb-secondary)] hover:bg-[var(--nb-card)] p-1.5 rounded-lg transition-colors border border-transparent hover:border-[var(--nb-border)]"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
          <JobsButton />
          <button
            onClick={onOpenSettings}
            className="sidebar-toolbar-button text-[var(--nb-secondary)] hover:text-[var(--nb-secondary)] hover:bg-[var(--nb-card)] p-1.5 rounded-lg transition-colors border border-transparent hover:border-[var(--nb-border)] relative"
            title="Open Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Note Folder Info & Actions */}
      <div className="p-3 bg-[var(--nb-card)] border-b border-[var(--nb-border)] space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold text-[var(--nb-secondary)] uppercase tracking-wider"><span className="sidebar-secondary-label">Prism </span>Location</span>
          <button 
            onClick={onSelectVault}
            aria-label="Change vault folder"
            className="sidebar-pill-button gloss-text-button text-[10px] font-semibold text-[var(--nb-focus)] hover:text-[var(--nb-focus)] transition-colors flex items-center gap-1"
          >
            <FolderOpen className="w-3 h-3" /> <span className="sidebar-secondary-label">Change</span>
          </button>
        </div>

        {vaultPath ? (
          <div 
            className="text-xs bg-[var(--nb-card)] border border-[var(--nb-border)] rounded px-2.5 py-1.5 text-[var(--nb-secondary)] font-mono truncate cursor-pointer hover:border-[var(--nb-border)] hover:text-[var(--nb-secondary)] transition-colors flex items-center gap-1.5"
            onClick={onSelectVault}
            aria-label="Change vault folder"
            title={vaultPath}
          >
            <ChevronRight className="w-3 h-3 text-[var(--nb-secondary)] shrink-0" />
            <span className="truncate">{vaultPath}</span>
          </div>
        ) : (
          <button 
            onClick={onSelectVault}
            aria-label="Change vault folder"
            className="sidebar-pill-button gloss-text-button w-full text-left text-xs bg-brand-950/30 hover:bg-brand-950/50 border border-brand-900/50 text-[var(--nb-focus)] rounded px-3 py-2 flex items-center justify-center gap-1.5 transition-all font-medium"
          >
            <FolderOpen className="w-4 h-4" /> Connect Note Folder
          </button>
        )}

        {/* Quick Sync / Ingestion controls */}
        {vaultPath && (
          <div className="flex gap-2 pt-1">
            <button
              onClick={onRefresh}
              className="sidebar-toolbar-button flex-1 bg-[var(--nb-card)] hover:bg-[var(--nb-card)] text-[var(--nb-secondary)] hover:text-[var(--nb-secondary)] border border-[var(--nb-border)] rounded p-1.5 flex items-center justify-center transition-colors"
              title="Sync / Refresh Notes"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={toggleLogs}
              className="sidebar-toolbar-button flex-1 bg-[var(--nb-card)] hover:bg-[var(--nb-card)] text-[var(--nb-secondary)] hover:text-[var(--nb-focus)] border border-[var(--nb-border)] rounded p-1.5 flex items-center justify-center transition-colors relative"
              title="Open / close ingestion logs"
            >
              <TerminalSquare className="w-4 h-4" />
              {/* Status dot mirrors the logs window's progress-bar color:
                  emerald = completed, rose = error, orange = ingesting, slate = idle */}
              <span
                className={`absolute top-0.5 right-1.5 w-2 h-2 rounded-full border border-[var(--nb-border)] ${
                  progress.status === 'completed'
                    ? 'bg-emerald-400'
                    : progress.status === 'error'
                      ? 'bg-rose-400'
                      : progress.status === 'ingesting'
                        ? 'bg-brand-400 animate-pulse'
                        : 'bg-[var(--nb-card)]'
                }`}
              />
            </button>
            <button
              onClick={onRunIngest}
              disabled={isIngesting}
              className="sidebar-toolbar-button flex-1 bg-surface hover:bg-surface-hover text-text-body disabled:bg-surface disabled:text-text-muted border border-border rounded p-1.5 flex items-center justify-center transition-colors"
              title={isIngesting ? "Importing..." : "Import content"}
            >
              {isIngesting ? (
                <RefreshCw className="w-4 h-4 animate-spin text-text-body" />
              ) : (
                <Play className="w-4 h-4 fill-current text-text-body" />
              )}
            </button>
          </div>
        )}
      </div>

      {/* Note Search & Creation */}
      <div className="p-3 flex gap-2 border-b border-[var(--nb-border)]">
        <div className="relative flex-1 min-w-0">
          <Search className="w-4 h-4 text-[var(--nb-secondary)] absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search notes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-[var(--nb-card)] hover:bg-[var(--nb-card)] border border-border focus:border-[var(--nb-border)] text-xs rounded-lg pl-8 pr-2.5 py-1.5 text-[var(--nb-secondary)] focus:outline-none transition-colors"
          />
        </div>
        {/* Single + button: dropdown between New Note and New Folder */}
        <div className="relative" ref={createMenuRef}>
          <button
            onClick={() => setCreateMenuOpen((o) => !o)}
            disabled={!vaultPath}
            className="bg-brand-500/10 hover:bg-brand-500/20 disabled:opacity-30 disabled:pointer-events-none text-[var(--nb-focus)] border border-brand-500/20 px-2 rounded-lg transition-all flex items-center justify-center h-full"
            title="Create"
          >
            <Plus className="w-4.5 h-4.5" />
          </button>
          {createMenuOpen && vaultPath && (
            <div className="gloss-dropdown-surface absolute right-0 top-full mt-1 z-50 w-44 py-1">
              <button
                onClick={() => {
                  setCreateMenuOpen(false);
                  onNewNote();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs font-medium text-[var(--nb-secondary)] hover:bg-brand-500/10 hover:text-[var(--nb-focus)] transition-colors"
              >
                <FileText className="w-3.5 h-3.5 text-[var(--nb-secondary)]" />
                New Note
              </button>
              <button
                onClick={() => {
                  setCreateMenuOpen(false);
                  onNewFolder();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs font-medium text-[var(--nb-secondary)] hover:bg-brand-500/10 hover:text-[var(--nb-focus)] transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5 text-[var(--nb-secondary)]" />
                New Folder
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Notes List */}
      <div className="sidebar-tree flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-2 space-y-1">
        {notes.length === 0 && folders.length === 0 ? (
          <div className="text-center text-xs text-[var(--nb-secondary)] py-8">
            {vaultPath 
              ? search 
                ? 'No notes match your search.' 
                : 'No notes found. Create a new one!'
              : 'Connect folder to load notes.'}
          </div>
        ) : showTree ? (
          <>
            {rootNotes.map((note) => renderNote(note, 0))}
            {folders.map((folder) => renderFolder(folder, 0))}
          </>
        ) : filteredNotes.length === 0 ? (
          <div className="text-center text-xs text-[var(--nb-secondary)] py-8">
            {searchError || searchResult?.degraded || (!searchResult ? 'Searching…' : 'No notes match your search.')}
          </div>
        ) : (
          <>
            {searchResult?.degraded && <p className="px-2 py-1 text-xs text-amber-300" role="status">{searchResult.degraded}</p>}
            {filteredNotes.map((note) => renderNote(note, 0))}
            {searchResult?.nextOffset != null && <button disabled={loadingMore} className="w-full p-2 text-xs underline" onClick={() => {
              const text = search; const revision = searchRevision.current; setLoadingMore(true);
              void knowledge.search(text, searchResult.nextOffset!).then(page => {
                if (revision === searchRevision.current) setSearchResult(previous => previous ? { ...page, items: [...previous.items, ...page.items] } : page);
              }).catch(e => {if (revision === searchRevision.current) setSearchError(String(e));}).finally(() => {if (revision === searchRevision.current) setLoadingMore(false);});
            }}>Load more results</button>}
          </>
        )}
      </div>
    </div>
  );
};

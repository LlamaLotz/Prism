import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Edit3,
  FileText,
  Folder,
  FolderMinus,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { NoteFile } from '../types';
import './VaultBranchedTree.css';

/** The folder shape built by Sidebar's `buildFolderTree`. */
export interface VaultFolderNode {
  name: string;
  relativePath: string;
  children: VaultFolderNode[];
  notes: NoteFile[];
}

type VaultRow =
  | { kind: 'note'; key: string; note: NoteFile }
  | { kind: 'folder'; key: string; folder: VaultFolderNode };

interface TreeHandlers {
  activeNote: NoteFile | null;
  /** Every ancestor folder of the active note, as vault-relative paths. */
  activeFolderPaths: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  draggingPath: string | null;
  dragOverFolder: string | null;
  suppressClickRef: React.RefObject<boolean>;
  onToggleFolder: (path: string) => void;
  onSelectFolder?: (path: string) => void;
  onSelectNote: (note: NoteFile) => void;
  onOpenNote: (note: NoteFile) => void;
  onNoteMenu: (note: NoteFile, trigger: HTMLButtonElement) => void;
  onDeleteFolder: (path: string) => void;
  onDeleteNote: (note: NoteFile) => void;
  onRenameNote: (note: NoteFile) => void;
  startPointerDrag: (
    event: React.PointerEvent,
    item: { type: 'note' | 'folder'; path: string },
  ) => void;
}

interface VaultBranchedTreeProps extends Omit<TreeHandlers, 'activeFolderPaths'> {
  rootNotes: NoteFile[];
  folders: VaultFolderNode[];
}

const ROW_HEIGHT = 30;
const INDENT = 18;
const TRUNK = 3;
const RADIUS = 7;
const MARK = 16;

function folderHasChildren(folder: VaultFolderNode): boolean {
  return folder.notes.length > 0 || folder.children.length > 0;
}

function countNotes(folder: VaultFolderNode): number {
  return folder.notes.length + folder.children.reduce((total, child) => total + countNotes(child), 0);
}

/** All ancestor folder paths of a note, e.g. `A/B/Note.md` -> `A`, `A/B`. */
function ancestorFolders(note: NoteFile | null): Set<string> {
  const paths = new Set<string>();
  if (!note) return paths;
  const parts = note.relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  parts.pop();
  let path = '';
  for (const part of parts) {
    path = path ? `${path}/${part}` : part;
    paths.add(path);
  }
  return paths;
}

function rowIsActive(
  row: VaultRow,
  activeNote: NoteFile | null,
  activeFolderPaths: ReadonlySet<string>,
): boolean {
  return row.kind === 'note'
    ? activeNote?.path === row.note.path
    : activeFolderPaths.has(row.folder.relativePath);
}

function NoteRow({
  note,
  active,
  rootActive,
  handlers,
}: {
  note: NoteFile;
  active: boolean;
  rootActive: boolean;
  handlers: TreeHandlers;
}) {
  const isDragging = handlers.draggingPath === note.path;
  return (
    <div
      className={`vb-row vb-note sidebar-note-row${active ? ' sidebar-note-row-active' : ''}${
        isDragging ? ' vb-row--dragging' : ''
      }`}
      data-note-path={note.path}
      data-active={active ? '' : undefined}
      data-branch-root-active={rootActive ? '' : undefined}
      aria-current={active ? 'page' : undefined}
      tabIndex={0}
      title="Double-click to open in the full editor; drag to move"
      onClick={() => {
        if (handlers.suppressClickRef.current) {
          handlers.suppressClickRef.current = false;
          return;
        }
        handlers.onSelectNote(note);
      }}
      onDoubleClick={() => handlers.onOpenNote(note)}
      onPointerDown={(event) => handlers.startPointerDrag(event, { type: 'note', path: note.path })}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (handlers.suppressClickRef.current) {
          handlers.suppressClickRef.current = false;
          return;
        }
        handlers.onSelectNote(note);
      }}
    >
      <FileText className="vb-icon" aria-hidden="true" />
      <span className="vb-label" title={note.title}>
        {note.title}
      </span>

      <div className="vb-actions">
        <button
          type="button"
          className="vb-action"
          title="Edit note (open in editor)"
          aria-label={`Edit ${note.title}`}
          onClick={(event) => {
            event.stopPropagation();
            if (handlers.suppressClickRef.current) {
              handlers.suppressClickRef.current = false;
              return;
            }
            handlers.onOpenNote(note);
          }}
        >
          <Pencil aria-hidden="true" />
        </button>
        <button
          type="button"
          className="vb-action"
          data-secondary-action
          title="Rename Note"
          aria-label={`Rename ${note.title}`}
          onClick={(event) => {
            event.stopPropagation();
            if (handlers.suppressClickRef.current) {
              handlers.suppressClickRef.current = false;
              return;
            }
            handlers.onRenameNote(note);
          }}
        >
          <Edit3 aria-hidden="true" />
        </button>
        <button
          type="button"
          className="vb-action vb-action--danger"
          data-secondary-action
          title="Delete Note"
          aria-label={`Delete ${note.title}`}
          onClick={(event) => {
            event.stopPropagation();
            if (handlers.suppressClickRef.current) {
              handlers.suppressClickRef.current = false;
              return;
            }
            handlers.onDeleteNote(note);
          }}
        >
          <Trash2 aria-hidden="true" />
        </button>
        <button
          type="button"
          className="vb-action sidebar-compact-actions"
          aria-label={`Actions for ${note.title}`}
          title="Note actions"
          aria-haspopup="menu"
          onClick={(event) => {
            event.stopPropagation();
            if (handlers.suppressClickRef.current) {
              handlers.suppressClickRef.current = false;
              return;
            }
            handlers.onNoteMenu(note, event.currentTarget);
          }}
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function FolderRow({
  folder,
  active,
  rootActive,
  handlers,
}: {
  folder: VaultFolderNode;
  active: boolean;
  rootActive: boolean;
  handlers: TreeHandlers;
}) {
  const hasChildren = folderHasChildren(folder);
  const isCollapsed = handlers.collapsed.has(folder.relativePath);
  const isOpen = hasChildren && !isCollapsed;
  const total = countNotes(folder);
  const isDropTarget = handlers.dragOverFolder === folder.relativePath;
  const isDragging = handlers.draggingPath === folder.relativePath;

  return (
    <div
      className={[
        'vb-row',
        'vb-folder',
        active ? 'vb-row--active' : '',
        isDropTarget ? 'vb-row--drop' : '',
        isDragging ? 'vb-row--dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-folder-path={folder.relativePath}
      data-open={isOpen ? '' : undefined}
      data-branch-root-active={rootActive ? '' : undefined}
      aria-expanded={hasChildren ? isOpen : undefined}
      tabIndex={0}
      title={`${isCollapsed ? 'Expand' : 'Collapse'} ${folder.name}; drag to move or nest`}
      onClick={() => {
        if (handlers.suppressClickRef.current) {
          handlers.suppressClickRef.current = false;
          return;
        }
        handlers.onSelectFolder?.(folder.relativePath);
        handlers.onToggleFolder(folder.relativePath);
      }}
      onPointerDown={(event) =>
        handlers.startPointerDrag(event, { type: 'folder', path: folder.relativePath })
      }
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (handlers.suppressClickRef.current) {
          handlers.suppressClickRef.current = false;
          return;
        }
        handlers.onSelectFolder?.(folder.relativePath);
        handlers.onToggleFolder(folder.relativePath);
      }}
    >
      {hasChildren ? (
        <ChevronRight className="vb-chevron" aria-hidden="true" />
      ) : (
        <span className="vb-chevron vb-chevron--empty" aria-hidden="true" />
      )}
      {isOpen ? (
        <FolderOpen className="vb-icon vb-icon--open" aria-hidden="true" />
      ) : (
        <Folder className="vb-icon" aria-hidden="true" />
      )}
      <span className="vb-label" title={folder.name}>
        {folder.name}
      </span>
      <span className="vb-count sidebar-secondary-label">
        {total} {total === 1 ? 'note' : 'notes'}
      </span>

      <div className="vb-actions">
        <button
          type="button"
          className="vb-action vb-action--danger"
          title={`Delete Folder "${folder.name}" (all contents)`}
          aria-label={`Delete folder ${folder.name}`}
          onClick={(event) => {
            event.stopPropagation();
            if (handlers.suppressClickRef.current) {
              handlers.suppressClickRef.current = false;
              return;
            }
            handlers.onDeleteFolder(folder.relativePath);
          }}
        >
          <FolderMinus aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

interface BranchGroupProps extends TreeHandlers {
  depth: number;
  folder?: VaultFolderNode;
  rootNotes?: NoteFile[];
  rootFolders?: VaultFolderNode[];
}

/**
 * One level of the branched tree. The SVG rail is measured from the rendered
 * rows, so nested folders can expand without corrupting the branch geometry.
 */
function BranchGroup({ depth, folder, rootNotes, rootFolders, ...handlers }: BranchGroupProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<{ height: number; centers: number[] }>({
    height: 0,
    centers: [],
  });

  const rows = useMemo<VaultRow[]>(() => {
    if (folder) {
      return [
        ...folder.notes.map((note) => ({ kind: 'note' as const, key: note.path, note })),
        ...folder.children.map((child) => ({
          kind: 'folder' as const,
          key: child.relativePath,
          folder: child,
        })),
      ];
    }
    return [
      ...(rootNotes ?? []).map((note) => ({ kind: 'note' as const, key: note.path, note })),
      ...(rootFolders ?? []).map((child) => ({
        kind: 'folder' as const,
        key: child.relativePath,
        folder: child,
      })),
    ];
  }, [folder, rootNotes, rootFolders]);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    let frame = 0;

    const measure = () => {
      frame = 0;
      const groupRect = group.getBoundingClientRect();
      const nodes = Array.from(group.children).filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child.classList.contains('vb-node'),
      );
      const centers = nodes.map((node) => {
        const row = node.firstElementChild;
        if (!(row instanceof HTMLElement)) return 0;
        const rect = row.getBoundingClientRect();
        return rect.top - groupRect.top + rect.height / 2;
      });
      const height = groupRect.height;
      setMetrics((previous) => {
        if (
          previous.height === height &&
          previous.centers.length === centers.length &&
          previous.centers.every((value, index) => Math.abs(value - centers[index]) < 0.25)
        ) {
          return previous;
        }
        return { height, centers };
      });
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(group);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rows, handlers.collapsed]);

  const { height, centers } = metrics;
  // The layout effect runs after render, so rows can briefly outnumber (or
  // undershoot) the previous measurement. Only draw pairs we know about.
  const visibleCenters = centers.slice(0, rows.length);
  const lastCenter = visibleCenters[visibleCenters.length - 1] ?? 0;
  const radius = Math.min(RADIUS, ROW_HEIGHT / 2 - 2);
  const endX = INDENT - 8;
  const branch = (center: number) =>
    `M ${TRUNK} ${center - radius} A ${radius} ${radius} 0 0 0 ${TRUNK + radius} ${center} H ${endX}`;
  const reach = (center: number) =>
    `M ${TRUNK} 0 V ${center - radius} A ${radius} ${radius} 0 0 0 ${TRUNK + radius} ${center} H ${endX}`;
  const reachLength = (center: number) =>
    center - radius + (Math.PI * radius) / 2 + (endX - TRUNK - radius);

  return (
    <div ref={groupRef} className="vb-group">
      {rows.length > 0 && (
        <svg className="vb-lines" width={INDENT} height={Math.max(0, height)} aria-hidden="true">
          <path className="vb-base" d={`M ${TRUNK} 0 V ${Math.max(0, lastCenter - radius)}`} />
          {visibleCenters.map((center, index) => (
            <path key={`base-${rows[index].key}`} className="vb-base" d={branch(center)} />
          ))}
          {visibleCenters.map((center, index) => {
            const active = rowIsActive(rows[index], handlers.activeNote, handlers.activeFolderPaths);
            const length = reachLength(center);
            return (
              <path
                key={`reach-${rows[index].key}`}
                className="vb-reach"
                d={reach(center)}
                style={{
                  strokeDasharray: length,
                  strokeDashoffset: active ? 0 : length,
                }}
              />
            );
          })}
        </svg>
      )}

      {rows.map((row) => {
        const active = rowIsActive(row, handlers.activeNote, handlers.activeFolderPaths);
        const rootActive = depth === 0 && active;
        if (row.kind === 'note') {
          return (
            <div className="vb-node" key={row.key}>
              <NoteRow note={row.note} active={active} rootActive={rootActive} handlers={handlers} />
            </div>
          );
        }

        const isCollapsed = handlers.collapsed.has(row.folder.relativePath);
        return (
          <div
            className="vb-node"
            key={row.key}
            data-open={folderHasChildren(row.folder) && !isCollapsed ? '' : undefined}
            data-folder-drop-target={row.folder.relativePath}
          >
            <FolderRow
              folder={row.folder}
              active={active}
              rootActive={rootActive}
              handlers={handlers}
            />
            {folderHasChildren(row.folder) && (
              <div
                className="vb-children"
                aria-hidden={isCollapsed || undefined}
                inert={isCollapsed || undefined}
              >
                <div className="vb-children-inner">
                  <BranchGroup {...handlers} folder={row.folder} depth={depth + 1} />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Liquid Gloss folder tree. BranchedMenu is deliberately a two-level menu; this
 * keeps its rail, branch, fold and trace motion while rendering the vault's
 * arbitrary-depth folder/note tree.
 */
export const VaultBranchedTree: React.FC<VaultBranchedTreeProps> = ({
  rootNotes,
  folders,
  ...treeHandlers
}) => {
  const navRef = useRef<HTMLElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const activeFolderPaths = useMemo(
    () => ancestorFolders(treeHandlers.activeNote),
    [treeHandlers.activeNote?.relativePath],
  );

  const handlers: TreeHandlers = { ...treeHandlers, activeFolderPaths };

  useLayoutEffect(() => {
    const nav = navRef.current;
    const marker = markerRef.current;
    if (!nav || !marker) return;
    let frame = 0;

    const place = (glide: boolean) => {
      const row = nav.querySelector<HTMLElement>('[data-branch-root-active]');
      if (!glide) marker.style.transition = 'none';
      if (row) {
        const navRect = nav.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        marker.style.top = `${rowRect.top - navRect.top + (rowRect.height - MARK) / 2}px`;
        marker.setAttribute('data-on', '');
      } else {
        marker.removeAttribute('data-on');
      }
      if (!glide) {
        void marker.offsetHeight;
        marker.style.transition = '';
      }
    };

    place(true);
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place(false);
      });
    });
    observer.observe(nav);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [treeHandlers.activeNote?.path, rootNotes, folders, treeHandlers.collapsed]);

  return (
    <nav ref={navRef} className="vault-branched" aria-label="Vault files">
      <span ref={markerRef} className="vb-marker" aria-hidden="true" />
      <BranchGroup {...handlers} rootNotes={rootNotes} rootFolders={folders} depth={0} />
    </nav>
  );
};

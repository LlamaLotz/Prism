import { withFolders } from '../services/folderGraph';
import { withTopics, type TopicGroup } from '../services/topicGraph';
import { buildGraphFocus, focusColor, type GraphFocus } from '../services/graphFocus';
import { linkerService } from '../services/linkerService';
import { listen } from '@tauri-apps/api/event';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Box, ChevronDown, Layers, Square, X } from 'lucide-react';
import { GraphView, setGraphPalette as setPalette2D } from './GraphView';
import { GraphView3D, setGraphPalette as setPalette3D } from './GraphView3D';
import { GraphNode, GraphLink, NoteFile } from '../types';

const GRAPH_MODE_KEY = 'prism_graph_mode';
const GRAPH_FOLDERS_KEY = 'prism_graph_folders';
const GRAPH_TOPICS_KEY = 'prism_graph_topics';

type ThemeStyle = 'industrial' | 'gloss';
type ThemeMode = 'dark' | 'light';

interface GraphViewContainerProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  folders?:string[];
  onSelectFolder?:(path:string)=>void;
  /** Optional hook for topic-node activation (FE-6 focus wiring). */
  onSelectTopic?:(tag:string)=>void;
  activeNote: NoteFile | null;
  onSelectNoteByTitle: (title: string) => void;
  backgroundPattern: 'grid' | 'mesh' | 'solid';
  defaultGraphMode: '2d' | '3d';
  persistNodePositions: boolean;
  autoRotateOnLoad: boolean;
  autoRotateSpeed: number;
  labelQuality: 'standard' | 'high';
  nodeColor: string;
  themeStyle: ThemeStyle;
  themeMode: ThemeMode;
}

/** Layers dropdown in the graph toolbar. Rows use native checkboxes so the
 *  menu can stay open while layers are toggled; outside pointerdown and Escape
 *  close it, and Escape returns focus to the trigger. */
const GraphShowMenu: React.FC<{
  showFolders: boolean;
  showTopics: boolean;
  onToggleFolders: (checked: boolean) => void;
  onToggleTopics: (checked: boolean) => void;
}> = ({ showFolders, showTopics, onToggleFolders, onToggleTopics }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const nonDefault = showTopics || !showFolders;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="graph-show-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="graph-show-trigger"
        title="Show graph layers"
        aria-label="Show graph layers"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Layers className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="graph-show-label">Show</span>
        <ChevronDown className="graph-show-chevron w-3 h-3 shrink-0" aria-hidden="true" />
        {nonDefault && <span className="graph-show-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div id={menuId} className="graph-show-menu-popup" role="menu" aria-label="Show graph layers">
          <label className="graph-show-row" role="menuitemcheckbox" aria-checked={showFolders}>
            <input
              type="checkbox"
              checked={showFolders}
              onChange={(event) => onToggleFolders(event.target.checked)}
            />
            <span>Folders</span>
          </label>
          <label className="graph-show-row" role="menuitemcheckbox" aria-checked={showTopics}>
            <input
              type="checkbox"
              checked={showTopics}
              onChange={(event) => onToggleTopics(event.target.checked)}
            />
            <span>Topics</span>
          </label>
        </div>
      )}
    </div>
  );
};

/**
 * Hosts the knowledge graph pane and its layer/mode controls. The 2D/3D
 * choice is persisted (prism_graph_mode) so the graph reopens in the same
 * mode. The controls live here so they can be injected into either graph
 * component's toolbar header (toolbarExtra) while the graph bodies stay
 * self-contained.
 */
export const GraphViewContainer: React.FC<GraphViewContainerProps> = ({
  graphData, folders=[], onSelectFolder, onSelectTopic,
  activeNote,
  onSelectNoteByTitle,
  backgroundPattern = 'grid',
  defaultGraphMode = '2d',
  persistNodePositions = true,
  autoRotateOnLoad = false,
  autoRotateSpeed = 0.67,
  labelQuality = 'high',
  nodeColor = '#38BDF8',
  themeStyle = 'industrial',
  themeMode = 'dark',
}) => {
  // Re-theme both graph palettes synchronously during every render — the
  // module-level let assignments are cheap and this guarantees that the
  // GraphView/GraphView3D effects (which read COLOR_ACTIVE etc.) always
  // see the correct color before their first D3/Three.js paint.
  //
  // A useRef guard was tried here but it backfired: on initial mount (or
  // remount from a key change) useRef is initialized WITH the current prop,
  // so the guard evaluates to false and the first setPalette call is skipped
  // entirely — the graph would paint in default orange before useEffect fired.
  setPalette2D(nodeColor);
  setPalette3D(nodeColor);
  // Open in the configured default mode; a user who explicitly picked a mode
  // before (key stored) keeps their choice.
  const [graphMode, setGraphMode] = useState<'2d' | '3d'>(
    () =>
      (localStorage.getItem(GRAPH_MODE_KEY) === '2d' ||
      localStorage.getItem(GRAPH_MODE_KEY) === '3d'
        ? localStorage.getItem(GRAPH_MODE_KEY)
        : defaultGraphMode) as '2d' | '3d'
  );

  const [showFolders, setShowFolders] = useState(
    () => localStorage.getItem(GRAPH_FOLDERS_KEY) !== 'false'
  );
  const [showTopics, setShowTopics] = useState(
    () => localStorage.getItem(GRAPH_TOPICS_KEY) === 'true'
  );
  const [topicGroups, setTopicGroups] = useState<TopicGroup[]>([]);
  const topicRequestRef = useRef(0);

  // Topic groups are only fetched while the layer is visible. Vault changes
  // and fresh graph snapshots trigger a refetch; stale responses are ignored
  // via a monotonically increasing request id.
  useEffect(() => {
    if (!showTopics) {
      topicRequestRef.current += 1;
      setTopicGroups([]);
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    const load = () => {
      const requestId = ++topicRequestRef.current;
      linkerService
        .getTopicGroups()
        .then((groups) => {
          if (disposed || requestId !== topicRequestRef.current) return;
          setTopicGroups(groups);
        })
        .catch((error) => {
          if (disposed || requestId !== topicRequestRef.current) return;
          console.error('Failed to load topic groups for graph:', error);
          setTopicGroups([]);
        });
    };

    load();
    listen('vault-changed', load)
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => console.error('Failed to listen for vault changes:', error));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [showTopics, graphData]);

  const data = useMemo(() => {
    const base = showFolders ? withFolders(graphData, folders) : graphData;
    return showTopics ? withTopics(base, topicGroups) : base;
  }, [graphData, folders, showFolders, showTopics, topicGroups]);

  // Focus is a graph-pane concern, not navigation: hovering a folder/topic hub
  // previews its connected set and clicking pins it. The state lives here so
  // switching between 2D and 3D keeps the same focus.
  const [pinnedFocusId, setPinnedFocusId] = useState<string | null>(null);
  const [hoverFocusId, setHoverFocusId] = useState<string | null>(null);

  const pinnedFocus = useMemo(
    () => (pinnedFocusId ? buildGraphFocus(data, pinnedFocusId) : null),
    [data, pinnedFocusId]
  );
  const hoverFocus = useMemo(
    () => (hoverFocusId ? buildGraphFocus(data, hoverFocusId) : null),
    [data, hoverFocusId]
  );
  const focus = useMemo(() => {
    const active = hoverFocus ?? pinnedFocus;
    if (!active) return null;
    // A hovered hub takes precedence, but hovering the pinned hub itself is
    // still a pinned focus (the chip keeps its clear action).
    const pinned = !!pinnedFocus && (!hoverFocus || hoverFocus.hubId === pinnedFocus.hubId);
    return { ...active, pinned };
  }, [hoverFocus, pinnedFocus]);

  const clearFocus = () => {
    setPinnedFocusId(null);
    setHoverFocusId(null);
  };

  const toggleFocus = (id: string) => {
    if (pinnedFocusId === id) {
      setPinnedFocusId(null);
      setHoverFocusId(null);
    } else {
      setPinnedFocusId(id);
    }
  };

  const handleHoverFocus = (id: string | null) => setHoverFocusId(id);

  // A focused layer/node can disappear when Folders or Topics is switched off
  // (or when a vault change removes it). Drop the stale focus immediately.
  useEffect(() => {
    const ids = new Set(data.nodes.map((node) => node.id));
    if (pinnedFocusId && !ids.has(pinnedFocusId)) setPinnedFocusId(null);
    if (hoverFocusId && !ids.has(hoverFocusId)) setHoverFocusId(null);
  }, [data, pinnedFocusId, hoverFocusId]);

  // Opening a note always returns the graph to its neutral state, whether the
  // note was opened from a graph node, the sidebar, or a wiki link.
  const activeNoteKey = activeNote?.path ?? activeNote?.relativePath ?? activeNote?.title ?? '';
  useEffect(() => {
    setPinnedFocusId(null);
    setHoverFocusId(null);
  }, [activeNoteKey]);

  // Escape clears focus without touching the force simulation or the camera.
  useEffect(() => {
    if (!pinnedFocusId && !hoverFocusId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      setPinnedFocusId(null);
      setHoverFocusId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pinnedFocusId, hoverFocusId]);

  const select = (id: string) => {
    const node = data.nodes.find((candidate) => candidate.id === id);
    if (node?.kind === 'folder') {
      // Folder activation focuses its subtree instead of opening a note. Keep
      // the existing sidebar reveal so the folder stays easy to find.
      toggleFocus(id);
      onSelectFolder?.(node.folderPath ?? '');
      return;
    }
    if (node?.kind === 'topic') {
      // Topic activation focuses the tag set; it must not open the Topics view
      // or trigger missing-note navigation.
      toggleFocus(id);
      onSelectTopic?.(node.tag ?? node.title.replace(/^@/, ''));
      return;
    }
    clearFocus();
    onSelectNoteByTitle(id);
  };

  const focusChip = focus ? (
    <div
      className="graph-focus-chip"
      data-graph-focus-chip
      data-graph-focus-kind={focus.kind}
      data-graph-focus-pinned={focus.pinned ? 'true' : 'false'}
    >
      <span
        className="graph-focus-dot"
        style={{ backgroundColor: focusColor(focus.kind) }}
        aria-hidden="true"
      />
      <span className="graph-focus-text">
        <span className="graph-focus-verb">{focus.pinned ? 'Focus' : 'Preview'}:</span>{' '}
        <span className="graph-focus-label" title={focus.label}>{focus.label}</span>
      </span>
      {focus.pinned && (
        <button
          type="button"
          className="graph-focus-clear"
          aria-label="Clear graph focus"
          title="Clear graph focus"
          onClick={clearFocus}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  ) : null;

  const switchMode = (mode: '2d' | '3d') => {
    setGraphMode(mode);
    localStorage.setItem(GRAPH_MODE_KEY, mode);
  };

  const toggleFolders = (checked: boolean) => {
    setShowFolders(checked);
    localStorage.setItem(GRAPH_FOLDERS_KEY, String(checked));
  };
  const toggleTopics = (checked: boolean) => {
    setShowTopics(checked);
    localStorage.setItem(GRAPH_TOPICS_KEY, String(checked));
  };

  const toggle = (
    <div className="graph-switcher">
      <GraphShowMenu
        showFolders={showFolders}
        showTopics={showTopics}
        onToggleFolders={toggleFolders}
        onToggleTopics={toggleTopics}
      />
      <div className="seg-control graph-mode-group" role="group" aria-label="Graph mode">
        <button
          type="button"
          className="seg-button"
          aria-label="2D Graph"
          title="2D Graph"
          aria-pressed={graphMode === '2d'}
          onClick={() => switchMode('2d')}
        >
          <Square size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="seg-button"
          aria-label="3D Graph"
          title="3D Graph"
          aria-pressed={graphMode === '3d'}
          onClick={() => switchMode('3d')}
        >
          <Box size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );

  return (
    <>
      {graphMode === '2d' ? (
        <GraphView
          graphData={data}
          activeNote={activeNote}
          onSelectNoteByTitle={select}
          toolbarExtra={toggle}
          backgroundPattern={backgroundPattern}
          persistNodePositions={persistNodePositions}
          themeMode={themeMode}
          nodeColor={nodeColor}
          focus={focus}
          pinnedFocusId={pinnedFocusId}
          onHoverFocus={handleHoverFocus}
          onClearFocus={clearFocus}
          focusOverlay={focusChip}
        />
      ) : (
        <GraphView3D
          graphData={data}
          activeNote={activeNote}
          onSelectNoteByTitle={select}
          toolbarExtra={toggle}
          backgroundPattern={backgroundPattern}
          autoRotateOnLoad={autoRotateOnLoad}
          autoRotateSpeed={autoRotateSpeed}
          labelQuality={labelQuality}
          nodeColor={nodeColor}
          themeStyle={themeStyle}
          themeMode={themeMode}
          focus={focus}
          pinnedFocusId={pinnedFocusId}
          onHoverFocus={handleHoverFocus}
          onClearFocus={clearFocus}
          focusOverlay={focusChip}
        />
      )}
      {/* Persistent live region: hover previews stay silent, while pinning or
          clearing a focus is announced once. Keeping it mounted across 2D/3D
          switches avoids re-announcing an unchanged pinned focus. */}
      <span className="sr-only" role="status" aria-live="polite" data-graph-focus-status>
        {pinnedFocus ? `Graph focus: ${pinnedFocus.label}` : ''}
      </span>
    </>
  );
};

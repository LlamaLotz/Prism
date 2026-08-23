import React, { useEffect, useState } from 'react';
import { GraphView, setGraphPalette as setPalette2D } from './GraphView';
import { GraphView3D, setGraphPalette as setPalette3D } from './GraphView3D';
import { GraphNode, GraphLink, NoteFile } from '../types';

const GRAPH_MODE_KEY = 'prism_graph_mode';

type ThemeStyle = 'industrial' | 'glass' | 'gloss';
type ThemeMode = 'dark' | 'light';

interface GraphViewContainerProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
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

/**
 * Hosts the knowledge graph pane and its 2D/3D mode switcher. The choice is
 * persisted (prism_graph_mode) so the graph reopens in the same mode. The
 * mode state lives here so the segmented control can be injected into either
 * graph component's toolbar header (toolbarExtra) while the graph bodies stay
 * self-contained.
 */
export const GraphViewContainer: React.FC<GraphViewContainerProps> = ({
  graphData,
  activeNote,
  onSelectNoteByTitle,
  backgroundPattern = 'grid',
  defaultGraphMode = '3d',
  persistNodePositions = true,
  autoRotateOnLoad = false,
  autoRotateSpeed = 0.67,
  labelQuality = 'high',
  nodeColor = '#FEB05D',
  themeStyle = 'industrial',
  themeMode = 'dark',
}) => {
  // Re-theme both graph palettes whenever the node color setting changes.
  useEffect(() => {
    setPalette2D(nodeColor);
    setPalette3D(nodeColor);
  }, [nodeColor]);
  // Open in the configured default mode; a user who explicitly picked a mode
  // before (key stored) keeps their choice.
  const [graphMode, setGraphMode] = useState<'2d' | '3d'>(
    () =>
      (localStorage.getItem(GRAPH_MODE_KEY) === '2d' ||
      localStorage.getItem(GRAPH_MODE_KEY) === '3d'
        ? localStorage.getItem(GRAPH_MODE_KEY)
        : defaultGraphMode) as '2d' | '3d'
  );

  const switchMode = (mode: '2d' | '3d') => {
    setGraphMode(mode);
    localStorage.setItem(GRAPH_MODE_KEY, mode);
  };

  const toggle = (
    <div className="flex items-center bg-neutral-900 p-1 rounded-lg border border-neutral-800">
      <button
        onClick={() => switchMode('2d')}
        className={`px-3 py-1 text-xs rounded-md transition-colors ${
          graphMode === '2d'
            ? 'bg-brand-500/90 text-neutral-950 font-medium'
            : 'text-neutral-400 hover:text-neutral-200'
        }`}
      >
        2D Graph
      </button>
      <button
        onClick={() => switchMode('3d')}
        className={`px-3 py-1 text-xs rounded-md transition-colors ${
          graphMode === '3d'
            ? 'bg-brand-500/90 text-neutral-950 font-medium'
            : 'text-neutral-400 hover:text-neutral-200'
        }`}
      >
        3D Graph
      </button>
    </div>
  );

  return graphMode === '2d' ? (
    <GraphView
      graphData={graphData}
      activeNote={activeNote}
      onSelectNoteByTitle={onSelectNoteByTitle}
      toolbarExtra={toggle}
      backgroundPattern={backgroundPattern}
      persistNodePositions={persistNodePositions}
      themeMode={themeMode}
    />
  ) : (
    <GraphView3D
      graphData={graphData}
      activeNote={activeNote}
      onSelectNoteByTitle={onSelectNoteByTitle}
      toolbarExtra={toggle}
      backgroundPattern={backgroundPattern}
      autoRotateOnLoad={autoRotateOnLoad}
      autoRotateSpeed={autoRotateSpeed}
      labelQuality={labelQuality}
      nodeColor={nodeColor}
      themeStyle={themeStyle}
      themeMode={themeMode}
    />
  );
};
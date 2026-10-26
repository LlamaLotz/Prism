import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { NoteFile, GraphNode, GraphLink } from '../types';
import { focusColor, type GraphFocus } from '../services/graphFocus';
import { Network, Home, RotateCw } from 'lucide-react';
import { mixHex, hexToRgba } from '../utils/accentColor';
import { usePrefersReducedMotion } from '../utils/usePrefersReducedMotion';

// Path normalization: link endpoints come from raw [[wiki-link]] text and
// note paths (Windows `\` separators, `.md` suffixes, mixed casing) while D3
// matches ids exactly. Normalizing everything to one canonical form keeps
// forceLink resolution + coordinate lookup consistent across view rebuilds.
const normalizeKey = (str: any): string => {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .replace(/\\/g, '/') // Convert Windows backslashes \ to /
    .replace(/\.md$/, '') // Remove .md extension
    .trim();
};

// Prism palette (Neutral Charcoal + Sky): active note primary sky,
// existing notes lighter sky, uncreated wiki-link targets slate-grey.
// Mirrors GraphView3D. Mutable so the Appearance "Graph node color" setting
// re-themes the nodes at runtime via setGraphPalette.
let COLOR_ACTIVE = '#38BDF8'; // brand-500
let COLOR_EXISTS = '#64CCFA'; // brand-400 (lighter sky)
const COLOR_MISSING = '#4a4947'; // slate-grey
let COLOR_HOVER = '#31A6DA'; // brand-600 (hover/pressed, darker sky)
const STROKE_COLOR = '#F5F2F2'; // off-white
let STROKE_EXISTS = '#31A6DA'; // brand-600
let GRID_COLOR = 'rgba(56, 189, 248, 0.05)';
let MESH_COLOR = 'rgba(56, 189, 248, 0.18)';
const LINK_COLOR = 'rgba(150, 147, 143, 0.35)';
// Link spring tension. The resting graph keeps its springs soft so distant
// nodes do not skate around, but a soft spring leaves the neighbours of a
// dragged node behind, so the springs are stiffened for the duration of a drag
// (see the node drag handlers).
const LINK_STRENGTH = 0.08;
const DRAG_LINK_STRENGTH = 0.6;
// The centering pull that keeps the resting layout tidy also fights a drag by
// dragging every node back toward the pane centre, so it is relaxed while a
// node is held.
const CENTER_STRENGTH = 0.4;
const DRAG_CENTER_STRENGTH = 0.05;
// Topic layer: teal nodes and links, distinct from folder purple and the
// user-configured note palette.
const TOPIC_COLOR = '#2dd4bf';
const TOPIC_HOVER = '#5eead4';
const TOPIC_LINK_COLOR = 'rgba(45, 212, 191, 0.4)';

/** Re-derives the node palette from a user-picked base color. */
export function setGraphPalette(nodeColor: string): void {
  const base = /^#[0-9a-f]{6}$/i.test(nodeColor) ? nodeColor.toLowerCase() : '#38BDF8';
  COLOR_ACTIVE = base;
  COLOR_EXISTS = mixHex(base, '#ffffff', 0.22); // lighter "exists" shade
  COLOR_HOVER = mixHex(base, '#000000', 0.12); // darker hover shade
  STROKE_EXISTS = mixHex(base, '#000000', 0.12);
  GRID_COLOR = hexToRgba(base, 0.05);
  MESH_COLOR = hexToRgba(base, 0.18);
}

interface GraphViewProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  activeNote: NoteFile | null;
  onSelectNoteByTitle: (title: string) => void;
  /** Extra toolbar controls injected by the container (2D/3D mode toggle). */
  toolbarExtra?: React.ReactNode;
  /** Appearance setting: grid / mesh / solid backdrop behind the graph. */
  backgroundPattern?: 'grid' | 'mesh' | 'solid';
  /** Linking setting: whether dragged node positions are persisted. */
  persistNodePositions?: boolean;
  /** Light / dark mode so text labels and shadows adapt. */
  themeMode?: 'dark' | 'light';
  /** User-chosen node color — triggers a targeted repaint without force rebuild. */
  nodeColor?: string;
  /** Folder/topic spotlight currently previewed or pinned by the container. */
  focus?: (GraphFocus & { pinned: boolean }) | null;
  /** Id of the sticky hub, used to suppress hover after a second click. */
  pinnedFocusId?: string | null;
  onHoverFocus?: (id: string | null) => void;
  onClearFocus?: () => void;
  /** Focus chip rendered above the canvas by the container. */
  focusOverlay?: React.ReactNode;
}

export const GraphView: React.FC<GraphViewProps> = ({
  graphData,
  activeNote,
  onSelectNoteByTitle,
  toolbarExtra,
  backgroundPattern = 'grid',
  persistNodePositions = true,
  themeMode = 'dark',
  nodeColor,
  focus = null,
  pinnedFocusId = null,
  onHoverFocus,
  onClearFocus,
  focusOverlay,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const simulationRef = useRef<d3.Simulation<any, any> | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const reduceMotionRef = useRef(prefersReducedMotion);
  reduceMotionRef.current = prefersReducedMotion;
  const motionDuration = (duration: number) => (reduceMotionRef.current ? 0 : duration);
  // Latest fit-all-nodes function, exposed for the header reset button so it
  // can refit once its re-animation settles.
  const fitAllNodesRef = useRef<() => void>(() => {});
  // The backdrop <rect> lives inside the zoomed group so the grid/mesh pattern
  // pans and zooms WITH the graph. Kept in a ref so the Appearance setting can
  // swap the pattern in place without re-running the whole force layout.
  const bgRectRef = useRef<d3.Selection<SVGRectElement, unknown, null, undefined> | null>(null);

  const POSITIONS_KEY = 'prism_graph_positions';

  // Load saved positions safely
  const loadPositions = (): Record<string, { x: number; y: number }> => {
    try {
      const parsed = JSON.parse(localStorage.getItem(POSITIONS_KEY) || '{}');
      const entries = Object.values(parsed) as Array<{ x: number; y: number }>;
      const zeroes = entries.filter((p) => p && (p.x === 0 || p.y === 0)).length;
      if (entries.length >= 2 && zeroes >= 2) {
        localStorage.removeItem(POSITIONS_KEY);
        return {};
      }
      return parsed;
    } catch {
      return {};
    }
  };

  const persistNodePositionsRef = useRef(persistNodePositions);
  persistNodePositionsRef.current = persistNodePositions;

  const savePositions = (nodes: any[]) => {
    // Disabled via the Linking setting "persist node positions" — the graph
    // then re-lays out fresh on every open. Read the ref so the mount-time
    // simulation callback always sees the current preference.
    if (!persistNodePositionsRef.current) return;
    const positions: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) {
      if (Number.isFinite(n.x) && Number.isFinite(n.y) && (n.x !== 0 || n.y !== 0)) {
        const key = n.id || n.title || n.path;
        if (key) positions[key] = { x: n.x, y: n.y };
      }
    }
    try {
      localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
    } catch {
      // Storage unavailable
    }
  };

  const selectNoteRef = useRef(onSelectNoteByTitle);
  useEffect(() => {
    selectNoteRef.current = onSelectNoteByTitle;
  }, [onSelectNoteByTitle]);

  // Focus callbacks/state are read from refs so the long-lived D3 handlers
  // always see the current values without rebuilding the force layout.
  const pinnedFocusIdRef = useRef(pinnedFocusId);
  pinnedFocusIdRef.current = pinnedFocusId;
  const hoverFocusRef = useRef(onHoverFocus);
  hoverFocusRef.current = onHoverFocus;
  const clearFocusRef = useRef(onClearFocus);
  clearFocusRef.current = onClearFocus;
  // After clicking a pinned hub off, ignore hover on that same hub until the
  // pointer leaves it — otherwise the preview would immediately re-appear.
  const suppressedHubRef = useRef<string | null>(null);
  // Live selections let the focus effect dim the existing DOM without
  // re-running the simulation.
  const nodeSelectionRef = useRef<any>(null);
  const linkSelectionRef = useRef<any>(null);

  const getDimensions = () => {
    const w = containerRef.current?.clientWidth || 0;
    const h = containerRef.current?.clientHeight || 0;
    return {
      width: Math.max(1, w),
      height: Math.max(1, h),
    };
  };

  useEffect(() => {
    if (!svgRef.current) return;

    const { nodes, links } = graphData;
    if (!nodes || nodes.length === 0) return;

    // Light mode: flip text colors, edge opacity, and soften the drop shadow
    // so labels and links remain readable on a bright background.
    const isLight = themeMode === 'light';
    const textColor = isLight ? '#1e293b' : '#cbd5e1';
    const textActive = isLight ? '#0f172a' : '#ffffff';
    const shadowOpacity = isLight ? '0.30' : '0.85';
    const textShadowColor = isLight ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.9)';
    const linkStroke = isLight ? 'rgba(71, 85, 105, 0.3)' : 'rgba(150, 147, 143, 0.35)';

    // Deep copy data for D3 mutation. Link endpoints are normalized to a
    // canonical key (case-insensitive, POSIX path, no .md) so they always
    // match the node map — a raw [[wiki-link]] or Windows path that only
    // differs in casing/separators would otherwise detach to the pane center
    // and disconnect when the view rebuilds.
    //
    // An endpoint may also arrive as a node OBJECT reference: react-force-
    // graph-3d mutates the shared graphData in place (forceLink swaps string
    // ids for node objects carrying 3D coordinates), so passing those objects
    // straight through would draw 2D links at stale 3D positions, away from
    // the rendered nodes. Reducing them to a key makes forceLink re-resolve
    // against the current 2D node set via the .id accessor below.
    const endpointKey = (v: any): string => {
      if (v && typeof v === 'object') return normalizeKey(v.id || v.title || v.path);
      return normalizeKey(v);
    };
    const d3Nodes: any[] = nodes.map((d) => ({ ...d }));
    // Only keep links whose endpoints resolve to a node in this render:
    // d3-force's forceLink throws "missing: <id>" on unresolvable endpoints,
    // which would crash the whole graph pane (the Rust snapshot can race a
    // re-index, and cross-view object refs can be stale). Self-links collapse
    // to the same key after normalization and are dropped too.
    const nodeKeys = new Set<string>();
    d3Nodes.forEach((n: any) => {
      if (n.id) nodeKeys.add(normalizeKey(n.id));
      if (n.title) nodeKeys.add(normalizeKey(n.title));
      if (n.path) nodeKeys.add(normalizeKey(n.path));
    });
    const d3Links: any[] = links
      .map((d) => ({
        ...d,
        source: endpointKey(d.source),
        target: endpointKey(d.target),
      }))
      .filter(
        (l) =>
          !!l.source &&
          !!l.target &&
          l.source !== l.target &&
          nodeKeys.has(l.source) &&
          nodeKeys.has(l.target)
      );

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove(); // Clear previous rendering

    const { width, height } = getDimensions();
    svg.attr('width', '100%').attr('height', '100%');

    const savedPositions = loadPositions();

    // 1. Position Seeding: Use saved positions as starting hints ONLY (No hard fx/fy pins)
    const seedCount = d3Nodes.length || 1;
    d3Nodes.forEach((node: any, i: number) => {
      const key = node.id || node.title || node.path;
      const p = key ? savedPositions[key] : undefined;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x !== 0 && p.y !== 0) {
        node.x = p.x;
        node.y = p.y;
      } else {
        // Radial spread around canvas center to prevent top-left (0,0) clumping
        const angle = (i / seedCount) * 2 * Math.PI;
        const radius = 140 + Math.random() * 80;
        node.x = width / 2 + radius * Math.cos(angle);
        node.y = height / 2 + radius * Math.sin(angle);
      }
      // Ensure nodes are NOT pinned so physics can spread them apart
      node.fx = null;
      node.fy = null;
    });

    // 2. Container group for zoom & pan
    const gContainer = svg.append('g').attr('class', 'graph-container');

    // Background: drawn INSIDE the zoomed group (not as a static CSS backdrop
    // on the pane) so the grid/mesh pattern pans and zooms WITH the graph —
    // the old screen-space pattern stayed fixed while the graph moved under
    // it, which read as nausea when panning/zooming. A huge rect filled by an
    // SVG pattern that tiles in user space follows the zoom transform exactly
    // like the nodes and links do.
    const EXTENT = 100000;
    const defs = svg.append('defs');

    // Drop shadow filter for node grounding: casts a dark shadow onto the
    // background grid plane so nodes read as resting on it.
    const shadowFilter = defs.append('filter')
      .attr('id', 'node-drop-shadow')
      .attr('x', '-20%')
      .attr('y', '-20%')
      .attr('width', '140%')
      .attr('height', '140%');

    shadowFilter.append('feDropShadow')
      .attr('dx', '0')
      .attr('dy', isLight ? '2' : '4')
      .attr('stdDeviation', isLight ? '3' : '4')
      .attr('flood-color', '#000000')
      .attr('flood-opacity', shadowOpacity);

    const gridPattern = defs
      .append('pattern')
      .attr('id', 'graph-bg-grid-pattern')
      .attr('width', 42)
      .attr('height', 42)
      .attr('patternUnits', 'userSpaceOnUse');
    gridPattern
      .append('path')
      .attr('d', 'M 42 0 L 0 0 0 42')
      .attr('fill', 'none')
      .attr('stroke', GRID_COLOR)
      .attr('stroke-width', 1);

    const meshPattern = defs
      .append('pattern')
      .attr('id', 'graph-bg-mesh-pattern')
      .attr('width', 26)
      .attr('height', 26)
      .attr('patternUnits', 'userSpaceOnUse');
    meshPattern
      .append('circle')
      .attr('cx', 1.2)
      .attr('cy', 1.2)
      .attr('r', 1.2)
      .attr('fill', MESH_COLOR);

    const bgRect = gContainer
      .append('rect')
      .attr('class', 'graph-bg-rect')
      .attr('x', -EXTENT)
      .attr('y', -EXTENT)
      .attr('width', EXTENT * 2)
      .attr('height', EXTENT * 2)
      .attr('pointer-events', 'none')
      .attr(
        'fill',
        backgroundPattern === 'grid'
          ? 'url(#graph-bg-grid-pattern)'
          : backgroundPattern === 'mesh'
            ? 'url(#graph-bg-mesh-pattern)'
            : 'none'
      );
    bgRectRef.current = bgRect;

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 3.5])
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        gContainer.attr('transform', event.transform.toString());
      });

    svg.call(zoom);
    zoomBehaviorRef.current = zoom;

    // Empty-canvas click clears focus. Node clicks stop propagation above, so
    // this only runs for the backdrop, links, or empty space.
    svg.on('click.focusClear', (event: any) => {
      const target = event.target as Element | null;
      if (target?.closest?.('g.nodes > g')) return;
      clearFocusRef.current?.();
    });

    // 3. Force Physics Simulation: Strong repulsion + Collision to prevent clumping
    const linkForce = d3.forceLink<any, any>(d3Links)
      .id((d: any) => normalizeKey(d.id || d.title || d.path))
      .distance(120)
      .strength(LINK_STRENGTH);
    const centerForce = d3.forceCenter(width / 2, height / 2).strength(CENTER_STRENGTH);
    const simulation = d3.forceSimulation<any>(d3Nodes)
      .velocityDecay(0.72) // Heavy ground friction: stops nodes from sliding/skating
      .alphaDecay(0.05)    // Fast settle
      .force('link', linkForce)
      .force('charge', d3.forceManyBody().strength(-180)) // Gentle repulsion
      .force('center', centerForce)
      .force('collision', d3.forceCollide().radius((d: any) => Math.max(22, (d.linksCount || 1) * 1.5 + 16)))
      .force('x', d3.forceX(width / 2).strength(0.02))
      .force('y', d3.forceY(height / 2).strength(0.02));

    simulationRef.current = simulation;
    const reduceMotionAtMount = reduceMotionRef.current;

    // Stop the async timer while we pre-warm so the first paint never races the
    // physics loop. With reduced motion, run the layout to rest synchronously
    // and leave the graph static instead of animating nodes into place.
    simulation.stop();
    const prewarmTicks = reduceMotionAtMount ? 180 : 40;
    for (let i = 0; i < prewarmTicks; ++i) {
      simulation.tick();
    }
    if (!reduceMotionAtMount) simulation.restart();

    // 4. Draw Link Edges with crisp slate-400 visibility
    const linkElements = gContainer.append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(d3Links)
      .enter()
      .append('line')
      .attr('data-link-kind', (d: any) => d.kind ?? 'link')
      .attr('stroke', (d: any) => (d.kind === 'topic' ? TOPIC_LINK_COLOR : linkStroke))
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', (d: any) => (d.targetExists === false ? '4,4' : 'none'));
    linkSelectionRef.current = linkElements;

    // 5. Draw Node Vertices
    const nodeElements = gContainer.append('g')
      .attr('class', 'nodes')
      .selectAll('g')
      .data(d3Nodes)
      .enter()
      .append('g')
      .attr('data-node-id', (d: any) => d.id)
      .attr('data-node-kind', (d: any) => d.kind ?? 'note')
      .attr('cursor', 'pointer')
      .call(
        d3.drag<SVGGElement, any>()
          .on('start', (event: any, d: any) => {
            // Reheat the simulation IMMEDIATELY (not just via the slow alpha
            // climb from a cold stop), so nodes connected to the grabbed one
            // follow the drag as it moves — the grabbed node alone sliding
            // over a frozen graph read as "connected nodes can't move".
            if (!event.active) {
              // Stiffen the springs: at the resting tension (0.08) the drag
              // outruns the link force and the connected nodes are left
              // behind on a nearly slack edge.
              linkForce.strength(DRAG_LINK_STRENGTH);
              centerForce.strength(DRAG_CENTER_STRENGTH);
              simulation.alphaTarget(0.3).alpha(Math.max(simulation.alpha(), 0.3)).restart();
            }
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event: any, d: any) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event: any, d: any) => {
            if (!event.active) {
              simulation.alphaTarget(0);
              // Springs return to their resting tension once the drag is over.
              linkForce.strength(LINK_STRENGTH);
              centerForce.strength(CENTER_STRENGTH);
            }
            // UN-PIN node on release so it stays dynamic and never gets stuck
            // in place like a static background object — with fx/fy left set,
            // the node freezes at the drop point while the rest of the graph
            // settles around it.
            d.fx = null;
            d.fy = null;
            savePositions(d3Nodes);
          })
      );

    // Focus halo sits behind the node circle. It only becomes visible for the
    // folder/topic hub that currently owns the focus.
    nodeElements.append('circle')
      .attr('class', 'node-focus-ring')
      .attr('r', (d: any) => Math.max(7, Math.min(20, (d.linksCount || 1) * 1.8 + 6)) + 5)
      .attr('fill', 'none')
      .attr('stroke', 'none')
      .attr('stroke-width', 2)
      .attr('opacity', 0)
      .attr('pointer-events', 'none');

    // Node Circle
    nodeElements.append('circle')
      .attr('class', 'node-circle')
      .attr('filter', 'url(#node-drop-shadow)') // Anchors node onto background plane
      .attr('r', (d: any) => Math.max(7, Math.min(20, (d.linksCount || 1) * 1.8 + 6)))
      .attr('fill', (d: any) => {
        if (d.kind === 'topic') return TOPIC_COLOR;
        const isCurrent = activeNote && d.title && activeNote.title.toLowerCase() === d.title.toLowerCase();
        if (isCurrent) return COLOR_ACTIVE;
        return d.kind==='folder' ? '#a78bfa' : d.exists !== false ? COLOR_EXISTS : COLOR_MISSING;
      })
      .attr('stroke', (d: any) => {
        const isCurrent = activeNote && d.title && activeNote.title.toLowerCase() === d.title.toLowerCase();
        return isCurrent ? STROKE_COLOR : STROKE_EXISTS;
      })
      .attr('stroke-width', (d: any) => {
        const isCurrent = activeNote && d.title && activeNote.title.toLowerCase() === d.title.toLowerCase();
        return isCurrent ? 2.5 : 1;
      });
    nodeSelectionRef.current = nodeElements;

    // Node Text Labels — use one explicit center anchor for both the text and
    // its pill. This avoids baseline/ascent differences leaving the glyphs
    // cramped against one edge of the background.
    nodeElements.append('text')
      .text((d: any) => d.title || d.id || 'Untitled')
      .attr('x', 0)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('alignment-baseline', 'central')
      .attr('font-size', '10px')
      .attr('font-weight', '600')
      .attr('fill', (d: any) => {
        const isCurrent = activeNote && d.title && activeNote.title.toLowerCase() === d.title.toLowerCase();
        return isCurrent ? textActive : textColor;
      })
      .attr('pointer-events', 'none')
      .style('text-shadow', `0 1px 3px ${textShadowColor}`);

    // Measure the glyph bounds, then place the text and pill around a shared
    // center. The pill starts nodeRadius + 4px below the circle and uses
    // uniform 7px horizontal / 6px vertical padding for a tight, balanced wrap.
    // We use getComputedTextLength() + estimated cap-height instead of
    // getBBox() because SVG elements freshly inserted into the DOM haven't
    // had a layout pass yet — getBBox() would return zero dimensions and the
    // pill background would collapse to nothing.
    nodeElements.each(function (d: any) {
      const textSelection = d3.select(this).select('text');
      const textEl = textSelection.node() as SVGTextElement | null;
      if (!textEl) return;
      try {
        const r = Math.max(7, Math.min(20, (d.linksCount || 1) * 1.8 + 6));
        // Use synchronous text measurement (no layout pass needed).
        const textW = textEl.getComputedTextLength();
        // Estimate glyph height from the font-size (10px) — cap-height is
        // roughly 70% for most fonts, and dominant-baseline: central centers
        // the glyph, so the visual height is about 7px with 3px of internal
        // leading. A 16px total height (10px * 1.6) gives comfortable padding.
        const textH = 16;
        const padX = 7;
        const padY = 5;
        const pillW = Math.max(textW + padX * 2, 40);
        const pillH = Math.max(textH + padY * 2, 22);
        const centerY = r + 4 + pillH / 2;
        const pillX = -pillW / 2;
        const pillY = centerY - pillH / 2;
        const radius = pillH / 2;

        textSelection.attr('y', centerY);
        d3.select(this).insert('rect', 'text')
          .attr('class', 'node-label-bg')
          .attr('pointer-events', 'none')
          .attr('x', pillX)
          .attr('y', pillY)
          .attr('width', pillW)
          .attr('height', pillH)
          .attr('rx', radius)
          .attr('ry', radius)
          .attr('fill', isLight ? 'rgba(241, 245, 249, 0.95)' : 'rgba(30, 30, 36, 0.92)')
          .attr('stroke', isLight ? 'rgba(148, 163, 184, 0.6)' : 'rgba(185, 182, 179, 0.25)')
          .attr('stroke-width', 1);
      } catch {}
    });

    // Node Interactivity. Hubs (folders/topics) toggle focus; notes open.
    nodeElements.on('click', (event: any, d: any) => {
      event.stopPropagation();
      const isHub = d.kind === 'folder' || d.kind === 'topic';
      if (isHub && pinnedFocusIdRef.current === d.id) {
        // Clicking the pinned hub again clears it and suppresses its hover
        // preview until the pointer leaves.
        suppressedHubRef.current = d.id;
        hoverFocusRef.current?.(null);
      } else if (isHub) {
        suppressedHubRef.current = null;
      }
      if (d.title || d.id) {
        selectNoteRef.current(d.id);
      }
    });

    nodeElements.on('mouseover', function (this: SVGGElement, _event: any, d: any) {
      const isHub = d.kind === 'folder' || d.kind === 'topic';
      if (isHub) {
        if (suppressedHubRef.current !== d.id) hoverFocusRef.current?.(d.id);
      } else {
        hoverFocusRef.current?.(null);
      }

      d3.select(this).select('circle.node-circle')
        .transition()
        .duration(motionDuration(150))
        .attr('r', Math.max(10, Math.min(24, (d.linksCount || 1) * 1.8 + 10)))
        .attr('fill', (d: any) => (d.kind === 'topic' ? TOPIC_HOVER : COLOR_HOVER));

      d3.select(this).select('text')
        .transition()
        .duration(motionDuration(150))
        .attr('font-size', '10px')
        .attr('fill', isLight ? '#0f172a' : '#ffffff');

      // Brighten pill background on hover
      d3.select(this).select('rect.node-label-bg')
        .transition()
        .duration(motionDuration(150))
        .attr('fill', isLight ? 'rgba(255, 255, 255, 0.96)' : 'rgba(45, 45, 55, 0.92)')
        .attr('stroke', isLight ? 'rgba(148, 163, 184, 0.5)' : 'rgba(255, 255, 255, 0.25)');
    })
    .on('mouseout', function (this: SVGGElement, _event: any, d: any) {
      const isHub = d.kind === 'folder' || d.kind === 'topic';
      if (isHub) {
        if (suppressedHubRef.current === d.id) suppressedHubRef.current = null;
        else hoverFocusRef.current?.(null);
      }

      const isCurrent = activeNote && d.title && activeNote.title.toLowerCase() === d.title.toLowerCase();

      d3.select(this).select('circle.node-circle')
        .transition()
        .duration(motionDuration(150))
        .attr('r', Math.max(7, Math.min(20, (d.linksCount || 1) * 1.8 + 6)))
        .attr('fill', d.kind==='topic' ? TOPIC_COLOR : d.kind==='folder' ? '#a78bfa' : isCurrent ? COLOR_ACTIVE : (d.exists !== false ? COLOR_EXISTS : COLOR_MISSING));

      d3.select(this).select('text')
        .transition()
        .duration(motionDuration(150))
        .attr('font-size', '10px')
        .attr('fill', isCurrent ? textActive : textColor);

      // Restore pill background
      d3.select(this).select('rect.node-label-bg')
        .transition()
        .duration(motionDuration(150))
        .attr('fill', isLight ? 'rgba(241, 245, 249, 0.92)' : 'rgba(30, 30, 36, 0.88)')
        .attr('stroke', isLight ? 'rgba(148, 163, 184, 0.35)' : 'rgba(185, 182, 179, 0.2)');
    });

    // 6. Safe Link Coordinate Resolution
    const nodeMap = new Map<string, any>();
    d3Nodes.forEach((n: any) => {
      if (n.id) nodeMap.set(normalizeKey(n.id), n);
      if (n.title) nodeMap.set(normalizeKey(n.title), n);
      if (n.path) nodeMap.set(normalizeKey(n.path), n);
    });

    const getCoord = (sourceOrTarget: any, axis: 'x' | 'y'): number => {
      if (typeof sourceOrTarget === 'object' && sourceOrTarget !== null && axis in sourceOrTarget) {
        const val = sourceOrTarget[axis];
        return Number.isFinite(val) ? val : (axis === 'x' ? width / 2 : height / 2);
      }
      if (typeof sourceOrTarget === 'string' || typeof sourceOrTarget === 'number') {
        const found = nodeMap.get(normalizeKey(sourceOrTarget));
        if (found && Number.isFinite(found[axis])) return found[axis];
      }
      return axis === 'x' ? width / 2 : height / 2;
    };

    // Simulation Tick Update
    const renderPositions = () => {
      linkElements
        .attr('x1', (d: any) => getCoord(d.source, 'x'))
        .attr('y1', (d: any) => getCoord(d.source, 'y'))
        .attr('x2', (d: any) => getCoord(d.target, 'x'))
        .attr('y2', (d: any) => getCoord(d.target, 'y'));

      nodeElements.attr('transform', (d: any) => `translate(${d.x || width / 2}, ${d.y || height / 2})`);
    };
    simulation.on('tick', renderPositions);
    // Paint the pre-warmed layout once. With reduced motion the timer stays
    // stopped, so no tick ever fires and the nodes would otherwise never be
    // positioned (every group sat at the SVG origin, off-screen).
    renderPositions();

    // Save positions when simulation ends
    simulation.on('end', () => {
      savePositions(d3Nodes);
    });

    // 7. Fit ALL nodes into the pane on startup / opening the graph view. The
    // previous behavior centered on the ACTIVE note at 1.25x, which zoomed in
    // so far the rest of the network fell out of view. Compute the bounding
    // box of every node and fit it to the pane with padding instead, so the
    // whole graph is always visible at once.
    const fitAllNodes = () => {
      const { width, height } = getDimensions();
      if (d3Nodes.length === 0) return;
      const xs = d3Nodes.map((d: any) => d.x).filter(Number.isFinite);
      const ys = d3Nodes.map((d: any) => d.y).filter(Number.isFinite);
      if (xs.length === 0 || ys.length === 0) return;

      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const bw = Math.max(maxX - minX, 100);
      const bh = Math.max(maxY - minY, 100);
      // Fit with padding and allow zooming IN (up to 2.5x) so a compact graph
      // fills the pane instead of floating small in empty space. The bounding
      // box math still guarantees every node stays in view.
      const scale = Math.max(
        0.1,
        Math.min(2.5, Math.min((width - 160) / bw, (height - 160) / bh))
      );
      const transform = d3.zoomIdentity
        .translate(width / 2 - (minX + bw / 2) * scale, height / 2 - (minY + bh / 2) * scale)
        .scale(scale);

      const duration = motionDuration(600);
      if (duration === 0) {
        svg.call(zoom.transform, transform);
      } else {
        svg.transition()
          .duration(duration)
          .ease(d3.easeCubicOut)
          .call(zoom.transform, transform);
      }
    };
    fitAllNodesRef.current = fitAllNodes;

    // Fit immediately once the layout is roughly in place, then again when the
    // simulation settles so the final spread always fits the pane (nodes keep
    // drifting while the physics animate past the first fit).
    const fitTimer = setTimeout(fitAllNodes, reduceMotionAtMount ? 0 : 120);
    simulation.on('end.fitInitial', () => {
      simulation.on('end.fitInitial', null);
      fitAllNodes();
    });

    // Preserve the camera's world-space center and zoom as its pane resizes.
    // The simulation and node positions stay intact during divider drags.
    let previousSize = getDimensions();
    const resize = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0 || !svgRef.current) return;
      const transform = d3.zoomTransform(svgRef.current);
      svg.interrupt().call(zoom.transform, d3.zoomIdentity
        .translate(transform.x + (width - previousSize.width) / 2, transform.y + (height - previousSize.height) / 2)
        .scale(transform.k));
      previousSize = { width, height };
    });
    if (containerRef.current) resize.observe(containerRef.current);

    return () => {
      resize.disconnect();
      clearTimeout(fitTimer);
      simulation.stop();
    };
  }, [graphData, activeNote]);

  // Swap the backdrop pattern in place when the Appearance setting changes —
  // no need to re-seed or re-run the force layout for a cosmetic change.
  useEffect(() => {
    const rect = bgRectRef.current;
    if (!rect) return;
    rect.attr(
      'fill',
      backgroundPattern === 'grid'
        ? 'url(#graph-bg-grid-pattern)'
        : backgroundPattern === 'mesh'
          ? 'url(#graph-bg-mesh-pattern)'
          : 'none'
    );
  }, [backgroundPattern]);

  // Targeted repaint: when the user changes the node color or light/dark mode,
  // the module-level COLOR_ACTIVE / COLOR_EXISTS / etc. variables have already
  // been set by setGraphPalette. This effect walks the existing DOM and repaints
  // circles, labels, and pill backgrounds without rebuilding the force sim.
  useEffect(() => {
    const svg = d3.select(svgRef.current);
    const nodeGroup = svg.select('g.nodes');
    if (nodeGroup.empty()) return;

    const isLight = themeMode === 'light';
    const textColor = isLight ? '#1e293b' : '#cbd5e1';
    const textActive = isLight ? '#0f172a' : '#ffffff';
    const pillFill = isLight ? 'rgba(241, 245, 249, 0.95)' : 'rgba(30, 30, 36, 0.92)';
    const pillStroke = isLight ? 'rgba(148, 163, 184, 0.6)' : 'rgba(185, 182, 179, 0.25)';

    nodeGroup.selectAll('g').each(function (d: any) {
      const node = d3.select(this);
      const isCurrent = activeNote && d.title && activeNote.title.toLowerCase() === d.title.toLowerCase();

      // Update circle fill/stroke
      node.select('circle.node-circle')
        .attr('fill', d.kind==='topic' ? TOPIC_COLOR : d.kind==='folder' ? '#a78bfa' : isCurrent ? COLOR_ACTIVE : (d.exists !== false ? COLOR_EXISTS : COLOR_MISSING))
        .attr('stroke', isCurrent ? STROKE_COLOR : STROKE_EXISTS);

      // Update text color
      node.select('text')
        .attr('fill', isCurrent ? textActive : textColor);

      // Update pill background
      node.select('rect.node-label-bg')
        .attr('fill', pillFill)
        .attr('stroke', pillStroke);
    });
  }, [nodeColor, themeMode, activeNote]);

  // Spotlight the focused folder subtree/topic set by dimming everything else.
  // Opacity-only: the force simulation and camera are never touched, and the
  // transition collapses to an instant swap under reduced motion.
  useEffect(() => {
    const nodeSel = nodeSelectionRef.current;
    const linkSel = linkSelectionRef.current;
    if (!nodeSel || !linkSel) return;

    const ids = focus?.ids ?? null;
    const duration = motionDuration(180);
    const endpoint = (value: any) => (value && typeof value === 'object' ? value.id : value);
    const nodeOpacity = (d: any) => (!ids || ids.has(d.id) ? 1 : 0.2);
    const linkOpacity = (d: any) =>
      !ids || (ids.has(endpoint(d.source)) && ids.has(endpoint(d.target))) ? 1 : 0.1;

    nodeSel.interrupt();
    linkSel.interrupt();

    // Keep the semantic color/glow on every hub ring so clearing or moving the
    // focus fades it out instead of snapping the stroke away.
    const ring = nodeSel.select('circle.node-focus-ring')
      .attr('stroke', (d: any) =>
        d.kind === 'folder' || d.kind === 'topic' ? focusColor(d.kind) : 'none'
      )
      .style('filter', (d: any) =>
        d.kind === 'folder' || d.kind === 'topic'
          ? `drop-shadow(0 0 5px ${focusColor(d.kind)})`
          : null
      );
    const ringOpacity = (d: any) => (focus && d.id === focus.hubId ? 1 : 0);
    ring.interrupt();
    if (duration === 0) {
      nodeSel.style('opacity', nodeOpacity);
      linkSel.style('opacity', linkOpacity);
      ring.attr('opacity', ringOpacity);
    } else {
      nodeSel.transition().duration(duration).style('opacity', nodeOpacity);
      linkSel.transition().duration(duration).style('opacity', linkOpacity);
      ring.transition().duration(duration).attr('opacity', ringOpacity);
    }
  }, [focus]);

  // Header Manual Reset Button
  // If the OS preference is switched on while a layout is still settling,
  // freeze it rather than making the user wait out the animation.
  useEffect(() => {
    if (prefersReducedMotion) simulationRef.current?.stop();
  }, [prefersReducedMotion]);

  const handleResetGraph = () => {
    localStorage.removeItem(POSITIONS_KEY);
    localStorage.removeItem('prism_graph_zoom');
    
    // Fit the whole graph into view immediately — the old behavior zoomed to
    // identity (pane center only), so Home appeared to shrink the graph to
    // the middle instead of covering every node.
    fitAllNodesRef.current();

    const simulation = simulationRef.current;
    if (simulation) {
      if (reduceMotionRef.current) {
        // Reduced motion: settle the layout synchronously and keep it still.
        simulation.stop();
        simulation.on('end.resetFit', null);
        simulation.alpha(1);
        for (let i = 0; i < 180; ++i) simulation.tick();
        fitAllNodesRef.current();
      } else {
        simulation.alpha(1).restart();
        // Nodes drift while the re-animation runs — refit once it settles so
        // the final spread still covers the whole pane.
        simulation.on('end.resetFit', () => {
          simulationRef.current?.on('end.resetFit', null);
          fitAllNodesRef.current();
        });
      }
    }
  };

  const hasFolders = graphData.nodes.some((node) => node.kind === 'folder');
  const hasTopics = graphData.nodes.some((node) => node.kind === 'topic');

  return (
    <div
      data-region="graph"
      className="flex-1 bg-slate-950/40 border-r border-slate-900/60 flex flex-col h-full relative select-none overflow-hidden"
    >
      {/* Header bar — title and controls stay on one row at every pane width. */}
      <div className="graph-header px-6 py-3.5 border-b border-slate-900/60 bg-slate-950/60 shrink-0 z-10">
        <div className="graph-header-title flex items-center gap-2">
          <Network className="w-4 h-4 text-brand-400 shrink-0" />
          <h2 className="text-sm font-semibold text-slate-100">Knowledge Network</h2>
        </div>
        <div className="graph-header-controls text-xs text-slate-500 font-medium flex items-center gap-2">
          {toolbarExtra}
          <span className="graph-hint">Drag to arrange • Scroll to zoom</span>
          <button
            onClick={handleResetGraph}
            title="Reset graph view & re-arrange nodes"
            className="graph-icon-btn p-1.5 rounded-md bg-slate-900/80 border border-slate-800/80 text-slate-400 hover:text-brand-400 hover:border-brand-500/50 transition-colors flex items-center gap-1"
          >
            <Home className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleResetGraph}
            title="Re-animate physics simulation"
            className="graph-icon-btn p-1.5 rounded-md bg-slate-900/80 border border-slate-800/80 text-slate-400 hover:text-brand-400 hover:border-brand-500/50 transition-colors flex items-center gap-1"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* SVG Container — fills remaining space beneath the header. */}
      <div ref={containerRef} className="graph-canvas flex-1 overflow-hidden relative w-full h-full" title="Drag to arrange • Scroll to zoom">
        <svg ref={svgRef} className="w-full h-full block" />
        {focusOverlay}

        {/* Legend */}
        <div className="absolute bottom-4 left-4 bg-slate-900/90 border border-slate-800/80 px-3.5 py-2.5 rounded-xl shadow-lg text-xs space-y-1.5 backdrop-blur-md z-10">
          <span className="font-semibold text-slate-400 block mb-1">GRAPH LEGEND</span>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-brand-500 border border-white" />
            <span className="text-slate-200">Active Note</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-brand-400 border border-brand-700" />
            <span className="text-slate-200">Existing Notes</span>
          </div>
          {hasFolders && (
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full border border-white/60" style={{ backgroundColor: '#a78bfa' }} />
              <span className="text-slate-200">Folders</span>
            </div>
          )}
          {hasTopics && (
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full border border-white/60" style={{ backgroundColor: TOPIC_COLOR }} />
              <span className="text-slate-200">Topics (@tag)</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-slate-600 border border-dashed border-slate-500" />
            <span className="text-slate-400">Uncreated Wiki-links</span>
          </div>
        </div>
      </div>
    </div>
  );
};

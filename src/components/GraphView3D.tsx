import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';
import { GraphNode, GraphLink, NoteFile } from '../types';
import { focusColor, type GraphFocus } from '../services/graphFocus';
import { Network, Home, Orbit } from 'lucide-react';
import { mixHex, hexToRgba } from '../utils/accentColor';
import { usePrefersReducedMotion } from '../utils/usePrefersReducedMotion';

interface GraphView3DProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  activeNote: NoteFile | null;
  onSelectNoteByTitle: (title: string) => void;
  toolbarExtra?: React.ReactNode;
  backgroundPattern?: 'grid' | 'mesh' | 'solid';
  autoRotateOnLoad?: boolean;
  autoRotateSpeed?: number;
  labelQuality?: 'standard' | 'high';
  nodeColor?: string;
  themeStyle?: 'industrial' | 'gloss';
  themeMode?: 'dark' | 'light';
  /** Folder/topic spotlight currently previewed or pinned by the container. */
  focus?: (GraphFocus & { pinned: boolean }) | null;
  /** Id of the sticky hub, used to suppress hover after a second click. */
  pinnedFocusId?: string | null;
  onHoverFocus?: (id: string | null) => void;
  onClearFocus?: () => void;
  /** Focus chip rendered above the canvas by the container. */
  focusOverlay?: React.ReactNode;
}

interface TooltipState {
  x: number;
  y: number;
  title: string;
  linksCount: number;
  exists: boolean;
}

// Prism palette (matches the 2D graph's legend): active note primary sky,
// existing notes lighter sky, uncreated wiki-link targets slate-grey.
let COLOR_ACTIVE = '#38BDF8'; // brand-500
let COLOR_EXISTS = '#64CCFA'; // brand-400 (lighter sky)
const COLOR_MISSING = '#3c3b39'; // slate-grey
let COLOR_HOVER = '#7ED4FA'; // brand-300 (light sky)
const LINK_COLOR_DARK = 'rgba(245, 242, 242, 0.08)';
// Topic layer mirrors the 2D graph's teal treatment.
const TOPIC_COLOR = '#2dd4bf';
const TOPIC_HOVER_COLOR = '#5eead4';
const TOPIC_LINK_COLOR = 'rgba(45, 212, 191, 0.4)';

export function setGraphPalette(nodeColor: string): void {
  const base = /^#[0-9a-f]{6}$/i.test(nodeColor) ? nodeColor.toLowerCase() : '#38BDF8';
  COLOR_ACTIVE = base;
  COLOR_EXISTS = mixHex(base, '#ffffff', 0.22);
  COLOR_HOVER = mixHex(base, '#ffffff', 0.35);
}

const nodeRadius = (linksCount: number) => Math.max(1.4, Math.min(9, 1.4 + linksCount * 0.55));
const LABEL_HEIGHT = 6;

const applyForceTuning = (g: any) => {
  g.d3Force?.('charge')?.strength?.(-180);
  g.d3Force?.('link')?.distance?.(70);
  g.d3Force?.('center')?.strength?.(0.8);
  g.numDimensions?.(3);
};

export const GraphView3D: React.FC<GraphView3DProps> = ({
  graphData,
  activeNote,
  onSelectNoteByTitle,
  toolbarExtra,
  backgroundPattern = 'grid',
  autoRotateOnLoad = false,
  autoRotateSpeed = 0.67,
  labelQuality = 'high',
  nodeColor = '#38BDF8',
  themeStyle = 'industrial',
  themeMode = 'dark',
  focus = null,
  pinnedFocusId = null,
  onHoverFocus,
  onClearFocus,
  focusOverlay,
}) => {
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const prefersReducedMotion = usePrefersReducedMotion();
  const reduceMotionRef = useRef(prefersReducedMotion);
  reduceMotionRef.current = prefersReducedMotion;

  const sphereGeoRef = useRef<THREE.SphereGeometry | null>(null);
  if (!sphereGeoRef.current) sphereGeoRef.current = new THREE.SphereGeometry(1, 24, 24);
  const matCacheRef = useRef<Map<string, THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial>>(new Map());
  const nodeMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const nodeSpritesRef = useRef<Map<string, THREE.Sprite>>(new Map());
  const nodeRingsRef = useRef<Map<string, THREE.Sprite>>(new Map());
  const ringTextureRef = useRef<THREE.CanvasTexture | null>(null);
  const labelCacheRef = useRef<Map<string, THREE.Sprite>>(new Map());
  const nodeGroupsRef = useRef<Set<THREE.Group>>(new Set());
  const focusRafRef = useRef<number | null>(null);

  const [autoRotate, setAutoRotate] = useState(autoRotateOnLoad && !prefersReducedMotion);
  // Keep the runtime control synchronized when the saved preference changes
  // while this graph instance is already mounted. Reduce Motion suppresses
  // the automatic orbit; a manual toggle remains available.
  useEffect(() => {
    setAutoRotate(autoRotateOnLoad && !prefersReducedMotion);
  }, [autoRotateOnLoad, prefersReducedMotion]);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeTitle = activeNote?.title?.toLowerCase();
  const lastTooltipRef = useRef('');
  const activeTitleRef = useRef(activeTitle);
  activeTitleRef.current = activeTitle;
  const themeModeRef = useRef(themeMode);
  themeModeRef.current = themeMode;
  const onSelectNoteByTitleRef = useRef(onSelectNoteByTitle);
  onSelectNoteByTitleRef.current = onSelectNoteByTitle;
  const pinnedFocusIdRef = useRef(pinnedFocusId);
  pinnedFocusIdRef.current = pinnedFocusId;
  const hoverFocusRef = useRef(onHoverFocus);
  hoverFocusRef.current = onHoverFocus;
  const clearFocusRef = useRef(onClearFocus);
  clearFocusRef.current = onClearFocus;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  // After clicking a pinned hub off, ignore hover on that same hub until the
  // pointer leaves it — otherwise the preview would immediately re-appear.
  const suppressedHubRef = useRef<string | null>(null);
  const lastHoveredIdRef = useRef<string | null>(null);
  const graphDataRef = useRef(graphData);
  graphDataRef.current = graphData;
  const pendingFrameRef = useRef(false);
  const lastNodeCountRef = useRef(-1);

  const stableGraphRef = useRef<{ nodes: any[]; links: any[] } | null>(null);
  const positionsCarriedRef = useRef(false);
  const stableData = useMemo(() => {
    const normalize = (id: any) => String(id ?? '').toLowerCase();
    const endpointId = (e: any) => (typeof e === 'object' && e !== null ? e.id ?? e.title ?? '' : e);
    const nodes: any[] = graphData.nodes.map((n) => ({ ...n }));
    const links: any[] = graphData.links.map((l) => ({
      ...l,
      source: endpointId(l.source),
      target: endpointId(l.target),
    }));
    positionsCarriedRef.current = false;
    const prev = stableGraphRef.current;
    if (prev && prev.nodes.length) {
      const prevById = new Map<string, any>();
      for (const p of prev.nodes) prevById.set(normalize(p.id), p);
      for (const n of nodes) {
        const old = prevById.get(normalize(n.id));
        if (old && Number.isFinite(old.x)) {
          n.x = old.x; n.y = old.y; n.z = old.z;
          if (Number.isFinite(old.fx)) n.fx = old.fx;
          if (Number.isFinite(old.fy)) n.fy = old.fy;
          if (Number.isFinite(old.fz)) n.fz = old.fz;
          positionsCarriedRef.current = true;
        }
      }
      const nextById = new Map<string, any>();
      for (const n of nodes) nextById.set(normalize(n.id), n);
      const sums = new Map<string, { x: number; y: number; z: number; c: number }>();
      const accumulate = (id: string, from: any) => {
        const s = sums.get(id) ?? { x: 0, y: 0, z: 0, c: 0 };
        s.x += from.x; s.y += from.y; s.z += from.z; s.c += 1;
        sums.set(id, s);
      };
      for (const l of links) {
        const sId = normalize(endpointId(l.source));
        const tId = normalize(endpointId(l.target));
        const sn = nextById.get(sId);
        const tn = nextById.get(tId);
        if (!sn || !tn) continue;
        if (!Number.isFinite(sn.x) && Number.isFinite(tn.x)) accumulate(sId, tn);
        if (!Number.isFinite(tn.x) && Number.isFinite(sn.x)) accumulate(tId, sn);
      }
      for (const n of nodes) {
        if (Number.isFinite(n.x)) continue;
        const s = sums.get(normalize(n.id));
        if (s && s.c > 0) { n.x = s.x / s.c; n.y = s.y / s.c; n.z = s.z / s.c; }
      }
    }
    stableGraphRef.current = { nodes, links };
    return { nodes, links };
  }, [graphData]);

  const isGlassTheme = themeStyle === 'gloss';
  const isDarkMode = themeMode === 'dark';
  const configuredNodeColor = /^#[0-9a-f]{6}$/i.test(nodeColor) ? nodeColor : COLOR_ACTIVE;
  const configuredExistsColor = mixHex(configuredNodeColor, '#ffffff', 0.22);
  const configuredHoverColor = mixHex(configuredNodeColor, '#ffffff', 0.35);
  const themeCacheKey = `|${themeStyle}|${themeMode}`;

  // ── Scene lighting for glass materials ──────────────────────────────
  // MeshPhysicalMaterial with transmission needs lights + tone mapping to
  // render visible specular refraction. Without these the glass is black.
  const lightsRef = useRef<THREE.Light[]>([]);
  const setupLighting = useCallback((scene: THREE.Scene, accentColor: string) => {
    for (const l of lightsRef.current) { scene.remove(l); if ((l as any).dispose) (l as any).dispose(); }
    lightsRef.current = [];
    if (!isGlassTheme) return;
    const accent = new THREE.Color(configuredNodeColor || accentColor);
    const top = new THREE.DirectionalLight(0xffffff, 2.5);
    top.position.set(10, 20, 15); scene.add(top); lightsRef.current.push(top);
    const rim = new THREE.DirectionalLight(accent, 1.8);
    rim.position.set(-15, -10, -10); scene.add(rim); lightsRef.current.push(rim);
    const amb = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(amb); lightsRef.current.push(amb);
  }, [configuredNodeColor, isGlassTheme]);

  // Rebuild shared base materials when theme/mode change. Node meshes own
  // per-node clones (needed for focus opacity), so they copy from these bases.
  useEffect(() => {
    for (const m of matCacheRef.current.values()) m.dispose();
    matCacheRef.current.clear();
  }, [backgroundPattern, configuredNodeColor, isGlassTheme, isDarkMode]);

  const materialFor = (color: string, isActive: boolean) => {
    const key = `${color}|${isActive ? 'a' : 'n'}${themeCacheKey}`;
    let m = matCacheRef.current.get(key);
    if (!m) {
      if (isGlassTheme) {
        m = new THREE.MeshPhysicalMaterial({
          color: new THREE.Color(color),
          emissive: new THREE.Color(color),
          emissiveIntensity: isActive ? 0.65 : 0.15,
          roughness: 0.05,
          metalness: 0.1,
          transmission: 0,
          specularIntensity: 1.0,
          specularColor: new THREE.Color(0xffffff),
          transparent: false,
          opacity: 1.0,
        });
      } else {
        m = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.35,
          roughness: 0.45,
          metalness: 0.2,
        });
      }
      matCacheRef.current.set(key, m);
    }
    return m;
  };

  // ── World-space backdrop ─────────────────────────────────────────────
  const bgObjectRef = useRef<THREE.Mesh | null>(null);
  const BG_CELLS = 32;

  const createBackgroundTexture = (pattern: 'grid' | 'mesh') => {
    const px = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = px; canvas.height = px;
    const ctx = canvas.getContext('2d')!;
    if (pattern === 'grid') {
      ctx.strokeStyle = isGlassTheme
        ? (isDarkMode ? 'rgba(255, 255, 255, 0.06)' : 'rgba(60, 60, 67, 0.06)')
        : (isDarkMode ? 'rgba(254, 176, 93, 0.12)' : 'rgba(0, 0, 0, 0.08)');
      ctx.lineWidth = 1;
      const step = px / BG_CELLS;
      for (let i = 0; i <= BG_CELLS; i++) {
        const p = Math.round(i * step);
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, px); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(px, p); ctx.stroke();
      }
    } else {
      const step = px / 24;
      ctx.fillStyle = isGlassTheme
        ? (isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(60, 60, 67, 0.12)')
        : (isDarkMode ? 'rgba(254, 176, 93, 0.22)' : 'rgba(0, 0, 0, 0.12)');
      for (let x = step / 2; x < px; x += step)
        for (let y = step / 2; y < px; y += step)
        { ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill(); }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  };

  const createBackgroundObject = (pattern: 'grid' | 'mesh') => {
    const texture = createBackgroundTexture(pattern);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.userData.texture = texture;
    return mesh;
  };
  const disposeBackground = (mesh: THREE.Mesh) => {
    mesh.geometry.dispose();
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.map?.dispose(); mat.dispose();
  };
  const updateBackground = () => {
    const bg = bgObjectRef.current;
    if (!bg) return;
    const nodes: any[] = stableGraphRef.current?.nodes ?? graphDataRef.current.nodes;
    if (!nodes.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const n of nodes) {
      if (!Number.isFinite(n.x)) continue;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
    }
    if (minX === Infinity) return;
    const span = Math.max(maxX - minX, maxZ - minZ, 100);
    const size = span * 3;
    bg.scale.set(size, size, 1);
    bg.position.set((minX + maxX) / 2, minY - span * 0.2, (minZ + maxZ) / 2);
  };

  const colorForNode = (node: any) => {
    if (node.kind === 'topic') return TOPIC_COLOR;
    if (activeTitleRef.current && node.title?.toLowerCase() === activeTitleRef.current) return configuredNodeColor;
    return node.kind==='folder' ? '#a78bfa' : node.exists ? configuredExistsColor : COLOR_MISSING;
  };

  // ── Canvas-texture label sprite ──────────────────────────────────────
  const makeLabelSprite = (text: string): THREE.Sprite => {
    const cacheKey = `${text}::${themeModeRef.current}`;
    const cached = labelCacheRef.current.get(cacheKey);
    if (cached) return cached;
    const dpr = Math.min(window.devicePixelRatio || 1, labelQuality === 'high' ? 3 : 1);
    const fontPx = 116;
    const padX = 52; const maxTextW = 1176; const pillH = 264; const radius = 60;
    const measure = document.createElement('canvas');
    measure.width = maxTextW + padX * 2; measure.height = pillH;
    const mctx = measure.getContext('2d')!;
    mctx.font = `600 ${fontPx}px Inter, 'Segoe UI', system-ui, -apple-system, sans-serif`;
    mctx.textBaseline = 'middle';
    let label = text;
    if (mctx.measureText(label).width > maxTextW) {
      let lo = 0, hi = label.length;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (mctx.measureText(label.slice(0, mid) + '\u2026').width <= maxTextW) lo = mid; else hi = mid - 1; }
      label = label.slice(0, lo).trimEnd() + '\u2026';
    }
    const textW = Math.min(mctx.measureText(label).width, maxTextW);
    const w = textW + padX * 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(w * dpr)); canvas.height = Math.ceil(pillH * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.font = `600 ${fontPx}px Inter, 'Segoe UI', system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'middle';
    const isLight = themeModeRef.current === 'light';
    const grad = ctx.createLinearGradient(0, 0, 0, pillH);
    if (isLight) {
      grad.addColorStop(0, 'rgba(241, 245, 249, 0.95)');
      grad.addColorStop(1, 'rgba(226, 232, 240, 0.88)');
    } else {
      grad.addColorStop(0, 'rgba(43, 42, 42, 0.88)');
      grad.addColorStop(1, 'rgba(13, 14, 18, 0.78)');
    }
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(0, 0, w, pillH, radius); ctx.fill();
    ctx.strokeStyle = isLight ? 'rgba(148, 163, 184, 0.4)' : 'rgba(185, 182, 179, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(1, 1, w - 2, pillH - 2, radius - 1); ctx.stroke();
    ctx.shadowColor = isLight ? 'rgba(0, 0, 0, 0.15)' : 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = isLight ? 4 : 10;
    ctx.shadowOffsetY = isLight ? 1 : 2;
    ctx.fillStyle = isLight ? '#1e293b' : '#F5F2F2';
    ctx.textAlign = 'center';
    // Stroke halo behind text for extra contrast against pill background
    ctx.lineWidth = 3;
    ctx.strokeStyle = isLight ? 'rgba(255, 255, 255, 0.8)' : 'rgba(0, 0, 0, 0.7)';
    ctx.lineJoin = 'round';
    ctx.strokeText(label, w / 2, pillH / 2 + 1);
    ctx.fillText(label, w / 2, pillH / 2 + 1);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    try { const renderer = graphRef.current?.renderer?.(); const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 4; texture.anisotropy = Math.min(maxAniso, 8); } catch {}
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
    sprite.scale.set((LABEL_HEIGHT * w) / pillH, LABEL_HEIGHT, 1);
    sprite.userData.texture = texture;
    labelCacheRef.current.set(cacheKey, sprite);
    return sprite;
  };

  const disposeNodeGroup = (group: THREE.Group) => {
    group.traverse((child) => {
      if ((child as THREE.Mesh).geometry) (child as THREE.Mesh).geometry.dispose();
      if ((child as THREE.Mesh).material) {
        const mat = (child as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose()); else mat.dispose();
      }
      if ((child as THREE.Sprite).material) {
        const spriteMat = (child as THREE.Sprite).material;
        // Label/ring textures are shared templates owned by their caches;
        // only the per-node sprite material is disposed here.
        spriteMat.dispose();
      }
    });
  };

  // Camera-facing halo for a focused hub. One shared white ring texture is
  // tinted per kind, and per-node sprite materials fade independently.
  const ringTexture = () => {
    if (ringTextureRef.current) return ringTextureRef.current;
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
    ctx.stroke();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    ringTextureRef.current = texture;
    return texture;
  };

  // Copy only the visual properties from a shared base material; per-node
  // opacity/transparency belong to the node and must survive hover/focus.
  const copyMaterial = (target: THREE.Material, base: THREE.Material) => {
    const to = target as any;
    const from = base as any;
    if (to.color && from.color) to.color.copy(from.color);
    if (to.emissive && from.emissive) to.emissive.copy(from.emissive);
    if (typeof from.emissiveIntensity === 'number') to.emissiveIntensity = from.emissiveIntensity;
    if (typeof from.roughness === 'number') to.roughness = from.roughness;
    if (typeof from.metalness === 'number') to.metalness = from.metalness;
  };

  const nodeThreeObject = useCallback((node: any) => {
    const col = colorForNode(node);
    const isActive = activeTitleRef.current && node.title?.toLowerCase() === activeTitleRef.current;
    const base = materialFor(col, !!isActive);
    // Per-node clone: focus dimming is an opacity change, and mutating the
    // shared cached material would dim every node that uses it.
    const mesh = new THREE.Mesh(sphereGeoRef.current!, base.clone());
    const r = nodeRadius(node.linksCount ?? 0);
    mesh.scale.set(r, r, r); mesh.userData.baseScale = r;
    mesh.userData.title = node.title ?? node.id;
    mesh.userData.exists = !!node.exists;mesh.userData.kind=node.kind;
    nodeMeshesRef.current.set(node.id, mesh);

    const cachedLabel = makeLabelSprite(node.title ?? node.id);
    // Clone the sprite material (sharing the cached texture) so each node can
    // fade independently and no sprite is re-parented between groups.
    const label = new THREE.Sprite(cachedLabel.material.clone());
    label.scale.copy(cachedLabel.scale);
    label.position.set(0, r + LABEL_HEIGHT / 2 + 1.5, 0);
    nodeSpritesRef.current.set(node.id, label);

    const group = new THREE.Group();
    let ring: THREE.Sprite | null = null;
    if (node.kind === 'folder' || node.kind === 'topic') {
      const ringMaterial = new THREE.SpriteMaterial({
        map: ringTexture(),
        color: new THREE.Color(focusColor(node.kind)),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      ring = new THREE.Sprite(ringMaterial);
      const ringScale = r * 2.9;
      ring.scale.set(ringScale, ringScale, 1);
      ring.visible = false;
      nodeRingsRef.current.set(node.id, ring);
      group.add(ring);
    }
    group.add(mesh); group.add(label);
    nodeGroupsRef.current.add(group);

    // Nodes created while a spotlight is active must match it immediately,
    // before the focus effect gets a chance to run.
    const currentFocus = focusRef.current;
    if (currentFocus) {
      const opacity = currentFocus.ids.has(node.id) ? 1 : 0.2;
      const material = mesh.material as THREE.Material;
      material.transparent = opacity < 1;
      material.opacity = opacity;
      label.material.transparent = true;
      label.material.opacity = opacity;
      if (ring) {
        ring.visible = currentFocus.hubId === node.id;
        ring.material.opacity = ring.visible ? 1 : 0;
        ring.material.color.set(focusColor(currentFocus.kind));
      }
    }
    return group;
  }, [activeTitle, configuredNodeColor, configuredExistsColor, labelQuality, themeCacheKey]);

  const applyNodeColor = (mesh: THREE.Mesh) => {
    const title = mesh.userData.title as string | undefined;
    const isTopic = mesh.userData.kind === 'topic';
    const isActive = activeTitleRef.current && title && title.toLowerCase() === activeTitleRef.current;
    const col = isTopic ? TOPIC_COLOR : mesh.userData.kind==='folder' ? '#a78bfa' : isActive ? configuredNodeColor : mesh.userData.exists ? configuredExistsColor : COLOR_MISSING;
    const base = materialFor(col, !!isActive);
    const current = mesh.material as THREE.Material;
    if ((current as any).type !== (base as any).type) {
      const next = base.clone();
      (next as any).opacity = (current as any).opacity ?? 1;
      (next as any).transparent = (current as any).transparent ?? false;
      mesh.material = next;
      current.dispose();
      return;
    }
    copyMaterial(current, base);
  };

  const applyHover = (node: any | null) => {
    for (const [, mesh] of nodeMeshesRef.current) { mesh.scale.set(mesh.userData.baseScale, mesh.userData.baseScale, mesh.userData.baseScale); applyNodeColor(mesh); }
    if (node) {
      const mesh = nodeMeshesRef.current.get(node.id);
      if (mesh) {
        const s = mesh.userData.baseScale * 1.3;
        mesh.scale.set(s, s, s);
        // Topics keep their teal identity when hovered instead of borrowing the
        // accent-colored hover shade.
        const hoverColor = node.kind === 'topic' ? TOPIC_HOVER_COLOR : configuredHoverColor;
        copyMaterial(mesh.material as THREE.Material, materialFor(hoverColor, false));
      }
    }
  };

  const updateTooltip = (node: any) => {
    const g = graphRef.current;
    if (!g || typeof g.graph2ScreenCoords !== 'function') return;
    try {
      const { x, y } = g.graph2ScreenCoords(node.x, node.y, node.z);
      const next: TooltipState = { x, y, title: node.title ?? node.id, linksCount: node.linksCount ?? 0, exists: !!node.exists };
      const key = `${Math.round(x)}:${Math.round(y)}:${next.title}:${next.linksCount}:${next.exists}`;
      if (key === lastTooltipRef.current) return;
      lastTooltipRef.current = key;
      setTooltip(next);
    } catch {}
  };
  const startTooltipPoll = (node: any) => {
    if (tooltipTimerRef.current) clearInterval(tooltipTimerRef.current);
    tooltipTimerRef.current = setInterval(() => updateTooltip(node), 120);
  };
  const stopTooltipPoll = () => {
    if (tooltipTimerRef.current) { clearInterval(tooltipTimerRef.current); tooltipTimerRef.current = null; }
  };

  const handleNodeHover = useCallback((node: any | null) => {
    const nextId = node?.id ?? null;
    const previousId = lastHoveredIdRef.current;
    if (previousId && previousId !== nextId && suppressedHubRef.current === previousId) {
      suppressedHubRef.current = null;
    }
    lastHoveredIdRef.current = nextId;

    const isHub = node && (node.kind === 'folder' || node.kind === 'topic');
    if (isHub) {
      if (suppressedHubRef.current !== node.id) hoverFocusRef.current?.(node.id);
    } else {
      hoverFocusRef.current?.(null);
    }

    applyHover(node ?? null);
    if (!node) { stopTooltipPoll(); setTooltip(null); return; }
    updateTooltip(node);
    startTooltipPoll(node);
  }, [activeTitle, configuredNodeColor, configuredExistsColor, configuredHoverColor]);

  const handlePointerLeave = useCallback(() => {
    stopTooltipPoll();
    setTooltip(null);
    lastHoveredIdRef.current = null;
    suppressedHubRef.current = null;
    hoverFocusRef.current?.(null);
  }, []);

  const linkColor = useCallback(
    (link?: any) => link?.kind === 'topic'
      ? TOPIC_LINK_COLOR
      : isGlassTheme
        ? (isDarkMode ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.20)')
        : (isDarkMode ? LINK_COLOR_DARK : 'rgba(30, 41, 59, 0.15)'),
    [isGlassTheme, isDarkMode]
  );
  const particleColor = useCallback(() => hexToRgba(configuredNodeColor, 0.8), [configuredNodeColor]);

  const handleNodeClick = useCallback((node: any) => {
    const isHub = node.kind === 'folder' || node.kind === 'topic';
    if (isHub && pinnedFocusIdRef.current === node.id) {
      // A second click on the pinned hub clears it and suppresses hover until
      // the pointer leaves the node.
      suppressedHubRef.current = node.id;
      hoverFocusRef.current?.(null);
    } else if (isHub) {
      suppressedHubRef.current = null;
    }
    onSelectNoteByTitleRef.current(node.id);
  }, []);
  const handleEngineStop = useCallback(() => {
    if (!pendingFrameRef.current) return;
    pendingFrameRef.current = false;
    updateBackground();
    frameCamera(reduceMotionRef.current ? 0 : 400);
  }, []);

  const frameCamera = (duration: number) => {
    const g = graphRef.current;
    if (!g) return;
    const nodes: any[] = stableGraphRef.current?.nodes ?? graphDataRef.current.nodes;
    if (!nodes.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const n of nodes) {
      if (!Number.isFinite(n.x)) continue;
      const x = n.x ?? 0, y = n.y ?? 0, z = n.z ?? 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    if (minX === Infinity) { try { g.zoomToFit?.(duration, 40); } catch {} return; }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    const maxSide = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    const size = maxSide + LABEL_HEIGHT * 2.5;
    const fov = ((g.camera?.()?.fov ?? 50) * Math.PI) / 180;
    const dist = (size / 2 / Math.tan(fov / 2)) * 1.25;
    const dir = new THREE.Vector3(0.55, 0.8, 0.95).normalize();
    const pos = new THREE.Vector3(cx, cy, cz).addScaledVector(dir, dist);
    updateBackground();
    g.cameraPosition?.({ x: pos.x, y: pos.y, z: pos.z }, { x: cx, y: cy, z: cz }, duration);
  };

  useEffect(() => {
    const g = graphRef.current; if (!g) return;
    applyForceTuning(g);
    if (positionsCarriedRef.current) g.alpha?.(0.35);
  }, [graphData]);

  useEffect(() => {
    if (graphData.nodes.length === lastNodeCountRef.current) return;
    lastNodeCountRef.current = graphData.nodes.length;
    if (graphData.nodes.length === 0) return;
    pendingFrameRef.current = true;
  }, [graphData.nodes.length]);

  useEffect(() => { for (const [, mesh] of nodeMeshesRef.current) applyNodeColor(mesh); }, [activeTitle, configuredNodeColor, configuredExistsColor]);

  // Dim non-focused nodes and fade the hub halo. Materials are per-node, so
  // this never mutates the shared cache or re-heats the simulation.
  useEffect(() => {
    const targets: Array<{ material: THREE.Material; from: number; to: number; sprite?: THREE.Sprite }> = [];
    const ids = focus?.ids ?? null;
    for (const [id, mesh] of nodeMeshesRef.current) {
      const material = mesh.material as THREE.Material;
      targets.push({ material, from: material.opacity ?? 1, to: !ids || ids.has(id) ? 1 : 0.2 });
    }
    for (const [id, sprite] of nodeSpritesRef.current) {
      const material = sprite.material;
      targets.push({ material, from: material.opacity ?? 1, to: !ids || ids.has(id) ? 1 : 0.2 });
    }
    for (const [id, ring] of nodeRingsRef.current) {
      const isHub = !!focus && id === focus.hubId;
      if (isHub && focus) ring.material.color.set(focusColor(focus.kind));
      // Keep every halo visible while its opacity fades; the apply step hides
      // fully transparent sprites so no ring pops out of existence.
      ring.visible = true;
      targets.push({ material: ring.material, from: ring.material.opacity, to: isHub ? 1 : 0, sprite: ring });
    }

    if (focusRafRef.current !== null) {
      cancelAnimationFrame(focusRafRef.current);
      focusRafRef.current = null;
    }

    const apply = (value: number) => {
      for (const target of targets) {
        const material = target.material as any;
        const opacity = target.from + (target.to - target.from) * value;
        material.opacity = opacity;
        const transparent = !!material.isSpriteMaterial || opacity < 1;
        if (material.transparent !== transparent) {
          material.transparent = transparent;
          material.needsUpdate = true;
        }
        if (target.sprite) target.sprite.visible = opacity > 0.01;
      }
    };

    if (reduceMotionRef.current || targets.every((target) => target.from === target.to)) {
      apply(1);
      return;
    }

    const started = performance.now();
    const duration = 180;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      apply(progress);
      if (progress < 1) focusRafRef.current = requestAnimationFrame(tick);
      else focusRafRef.current = null;
    };
    focusRafRef.current = requestAnimationFrame(tick);
  }, [focus]);

  useEffect(() => {
    const g = graphRef.current, controls = g?.controls?.();
    if (!controls) return;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = autoRotate ? autoRotateSpeed : 0;
  }, [autoRotate, autoRotateSpeed]);

  // Rebuild backdrop + set up glass lighting + tone mapping when theme changes.
  useEffect(() => {
    const g = graphRef.current; if (!g) return;
    const scene = g.scene?.(); if (!scene) return;
    setupLighting(scene, COLOR_ACTIVE);
    const renderer = g.renderer?.();
    if (renderer) {
      renderer.toneMapping = isGlassTheme ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
      renderer.toneMappingExposure = 1.0;
    }
    if (bgObjectRef.current) { scene.remove(bgObjectRef.current); disposeBackground(bgObjectRef.current); bgObjectRef.current = null; }
    if (backgroundPattern === 'solid') return;
    const bg = createBackgroundObject(backgroundPattern);
    scene.add(bg); bgObjectRef.current = bg; updateBackground();
    return () => {
      for (const l of lightsRef.current) { scene.remove(l); if ((l as any).dispose) (l as any).dispose(); }
      lightsRef.current = [];
      if (bgObjectRef.current) { scene.remove(bgObjectRef.current); disposeBackground(bgObjectRef.current); bgObjectRef.current = null; }
    };
  }, [backgroundPattern, configuredNodeColor, isGlassTheme, isDarkMode]);

  useEffect(() => {
    const titles = new Set<string>();
    for (const n of graphData.nodes) { const t = n.title ?? n.id; if (t) titles.add(String(t)); }
    const nodeIds = new Set(graphData.nodes.map((n) => n.id));
    for (const id of nodeMeshesRef.current.keys()) { if (!nodeIds.has(id)) nodeMeshesRef.current.delete(id); }
    for (const id of nodeSpritesRef.current.keys()) { if (!nodeIds.has(id)) nodeSpritesRef.current.delete(id); }
    for (const id of nodeRingsRef.current.keys()) { if (!nodeIds.has(id)) nodeRingsRef.current.delete(id); }
    for (const [title, sprite] of labelCacheRef.current) {
      if (titles.has(title)) continue;
      sprite.userData.texture?.dispose?.(); sprite.material?.dispose?.();
      labelCacheRef.current.delete(title);
    }
  }, [graphData]);

  useEffect(() => {
    return () => {
      stopTooltipPoll();
      if (graphRef.current) { const controls = graphRef.current.controls?.(); if (controls) controls.dispose?.(); }
      if (focusRafRef.current !== null) cancelAnimationFrame(focusRafRef.current);
      for (const group of nodeGroupsRef.current) disposeNodeGroup(group);
      nodeGroupsRef.current.clear();
      sphereGeoRef.current?.dispose();
      for (const m of matCacheRef.current.values()) m.dispose();
      for (const sprite of labelCacheRef.current.values()) { sprite.userData.texture?.dispose?.(); sprite.material?.dispose?.(); }
      ringTextureRef.current?.dispose();
      nodeMeshesRef.current.clear();
      nodeSpritesRef.current.clear();
      nodeRingsRef.current.clear();
      labelCacheRef.current.clear();
    };
  }, []);

  const handleResetCamera = () => {
    const g = graphRef.current; if (!g) return;
    const duration = reduceMotionRef.current ? 0 : 600;
    try { g.zoomToFit?.(duration, 40); } catch { frameCamera(duration); }
  };

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]; if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(el); return () => observer.disconnect();
  }, []);

  return (
    <div data-region="graph" className="flex-1 bg-neutral-950/20 border-r border-slate-900/60 flex flex-col h-full relative select-none overflow-hidden">
      <div className="graph-header px-6 py-3.5 border-b border-slate-900/60 bg-slate-950/20 shrink-0">
        <div className="graph-header-title flex items-center gap-2">
          <Network className="w-4 h-4 text-brand-400 shrink-0" />
          <h2 className="text-sm font-semibold text-slate-100">Knowledge Network</h2>
        </div>
        <div className="graph-header-controls text-xs text-slate-500 font-medium flex items-center gap-2">
          {toolbarExtra}
          <span className="graph-hint">Drag to rotate • Scroll to zoom • Right-drag to pan</span>
          <button onClick={() => setAutoRotate((v) => !v)} title="Slowly rotate the camera around the graph" aria-pressed={autoRotate}
            className={`graph-icon-btn p-1.5 rounded-md border transition-colors flex items-center gap-1 ${autoRotate ? 'bg-brand-500/20 border-brand-500/50 text-brand-400' : 'bg-slate-900/60 border-slate-800/80 text-slate-400 hover:text-brand-400 hover:border-brand-500/50'}`}>
            <Orbit className="w-3.5 h-3.5" />
          </button>
          <button onClick={handleResetCamera} title="Reset camera to fit all nodes in view"
            className="graph-icon-btn p-1.5 rounded-md bg-slate-900/60 border border-slate-800/80 text-slate-400 hover:text-brand-400 hover:border-brand-500/50 transition-colors flex items-center gap-1">
            <Home className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div ref={containerRef} className="graph-canvas flex-1 overflow-hidden relative bg-[var(--color-base)]" title="Drag to rotate • Scroll to zoom • Right-drag to pan" onPointerLeave={handlePointerLeave}>
        <ForceGraph3D
          ref={graphRef} graphData={stableData} width={size.width} height={size.height}
          controlType="orbit"
          backgroundColor={
            themeStyle === 'gloss'
              ? (isDarkMode ? '#111318' : '#eef0f3')
              : isGlassTheme
                ? (isDarkMode ? '#060608' : '#E2E5EB')
                : (isDarkMode ? '#0D0E12' : '#EDEDF0')
          }
          nodeThreeObject={nodeThreeObject} linkColor={linkColor}
          linkWidth={0.8} linkDirectionalParticles={prefersReducedMotion ? 0 : 2} linkDirectionalParticleSpeed={0.005}
          linkDirectionalParticleWidth={1.5} linkDirectionalParticleColor={particleColor}
          onNodeClick={handleNodeClick} onNodeHover={handleNodeHover}
          onBackgroundClick={() => clearFocusRef.current?.()}
          onEngineStop={handleEngineStop}
          warmupTicks={prefersReducedMotion ? 160 : 0}
          cooldownTicks={prefersReducedMotion ? 1 : undefined}
          cooldownTime={prefersReducedMotion ? 0 : 1200}
        />
        {focusOverlay}
        {tooltip && (
          <div className="absolute z-10 pointer-events-none bg-slate-900/95 border border-slate-700/80 rounded-lg px-3 py-2 shadow-2xl backdrop-blur-sm"
            style={{ left: tooltip.x + 14, top: tooltip.y - 8, transform: 'translateY(-100%)' }}>
            <div className="text-xs font-semibold text-slate-100 max-w-[220px] truncate">{tooltip.title}</div>
            <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${tooltip.exists ? (tooltip.title.toLowerCase() === activeTitle ? 'bg-brand-500' : 'bg-brand-400') : 'bg-slate-600'}`} />
              {tooltip.linksCount} connection{tooltip.linksCount === 1 ? '' : 's'}{!tooltip.exists && ' \u2022 uncreated'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
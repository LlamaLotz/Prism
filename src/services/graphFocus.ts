import type { GraphNode, GraphLink } from '../types';

export type GraphFocusKind = 'folder' | 'topic';

/** A folder subtree or topic hub plus the nodes it spotlights. */
export interface GraphFocus {
  /** Hub node id (`folder:…` or `topic:…`). */
  hubId: string;
  kind: GraphFocusKind;
  /** Human label for the focus chip, e.g. `A` or `@research`. */
  label: string;
  /** Hub + every node in the focused set. */
  ids: Set<string>;
}

const endpointId = (endpoint: GraphLink['source'] | GraphLink['target'] | unknown): string => {
  if (endpoint && typeof endpoint === 'object') {
    const node = endpoint as { id?: unknown; title?: unknown };
    return String(node.id ?? node.title ?? '');
  }
  return String(endpoint ?? '');
};

const folderLabel = (node: GraphNode): string =>
  (node.folderPath ?? node.title.replace(/^📁\s*/, '')).trim();

/**
 * Resolves the set a folder or topic hub should spotlight.
 *
 * Folder focus follows `contains` edges downward from the hub: it includes the
 * hub, every descendant folder and every note inside the subtree. Ancestors
 * and wiki-link neighbours are deliberately excluded.
 *
 * Topic focus includes the hub and only the notes directly tagged with it — no
 * folder or wiki-link cascade. Note nodes and unknown ids return null.
 */
export function buildGraphFocus(
  graph: { nodes: GraphNode[]; links: GraphLink[] },
  id: string,
): GraphFocus | null {
  const hub = graph.nodes.find((node) => node.id === id);
  if (!hub || (hub.kind !== 'folder' && hub.kind !== 'topic')) return null;

  const ids = new Set<string>([hub.id]);

  if (hub.kind === 'folder') {
    const children = new Map<string, string[]>();
    for (const link of graph.links) {
      if (link.kind !== 'contains') continue;
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      if (!source || !target) continue;
      const list = children.get(source);
      if (list) list.push(target);
      else children.set(source, [target]);
    }

    const stack = [hub.id];
    while (stack.length) {
      const current = stack.pop()!;
      for (const child of children.get(current) ?? []) {
        if (ids.has(child)) continue;
        ids.add(child);
        stack.push(child);
      }
    }
  } else {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const link of graph.links) {
      if (link.kind !== 'topic') continue;
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      const other = source === hub.id ? target : target === hub.id ? source : '';
      // Topic links point at notes; ignore defensive folder endpoints so the
      // focus stays a tag set instead of becoming a subtree.
      if (other && byId.get(other)?.kind !== 'folder') ids.add(other);
    }
  }

  return {
    hubId: hub.id,
    kind: hub.kind,
    label: hub.kind === 'folder' ? folderLabel(hub) : hub.title || `@${hub.tag ?? ''}`,
    ids,
  };
}

/** Semantic accent for a hub kind, shared by the 2D ring and 3D halo. */
export const focusColor = (kind: GraphFocusKind): string =>
  kind === 'folder' ? '#a78bfa' : '#2dd4bf';

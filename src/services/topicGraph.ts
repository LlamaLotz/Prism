import type { GraphNode, GraphLink } from '../types';

/** Topic groups as returned by `linkerService.getTopicGroups()`. */
export type TopicGroup = [string, [string, string][]];

const normalizePath = (value: unknown): string => String(value ?? '').replaceAll('\\', '/');

/** Canonical graph id for an @tag: strips a leading @ and lowercases it. */
export const topicId = (tag: string): string =>
  `topic:${String(tag ?? '').replace(/^\s*@/, '').trim().toLowerCase()}`;

const cleanTag = (tag: unknown): string => String(tag ?? '').replace(/^\s*@/, '').trim();

/**
 * Adds the @topic layer to a note graph.
 *
 * `get_graph` ids are vault-relative (noteGraph strips the vault root) while
 * `get_topic_groups` returns full note paths, so every note_id is resolved by
 * exact id first, then by path suffix, then by a unique title. Topic nodes are
 * only created for tags with at least one resolved note; orphan/duplicate
 * groups are ignored and duplicate note links are collapsed.
 *
 * Inputs are never mutated.
 */
export function withTopics(
  graph: { nodes: GraphNode[]; links: GraphLink[] },
  groups: TopicGroup[]
): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = graph.nodes.map((node) => ({ ...node }));
  const links: GraphLink[] = graph.links.map((edge) => ({
    ...edge,
    source:
      typeof edge.source === 'object'
        ? ((edge.source as unknown as GraphNode).id ?? '')
        : edge.source,
    target:
      typeof edge.target === 'object'
        ? ((edge.target as unknown as GraphNode).id ?? '')
        : edge.target,
  }));

  // Only real note nodes can own topic links. Folder nodes and uncreated
  // wiki-link placeholders are excluded from resolution.
  const noteNodes = nodes.filter(
    (node) => node.kind !== 'folder' && node.kind !== 'topic' && node.exists !== false
  );
  const byId = new Map<string, GraphNode>();
  const byNormalizedId = new Map<string, GraphNode>();
  const byTitle = new Map<string, GraphNode[]>();
  for (const node of noteNodes) {
    byId.set(node.id, node);
    byNormalizedId.set(normalizePath(node.id), node);
    const key = node.title.trim().toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), node]);
  }

  const resolveByTitle = (value: unknown): GraphNode | undefined => {
    const matches = byTitle.get(String(value ?? '').trim().toLowerCase());
    return matches?.length === 1 ? matches[0] : undefined;
  };

  const resolveNote = (noteId: unknown, title?: unknown): GraphNode | undefined => {
    const normalized = normalizePath(noteId);
    const exact = byId.get(normalized) ?? byNormalizedId.get(normalized);
    if (exact) return exact;

    // Full vault paths end with the vault-relative graph id. Prefer the
    // longest matching suffix when several note ids are nested similarly.
    let suffix: GraphNode | undefined;
    let suffixLength = -1;
    for (const node of noteNodes) {
      const id = normalizePath(node.id);
      if (normalized === id) return node;
      if (normalized.endsWith(`/${id}`) && id.length > suffixLength) {
        suffix = node;
        suffixLength = id.length;
      }
    }
    if (suffix) return suffix;

    // Last resort: a unique title. Try the title supplied by the topic group
    // first, then the note_id itself / its basename.
    const basename = normalized.split('/').pop()?.replace(/\.md$/i, '') ?? '';
    return (
      resolveByTitle(title) ??
      resolveByTitle(normalized) ??
      resolveByTitle(basename)
    );
  };

  const topicNodes = new Map<string, GraphNode>();
  const seenLinks = new Set<string>();

  for (const group of groups ?? []) {
    if (!Array.isArray(group)) continue;
    const [rawTag, entries] = group;
    const tag = cleanTag(rawTag);
    if (!tag) continue;

    // Resolve and dedupe the group's notes before creating its topic node, so
    // a tag with no matching notes does not leave an orphan node behind.
    const resolved: GraphNode[] = [];
    const resolvedIds = new Set<string>();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!Array.isArray(entry)) continue;
      const [noteId, title] = entry;
      const note = resolveNote(noteId, title);
      if (!note || resolvedIds.has(note.id)) continue;
      resolvedIds.add(note.id);
      resolved.push(note);
    }
    if (resolved.length === 0) continue;

    const id = topicId(tag);
    let topic = topicNodes.get(id);
    if (!topic) {
      topic = {
        id,
        title: `@${tag}`,
        exists: true,
        linksCount: 0,
        kind: 'topic',
        tag,
      };
      topicNodes.set(id, topic);
      nodes.push(topic);
    }

    for (const note of resolved) {
      const key = [note.id, id].sort().join('\0');
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
      note.linksCount = (note.linksCount ?? 0) + 1;
      topic.linksCount += 1;
      links.push({ source: id, target: note.id, kind: 'topic' });
    }
  }

  return { nodes, links };
}

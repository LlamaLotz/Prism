// Force-graph fixture: mounts the real 2D <GraphView/> against a deterministic
// graph so drag behaviour (a dragged node should carry its connected
// neighbours through the link spring) can be exercised without the Tauri
// bridge.
//
// ?nodes=N       ring graph (default 5)
// ?shape=hub     one hub connected to N leaves, vault-style
import { createRoot } from 'react-dom/client';
import { GraphView } from '../../src/components/GraphView';
import type { GraphLink, GraphNode } from '../../src/types';
import '../../src/index.css';

const query = new URLSearchParams(location.search);
const count = Number(query.get('nodes')) || 5;
const hubShape = query.get('shape') === 'hub';
const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];

const titles = Array.from({ length: count }, (_, i) => names[i] ?? `Note ${i + 1}`);

const linkPairs: Array<[number, number]> = [];
if (hubShape) {
  for (let i = 1; i < count; i++) linkPairs.push([0, i]);
} else {
  for (let i = 0; i < count; i++) {
    linkPairs.push([i, (i + 1) % count]); // ring keeps every node connected
    if (i % 2 === 0 && count > 3) linkPairs.push([i, (i + 3) % count]);
  }
}

const degree = new Map<number, number>();
for (const [a, b] of linkPairs) {
  degree.set(a, (degree.get(a) ?? 0) + 1);
  degree.set(b, (degree.get(b) ?? 0) + 1);
}

const nodes: GraphNode[] = titles.map((title, i) => ({
  id: title,
  title,
  exists: true,
  linksCount: degree.get(i) ?? 1,
})) as GraphNode[];

const links: GraphLink[] = linkPairs.map(([a, b]) => ({
  source: titles[a],
  target: titles[b],
})) as GraphLink[];

createRoot(document.getElementById('root')!).render(
  <GraphView
    graphData={{ nodes, links }}
    activeNote={null}
    onSelectNoteByTitle={() => {}}
    persistNodePositions={false}
  />
);

import type { Citation, RetrievalPlan } from './knowledge';
/** Only sources actually packed into model context; old runtimes retain compatibility. */
export function mergeAgentContext(previous: { citations: Citation[]; degraded: string | null }, retrieval: RetrievalPlan | null) {
  if (!retrieval) return previous;
  const unique = new Map(previous.citations.map(c => [`${c.noteId}:${c.blockId ?? ''}`, c]));
  for (const c of retrieval.contextCitations ?? retrieval.citations) unique.set(`${c.noteId}:${c.blockId ?? ''}`, c);
  const warnings = new Set([previous.degraded, retrieval.degraded].filter((v): v is string => !!v));
  return { citations: [...unique.values()], degraded: [...warnings].join('; ') || null };
}

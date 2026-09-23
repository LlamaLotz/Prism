import { invoke } from '@tauri-apps/api/core';
export interface SearchHit { noteId: string; blockId: string | null; path: string; title: string; snippet: string; score: number; lexical: number | null; semantic: number | null }
export interface SearchPage { items: SearchHit[]; degraded: string | null; nextOffset: number | null }
export interface KnowledgeJob { id: string; kind: string; state: string; priority: number; progress: number; error: string | null }
export interface CloudApproval { id: string; destination: string; task: string; scope: string; payloadHash: string; vaultId: string }
export const knowledge = {
  search: (text: string, offset = 0) => invoke<SearchPage>('search_knowledge', { query: { text, mode: 'hybrid', offset, limit: 100 } }),
  jobs: () => invoke<KnowledgeJob[]>('list_knowledge_jobs'),
  cancel: (id: string) => invoke<void>('cancel_knowledge_job', { id }),
  approvals: () => invoke<CloudApproval[]>('list_approvals'),
  approve: (id: string, approved: boolean) => invoke<void>('resolve_approval', { id, approved }),
};

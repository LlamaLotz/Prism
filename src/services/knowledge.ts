import { invoke } from '@tauri-apps/api/core';
export interface SearchHit { noteId: string; blockId: string | null; path: string; title: string; snippet: string; score: number; lexical: number | null; semantic: number | null }
export interface SearchPage { items: SearchHit[]; degraded: string | null; nextOffset: number | null }
export interface KnowledgeJob { id: string; kind: string; state: string; priority: number; progress: number; error: string | null }
export interface CloudApproval { id: string; destination: string; task: string; scope: string; payloadHash: string; vaultId: string }
export type RetrievedBlock = {
  noteId: string;
  path: string;
  title: string;
  blockId: string | null;
  anchor: string | null;
  text: string;
  kind: string;
  headingPath: unknown;
  snippet: string;
  citation: string;
  scores: { lexical: number | null; semantic: number | null; rrf: number; explicit: number; graphProximity: number; tagOverlap: number; folderSibling: number; finalScore: number };
};
export type Citation = { noteId: string; path: string; title: string; blockId: string | null; anchor: string | null; headingPath: unknown };
export interface RetrievalPlan {
  query: string;
  activeNoteId: string | null;
  activeNotePath: string | null;
  degraded: string | null;
  blocks: RetrievedBlock[];
  citations: Citation[];
  contextText: string;
}
export type RetrievalRequest = { query: string; activeNoteId?: string | null; budgetChars?: number; offset?: number; limit?: number };

export interface AgentToolDefinition { name: string; description: string; requiresApproval: boolean; category: string }
export interface AgentToolResponse { tool: string; requiresApproval: boolean; approvalId: string | null; preview: string | null; result: unknown; error: string | null }
export interface AgentPending { id: string; tool: string; vaultId: string; notePath: string; noteId: string | null; preview: string; createdAt: number; input: unknown }

export const knowledge = {
  search: (text: string, offset = 0) => invoke<SearchPage>('search_knowledge', { query: { text, mode: 'hybrid', offset, limit: 100 } }),
  jobs: () => invoke<KnowledgeJob[]>('list_knowledge_jobs'),
  cancel: (id: string) => invoke<void>('cancel_knowledge_job', { id }),
  approvals: () => invoke<CloudApproval[]>('list_approvals'),
  approve: (id: string, approved: boolean) => invoke<void>('resolve_approval', { id, approved }),
  planRetrieval: (request: RetrievalRequest) => invoke<RetrievalPlan>('plan_retrieval', { request }),
  getContext: (request: RetrievalRequest) => invoke<RetrievalPlan>('get_context', { request }),
  agentTools: () => invoke<AgentToolDefinition[]>('agent_list_tools'),
  agentCall: (tool: string, input: unknown) => invoke<AgentToolResponse>('agent_call_tool', { request: { tool, input } }),
  agentPending: () => invoke<AgentPending[]>('agent_list_pending'),
  agentApprove: (id: string, approved: boolean) => invoke<{ approved: boolean; id: string; result?: unknown }>('agent_resolve_pending', { id, approved }),
  agentUndo: (notePath: string) => invoke<{ notePath: string; relativePath: string; restoredVersion: number | null; preview: string }>('agent_undo_last', { notePath }),
};

import { invoke } from '@tauri-apps/api/core';
import type { SourceListResponse, SourceResponse } from '../types/notebook-api';

/** Backend maximum for `GET /sources?limit` (FastAPI `Query(le=100)`).
 *  Never send a larger `query.limit` — page with `offset` instead. */
export const NOTEBOOK_SOURCE_PAGE_LIMIT = 100;
/** Backend maximum for `GET /api/commands/jobs?limit` (`prism_api.py`). */
export const NOTEBOOK_JOBS_PAGE_LIMIT = 100;
/** Assistant chat responses longer than this collapse behind a
 *  "View response" toggle (Co-Pilot sidebar + Notebook conversation). */
export const CHAT_COLLAPSE_THRESHOLD = 50;
/** Default Notebook worker concurrency (parallel background jobs). */
export const DEFAULT_WORKER_CONCURRENCY = 2;
/** Bounds for the user-configurable worker concurrency override. */
export const MIN_WORKER_CONCURRENCY = 1;
export const MAX_WORKER_CONCURRENCY = 8;

/** Normalize a worker-concurrency value; returns null when unset/invalid so
 *  callers fall back to the default instead of breaking queue behavior. */
export function normalizeWorkerConcurrency(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < MIN_WORKER_CONCURRENCY || n > MAX_WORKER_CONCURRENCY) return null;
  return n;
}

/** Resolve the effective worker concurrency: override when valid, else default. */
export function resolveWorkerConcurrency(override: unknown): number {
  return normalizeWorkerConcurrency(override) ?? DEFAULT_WORKER_CONCURRENCY;
}

export interface NotebookRuntimeStatus {
  state: 'stopped' | 'ready' | 'failed';
  workspaceId: string | null;
  vaultPath: string | null;
  message: string | null;
}

// Serialize lifecycle IPC even across StrictMode mounts and rapid vault switches.
let lifecycle: Promise<unknown> = Promise.resolve();
function sequence<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycle.then(operation, operation);
  lifecycle = result.catch(() => undefined);
  return result;
}

export const notebookRuntime = {
  start: (vaultPath: string) => sequence(() => invoke<NotebookRuntimeStatus>('notebook_start', { vaultPath })),
  stop: () => sequence(() => invoke<void>('notebook_stop')),
  status: () => invoke<NotebookRuntimeStatus>('notebook_status'),
};

export class NotebookClient {
  readonly workspaceId: string;
  private disposed = false;
  constructor(workspaceId: string) { this.workspaceId = workspaceId; }
  dispose() { this.disposed = true; }
  assertActive() { if (this.disposed) throw new Error('Notebook workspace changed.'); }

  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    this.assertActive();
    const result = await invoke<T>('notebook_request', { workspaceId: this.workspaceId, path: `/api${path}`, method, body });
    this.assertActive();
    return result;
  }
  async importCopilot(provider: string): Promise<{ modelId: string; credentialId: string }> {
    this.assertActive();
    const result = await invoke<{ modelId: string; credentialId: string }>('notebook_import_copilot', { workspaceId: this.workspaceId, provider });
    this.assertActive();
    return result;
  }
  /** Load every source for a notebook in pages of at most
   *  NOTEBOOK_SOURCE_PAGE_LIMIT, so large libraries never hit the backend
   *  `query.limit <= 100` validation and never get truncated. */
  async listAllSources(notebookId: string): Promise<SourceListResponse[]> {
    const all: SourceListResponse[] = [];
    for (let offset = 0; ; offset += NOTEBOOK_SOURCE_PAGE_LIMIT) {
      const page = await this.request<SourceListResponse[]>(
        `/sources?notebook_id=${encodeURIComponent(notebookId)}&limit=${NOTEBOOK_SOURCE_PAGE_LIMIT}&offset=${offset}`,
      );
      all.push(...page);
      if (page.length < NOTEBOOK_SOURCE_PAGE_LIMIT) break;
    }
    return all;
  }
  async source(fields: Record<string, string>, upload = false): Promise<SourceResponse | null> {
    this.assertActive();
    const result = await invoke<SourceResponse | null>('notebook_add_source', { workspaceId: this.workspaceId, fields, upload });
    this.assertActive();
    return result;
  }
  async readVaultNote(relativePath: string): Promise<string> {
    this.assertActive();
    const content = await invoke<string>('notebook_read_vault_note', { workspaceId: this.workspaceId, relativePath });
    this.assertActive();
    return content;
  }
  async export(title: string, content: string): Promise<string> {
    this.assertActive();
    const path = await invoke<string>('notebook_export', { workspaceId: this.workspaceId, title, content });
    this.assertActive();
    return path;
  }
  async media(path: string, type: string): Promise<Blob> {
    this.assertActive();
    const bytes = await invoke<ArrayBuffer>('notebook_media', { workspaceId: this.workspaceId, path: `/api${path}` });
    this.assertActive();
    return new Blob([bytes], { type });
  }
  async download(path: string, filename: string): Promise<boolean> {
    this.assertActive();
    return invoke<boolean>('notebook_download', { workspaceId: this.workspaceId, path: `/api${path}`, filename });
  }
}

export function recordId(id: string): string {
  // SurrealDB record IDs returned by this pinned API contain no path separators.
  if (!/^[a-zA-Z0-9_:\-]+$/.test(id)) throw new Error('Invalid Notebook record identifier');
  return id;
}

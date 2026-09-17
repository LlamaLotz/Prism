import { invoke } from '@tauri-apps/api/core';
import type { SourceResponse } from '../types/notebook-api';

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
}

export function recordId(id: string): string {
  // SurrealDB record IDs returned by this pinned API contain no path separators.
  if (!/^[a-zA-Z0-9_:\-]+$/.test(id)) throw new Error('Invalid Notebook record identifier');
  return id;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

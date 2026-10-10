import { invoke } from '@tauri-apps/api/core';
export interface ImportOptions { requireExistingFolder?:boolean; name: string; folder: string; splitLevel: number | null; keepSource: boolean; separateCopy: boolean; excludedOutputs: string[] }
export interface ImportSummary { id: string; title: string; state: string; revision: string; outputs: number; needsRefresh: boolean }
export interface PreviewOutput { key: string; name: string; path: string; markdown: string; totalChars: number; conflict: string | null }
export interface ImportPreview { conflicts: number; retainedTotal: number; skippedTotal: number; skipped: [string, string][]; id: string; token: string; options: ImportOptions; outputs: PreviewOutput[]; offset: number; total: number; warnings: string[]; retained: string[]; needsRefresh: boolean }
export interface DocumentSource { blockId: string; revision: string; title: string; extractor: string; extractorVersion: string; excerpt: string; modified: boolean; source: string; sourceStatus: string; retained: boolean; location: null | { page?: number; slide?: number; sheet?: string; cells?: string; bbox?: number[]; textRange?: number[]; timeRange?: number[]; url?: string } }
export const documents = {
  prepare: (kind: 'file' | 'url', value: string, method = 'yt-dlp', savedRevision: string | null = null, folder = '') => invoke<ImportSummary>('prepare_document_import', { request: { kind, value, method, savedRevision, folder } }),
  list: () => invoke<ImportSummary[]>('list_document_imports'),
  preview: (id: string, offset = 0, limit = 100, contentOffset = 0) => invoke<ImportPreview>('get_document_preview', { id, offset, limit, contentOffset }),
  update: (id: string, options: ImportOptions) => invoke<void>('update_document_import', { id, options }),
  recover: (id: string) => invoke<void>('recover_document_import', { id }),
  commit: (id: string, token: string) => invoke<{ operationId: string; undoAvailable: boolean; paths: string[] }>('commit_document_import', { id, token }),
  noteSources: (path: string, offset = 0) => invoke<{entries: {blockId:string;excerpt:string;line:number}[]; offset:number; total:number}>('list_note_document_sources', {path, offset}),
  source: (blockId: string) => invoke<DocumentSource>('get_document_source', { blockId }),
  openSource: (blockId: string) => invoke<void>('open_document_source', { blockId }),
};

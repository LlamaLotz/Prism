import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  ResearchCandidatesEvent,
  ResearchPhaseEvent,
  ResearchSession,
  ResearchStartArgs,
} from '../types';
import type { Collection } from './study';

export interface ResearchPreview {
  title: string;
  text: string;
  url?: string;
  chars: number;
}

export interface ResearchSubscription {
  onPhase?: (event: ResearchPhaseEvent) => void;
  onCandidates?: (event: ResearchCandidatesEvent) => void;
}

/**
 * Typed bridge to the Rust research runtime. Events are token-scoped: a newer
 * run must never receive a stale candidate list from an older job.
 */
export const researchRuntime = {
  start: (args: ResearchStartArgs) =>
    invoke<{ jobId: string; sessionId: string }>('research_start', { ...args }),
  cancel: (jobId: string) =>
    invoke<void>('research_cancel', { jobId }),
  get: (sessionId: string) =>
    invoke<ResearchSession>('research_get', { sessionId }),
  addSources: (vaultPath: string, collectionId: string, keys: string[]) =>
    invoke<Collection>('research_add_sources', { vaultPath, collectionId, keys }),
  createNotes: (vaultPath: string, keys: string[], folder: string) =>
    invoke<{ folder: string; paths: string[] }>('research_create_notes', { vaultPath, keys, folder }),
  addUrl: (vaultPath: string, collectionId: string, url: string) =>
    invoke<Collection>('research_add_url', { vaultPath, collectionId, url }),
  preview: (key: string) =>
    invoke<ResearchPreview>('research_preview', { key }),
  /** Listen for this job's phase/candidate events. Returns a synchronous stop. */
  subscribe(jobId: string, handlers: ResearchSubscription): () => void {
    let stopped = false;
    let stops: UnlistenFn[] = [];
    const registrations = [
      listen<ResearchPhaseEvent>('research-phase', ({ payload }) => {
        if (payload.jobId === jobId) handlers.onPhase?.(payload);
      }),
      listen<ResearchCandidatesEvent>('research-candidates', ({ payload }) => {
        if (payload.jobId === jobId) handlers.onCandidates?.(payload);
      }),
    ];
    void Promise.all(registrations)
      .then((unlistens) => {
        if (stopped) unlistens.forEach((stop) => stop());
        else stops = unlistens;
      })
      .catch(() => {});
    return () => {
      stopped = true;
      stops.forEach((stop) => stop());
      stops = [];
    };
  },
};

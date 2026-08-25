import { check, Update } from '@tauri-apps/plugin-updater';
import { tauriAPI } from '../types';
import { useState, useCallback, useRef } from 'react';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'update-available'
  | 'downloading'
  | 'download-progress'
  | 'ready'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  /** Human-readable status message shown in the UI. */
  message: string;
  /** Available update version string (e.g. "1.2.0"). */
  version: string | null;
  /** Release notes / body from the latest release. */
  notes: string | null;
  /** Download progress 0–100 (only meaningful while `downloading`). */
  progress: number;
  /** Resolved update object — held in a ref so the "download" flow can use it. */
  _update: Update | null;
}

const INITIAL: UpdateState = {
  status: 'idle',
  message: '',
  version: null,
  notes: null,
  progress: 0,
  _update: null,
};

/**
 * React hook wrapping @tauri-apps/plugin-updater. Provides:
 *  - `checkForUpdates()`     → manual trigger
 *  - `downloadAndInstall()`   → downloads the resolved update, then restarts the app
 *  - `state`                 → current status, message, version, notes, progress
 */
export function useUpdateCheck() {
  const [state, setState] = useState<UpdateState>(INITIAL);
  const updateRef = useRef<Update | null>(null);

  const checkForUpdates = useCallback(async () => {
    setState((s) => ({ ...s, status: 'checking', message: 'Checking for updates…', version: null, notes: null, progress: 0 }));

    try {
      const update = await check();

      if (!update) {
        updateRef.current = null;
        setState((s) => ({ ...s, status: 'up-to-date', message: 'You are running the latest version.', version: null, notes: null }));
        return;
      }

      updateRef.current = update;
      setState((s) => ({
        ...s,
        status: 'update-available',
        message: `Version ${update.version} is available.`,
        version: update.version,
        notes: update.body ?? null,
      }));
    } catch (err: any) {
      console.error('[updater] check failed:', err);
      updateRef.current = null;
      // Distinguish "no endpoint" from genuine network errors.
      const msg =
        err?.message || err?.toString?.() || '';
      const isNetworkErr =
        /fetch|network|dns|refused|timeout|econn/i.test(msg);
      setState((s) => ({
        ...s,
        status: 'error',
        message: isNetworkErr
          ? 'Failed to check for updates. Please check your internet connection.'
          : `Update check failed: ${msg || 'Unknown error'}`,
        version: null,
        notes: null,
      }));
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;

    setState((s) => ({
      ...s,
      status: 'downloading',
      message: 'Downloading update…',
      progress: 0,
    }));

    try {
      // Track download progress via content-length / downloaded bytes.
      // The updater plugin emits progress via the update object; we poll
      // via listening for events or just wait for completion.
      let downloaded = 0;
      let contentLength = 0;

      await update.download((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? 0;
            setState((s) => ({
              ...s,
              status: 'downloading',
              message: contentLength
                ? `Downloading (${(contentLength / 1024 / 1024).toFixed(1)} MB)…`
                : 'Downloading…',
            }));
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            const pct = contentLength > 0 ? Math.round((downloaded / contentLength) * 100) : 0;
            setState((s) => ({
              ...s,
              status: 'download-progress',
              progress: Math.min(pct, 99),
              message: `Downloading… ${pct}%`,
            }));
            break;
          case 'Finished':
            setState((s) => ({ ...s, status: 'download-progress', progress: 100, message: 'Download complete. Installing…' }));
            break;
        }
      });

      // Install the update; this replaces the current binary and relaunches.
      setState((s) => ({
        ...s,
        status: 'ready',
        message: 'Update installed. Restarting…',
      }));

      await update.install();

      // Restart the app into the new version.
      await tauriAPI.relaunchApp();
    } catch (err: any) {
      console.error('[updater] download/install failed:', err);
      const msg = err?.message || err?.toString?.() || '';
      setState((s) => ({
        ...s,
        status: 'error',
        message: `Update failed: ${msg || 'Unknown error'}`,
        progress: 0,
      }));
    }
  }, []);

  /** Dismiss the result banner (resets to idle). */
  const dismiss = useCallback(() => {
    setState(INITIAL);
    updateRef.current = null;
  }, []);

  return { state, checkForUpdates, downloadAndInstall, dismiss };
}
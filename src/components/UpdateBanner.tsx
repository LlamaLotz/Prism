import React, { useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2, RefreshCw, X } from 'lucide-react';
import { tauriAPI } from '../types';
import {
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  updateNotes,
  type UpdateStatus,
} from '../services/updater';

export const UpdateBanner: React.FC = () => {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Keep regular browser/Vite previews free of updater IPC calls.
    if (!('__TAURI_INTERNALS__' in window)) return;

    let cancelled = false;
    setStatus({ state: 'checking' });
    checkForAppUpdate()
      .then((update) => {
        if (cancelled) return;
        setStatus(update ? { state: 'available', update } : { state: 'idle' });
      })
      .catch((error) => {
        if (cancelled) return;
        // Update checks are best-effort. Offline users should not see an
        // error banner; keep the failure in diagnostics and leave the app
        // usable.
        console.warn('[updater] update check failed:', error);
        setStatus({ state: 'idle' });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed || status.state === 'idle' || status.state === 'checking' || status.state === 'up-to-date') return null;

  const install = async () => {
    if (status.state !== 'available') return;
    const update = status.update;
    setStatus({ state: 'downloading', update, downloaded: 0 });
    try {
      await downloadAndInstallAppUpdate(update, (downloaded, total) => {
        setStatus({ state: 'downloading', update, downloaded, total });
      });
      setStatus({ state: 'installed', version: update.version });
      // Tauri exits automatically while installing on Windows. On macOS/Linux
      // this restarts the newly installed app when the install call returns.
      await tauriAPI.relaunchApp();
    } catch (error) {
      console.error('[updater] install failed:', error);
      setStatus({ state: 'error', message: String(error) });
    }
  };

  if (status.state === 'error') {
    return (
      <div className="fixed right-4 top-12 z-[90] flex max-w-[min(420px,calc(100vw-2rem))] items-start gap-3 border border-rose-400/30 bg-slate-950/95 px-4 py-3 text-xs text-slate-300 shadow-2xl backdrop-blur-md">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-rose-300">Update check failed</div>
          <div className="mt-1 break-words text-slate-500">{status.message}</div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 p-1 text-slate-500 transition-colors hover:text-slate-200"
          title="Dismiss update message"
          aria-label="Dismiss update message"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  if (status.state === 'installed') {
    return (
      <div className="fixed right-4 top-12 z-[90] flex items-center gap-3 border border-emerald-400/30 bg-slate-950/95 px-4 py-3 text-xs text-slate-200 shadow-2xl backdrop-blur-md">
        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
        Prism {status.version} installed. Restarting...
      </div>
    );
  }

  const percent = status.state === 'downloading' && status.total
    ? Math.min(100, Math.round((status.downloaded / status.total) * 100))
    : 0;
  const update = status.update;

  return (
    <div className="fixed right-4 top-12 z-[90] w-[min(440px,calc(100vw-2rem))] border border-brand-400/30 bg-slate-950/95 p-4 text-slate-200 shadow-2xl backdrop-blur-md">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 text-brand-400">
          {status.state === 'downloading' ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Download className="h-5 w-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Prism {update.version} is available</div>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
            {updateNotes(update)}
          </p>
          {status.state === 'downloading' && (
            <div className="mt-3">
              <div className="mb-1 flex justify-between text-[11px] text-slate-500">
                <span>Downloading update</span>
                <span>{status.total ? `${percent}%` : 'Preparing...'}</span>
              </div>
              <div className="h-1.5 overflow-hidden bg-slate-800">
                <div
                  className="h-full bg-brand-500 transition-[width] duration-150"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          )}
          {status.state === 'available' && (
            <button
              type="button"
              onClick={install}
              className="mt-3 inline-flex items-center gap-1.5 bg-brand-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-brand-400"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Install and restart
            </button>
          )}
        </div>
        {status.state === 'available' && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 p-1 text-slate-500 transition-colors hover:text-slate-200"
            title="Remind me later"
            aria-label="Remind me later"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
};

import { check, type Update } from '@tauri-apps/plugin-updater';

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; update: Update }
  | { state: 'downloading'; update: Update; downloaded: number; total?: number }
  | { state: 'installed'; version: string }
  | { state: 'up-to-date' }
  | { state: 'error'; message: string };

export async function checkForAppUpdate(): Promise<Update | null> {
  return check({ timeout: 15_000 });
}

export function updateNotes(update: Update): string {
  return update.body?.trim() || `Prism ${update.version} is ready to install.`;
}

export async function downloadAndInstallAppUpdate(
  update: Update,
  onProgress: (downloaded: number, total?: number) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | undefined;

  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength;
      onProgress(downloaded, total);
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength;
      onProgress(downloaded, total);
    }
  });
}

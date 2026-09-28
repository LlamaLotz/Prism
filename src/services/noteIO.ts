import { invoke } from '@tauri-apps/api/core';
export const MAX_NOTE_BYTES = 50 * 1024 * 1024;
export const LARGE_NOTE_BYTES = 200_000;
const STREAM_SAVE_BYTES = 1024 * 1024;
const revisions = new Map<string, string>();
const sizes = new Map<string, number>();
const saves = new Map<string, Promise<void>>();
interface NoteChunk { text: string; revision: string; nextOffset: number | null; bytes: number }
export async function readNote(path: string): Promise<string> {
  const chunks: string[] = [];
  let offset = 0;
  let revision: string | null = null;
  let size = 0;
  do {
    const chunk: NoteChunk = await invoke('read_note_chunk', { path, offset, expectedRevision: revision });
    if (chunk.bytes > MAX_NOTE_BYTES) throw new Error('NOTE_TOO_LARGE: Open notes above 50 MiB in an external editor.');
    if (chunk.nextOffset !== null && chunk.nextOffset <= offset) throw new Error('Invalid note read progress');
    chunks.push(chunk.text); revision = chunk.revision; size = chunk.bytes;
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  } while (true);
  revisions.set(path, revision!); sizes.set(path, size);
  return chunks.join('');
}
export async function writeNote(path: string, content: string): Promise<void> {
  // Serialize saves of one file so each submission uses the prior acknowledged revision.
  const previous = saves.get(path) ?? Promise.resolve();
  const saving = previous.catch(() => {}).then(async () => {
    const size = new Blob([content]).size;
    if (size > MAX_NOTE_BYTES) throw new Error('NOTE_TOO_LARGE: Notes are limited to 50 MiB. Your unsaved edits remain in the editor.');
    if (size <= STREAM_SAVE_BYTES && (sizes.get(path) ?? 0) <= STREAM_SAVE_BYTES) {
      await invoke('write_file', { filePath: path, content });
      const current: NoteChunk = await invoke('read_note_chunk', { path, offset: 0, expectedRevision: null });
      revisions.set(path, current.revision);
      sizes.set(path, current.bytes);
      return;
    }
    const expectedRevision = revisions.get(path);
    if (!expectedRevision) throw new Error('CONFLICT: Reload this note before saving a large document.');
    const id = await invoke<string>('begin_note_save', { path, expectedRevision });
    try {
      let offset = 0;
      for (let start = 0; start < content.length;) {
        // 60k UTF-16 units cannot exceed the backend 256 KiB byte cap.
        let end = Math.min(content.length, start + 60_000);
        if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
        const text = content.slice(start, end);
        await invoke('append_note_save', { id, offset, text });
        offset += new Blob([text]).size; start = end;
      }
      revisions.set(path, await invoke<string>('finish_note_save', { id })); sizes.set(path, size);
    } catch (error) { await invoke('cancel_note_save', { id }).catch(() => {}); throw error; }
  });
  saves.set(path, saving);
  try { await saving; } finally { if (saves.get(path) === saving) saves.delete(path); }
}

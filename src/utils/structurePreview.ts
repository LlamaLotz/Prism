import type { OutlineNode } from '../services/structure';

/** Minimal outline shape shared by the formatter preview and local parsing. */
export interface OutlineEntry {
  title: string;
  level: number;
  children: OutlineEntry[];
}

export interface BoundedTextPreview {
  text: string;
  truncated: boolean;
  totalChars: number;
}

/**
 * Parses ATX headings into a nested outline without splitting the whole note.
 * Line scanning stops at `maxLines` so opening the preview on a multi-MB note
 * never walks the entire document just to draw its headings.
 */
export function markdownOutline(content: string, maxLines = 20_000): OutlineEntry[] {
  if (!content) return [];
  const roots: OutlineEntry[] = [];
  const stack: OutlineEntry[] = [];
  const total = content.length;
  // Headings live on short lines. Stop after a bounded slice so a huge note
  // cannot block the preview while we look for section titles.
  const scanLimit = Math.min(total, 2_000_000);
  let offset = 0;
  let lineNumber = 0;
  let inFence = false;
  let fenceChar = '';

  while (offset < scanLimit && lineNumber < maxLines) {
    let end = content.indexOf('\n', offset);
    if (end < 0 || end > scanLimit) end = scanLimit;
    const line = end - offset <= 4096 ? content.slice(offset, end) : '';
    offset = end + 1;
    lineNumber++;

    const trimmed = line.trimStart();
    const fence = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
      } else if (fence[1][0] === fenceChar) {
        inFence = false;
        fenceChar = '';
      }
      continue;
    }
    if (inFence) continue;

    const heading = line.match(/^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/);
    if (!heading) continue;
    const level = heading[1].length;
    const title = heading[2].trim() || 'Untitled heading';
    const entry: OutlineEntry = { title, level, children: [] };

    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length > 0) stack[stack.length - 1].children.push(entry);
    else roots.push(entry);
    stack.push(entry);
  }

  return roots;
}

export function outlineFromNodes(nodes: OutlineNode[] | null | undefined): OutlineEntry[] {
  return (nodes ?? []).map((node) => ({
    title: node.title || 'Untitled heading',
    level: node.level,
    children: outlineFromNodes(node.children),
  }));
}

export function countOutlineEntries(entries: OutlineEntry[]): number {
  return entries.reduce((total, entry) => total + 1 + countOutlineEntries(entry.children), 0);
}

/**
 * Produces a bounded, render-safe preview string. The returned text never
 * exceeds `maxChars` (or `maxLines` newlines), so a large backend response is
 * never mounted into the DOM in full.
 */
export function boundedTextPreview(
  text: string,
  maxChars = 120_000,
  maxLines = 1_200
): BoundedTextPreview {
  const totalChars = text.length;
  if (totalChars <= maxChars) {
    let lineBreaks = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 && ++lineBreaks >= maxLines) {
        return {
          text: text.slice(0, i),
          truncated: i < text.length,
          totalChars,
        };
      }
    }
    return { text, truncated: false, totalChars };
  }

  const limit = Math.min(totalChars, maxChars);
  let end = limit;
  let lineBreaks = 0;
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10 && ++lineBreaks >= maxLines) {
      end = i;
      break;
    }
  }
  return { text: text.slice(0, end), truncated: true, totalChars };
}

/** Splits a joined `parent/section` relative path into safe display text. */
export function displaySectionPath(sectionDir: string, fileName: string): string {
  return sectionDir ? `${sectionDir}/${fileName}.md` : `${fileName}.md`;
}

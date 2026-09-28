export interface SparseLineIndex {
  starts: Uint32Array;
  lineCount: number;
  stride: number;
}

export function buildSparseLineIndex(text: string, stride = 256): SparseLineIndex {
  let lineCount = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineCount++;
  const starts = new Uint32Array(Math.ceil((lineCount - 1) / stride) + 1);
  let line = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      if (line % stride === 0) starts[line / stride] = i + 1;
    }
  }
  return { starts, lineCount, stride };
}

export function getLineRange(text: string, index: SparseLineIndex, start: number, end: number): string[] {
  const first = Math.max(0, Math.min(start, index.lineCount));
  const last = Math.max(first, Math.min(end, index.lineCount));
  if (first === last) return [];
  const baseLine = Math.floor(first / index.stride) * index.stride;
  let line = baseLine;
  let offset = index.starts[baseLine / index.stride];
  while (line < first) {
    const newline = text.indexOf('\n', offset);
    if (newline < 0) return [];
    offset = newline + 1;
    line++;
  }
  const result: string[] = [];
  while (line < last) {
    const newline = text.indexOf('\n', offset);
    if (newline < 0) {
      result.push(text.slice(offset));
      break;
    }
    result.push(text.slice(offset, newline));
    offset = newline + 1;
    line++;
  }
  return result;
}

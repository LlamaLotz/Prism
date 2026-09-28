import { expect, test } from '@playwright/test';
import { buildSparseLineIndex, getLineRange } from '../../src/utils/largeText';

test('sparse large-note line index extracts bounded ranges across index boundaries', () => {
  const text = Array.from({ length: 700 }, (_, i) => `line-${i}`).join('\n');
  const index = buildSparseLineIndex(text);
  expect(index.lineCount).toBe(700);
  expect(getLineRange(text, index, 0, 3)).toEqual(['line-0', 'line-1', 'line-2']);
  expect(getLineRange(text, index, 254, 259)).toEqual([
    'line-254', 'line-255', 'line-256', 'line-257', 'line-258',
  ]);
  expect(getLineRange(text, index, 698, 700)).toEqual(['line-698', 'line-699']);
});

test('sparse line index distinguishes empty text and a trailing newline', () => {
  const empty = buildSparseLineIndex('');
  expect(getLineRange('', empty, 0, 1)).toEqual(['']);
  const trailing = buildSparseLineIndex('a\nb\n');
  expect(trailing.lineCount).toBe(3);
  expect(getLineRange('a\nb\n', trailing, 0, 3)).toEqual(['a', 'b', '']);
});

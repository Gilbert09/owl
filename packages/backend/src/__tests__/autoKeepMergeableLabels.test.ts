import { describe, it, expect } from 'vitest';
import { normalizeLabelNames, parseAutoKeepMergeableLabels } from '@talyn/shared';
import { normalizeWatchLabels } from '../services/prAutoMergeWatcher.js';

describe('normalizeLabelNames', () => {
  it.each([
    { input: [], expected: [] },
    { input: ['', '  '], expected: [] },
    { input: [' auto-review '], expected: ['auto-review'] },
    { input: ['auto-review', 'stamp'], expected: ['auto-review', 'stamp'] },
    { input: ['Auto-Review', 'auto-review'], expected: ['Auto-Review'] },
    { input: ['a,b'], expected: ['a,b'] },
  ])('normalizes $input', ({ input, expected }) => {
    expect(normalizeLabelNames(input)).toEqual(expected);
  });
});

describe('parseAutoKeepMergeableLabels', () => {
  it.each([
    { input: '', expected: [] },
    { input: '   ', expected: [] },
    { input: ',,,', expected: [] },
    { input: 'auto-review', expected: ['auto-review'] },
    { input: 'auto-review, stamp', expected: ['auto-review', 'stamp'] },
    { input: 'auto-review,stamp', expected: ['auto-review', 'stamp'] },
    { input: '  auto-review ,  stamp  ', expected: ['auto-review', 'stamp'] },
    { input: 'auto-review, , stamp,', expected: ['auto-review', 'stamp'] },
    { input: 'auto-review, auto-review', expected: ['auto-review'] },
    { input: 'Auto-Review, auto-review', expected: ['Auto-Review'] },
    { input: 'needs review, ready to stamp', expected: ['needs review', 'ready to stamp'] },
  ])('parses $input', ({ input, expected }) => {
    expect(parseAutoKeepMergeableLabels(input)).toEqual(expected);
  });
});

describe('normalizeWatchLabels', () => {
  it.each([
    { input: undefined, expected: [] },
    { input: null, expected: [] },
    { input: 'auto-review', expected: [] },
    { input: [], expected: [] },
    { input: ['auto-review'], expected: ['auto-review'] },
    { input: [' auto-review ', ''], expected: ['auto-review'] },
    { input: ['auto-review', 42, null, 'stamp'], expected: ['auto-review', 'stamp'] },
    { input: ['stamp', 'Stamp'], expected: ['stamp'] },
  ])('normalizes $input', ({ input, expected }) => {
    expect(normalizeWatchLabels(input)).toEqual(expected);
  });
});

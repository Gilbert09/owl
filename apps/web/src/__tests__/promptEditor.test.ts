import { describe, it, expect } from 'vitest';
import { insertVariableAt } from '../lib/promptEditor';

const value = { name: 'pr.url', shape: 'value' as const };
const block = { name: 'gitRules', shape: 'block' as const };

describe('insertVariableAt', () => {
  it('inserts an inline variable at the caret and places the caret after it', () => {
    const r = insertVariableAt('Fix  now', 4, 4, value);
    expect(r.text).toBe('Fix {{pr.url}} now');
    expect(r.caret).toBe('Fix {{pr.url}}'.length);
  });

  it('replaces a selection', () => {
    const r = insertVariableAt('Fix THIS now', 4, 8, value);
    expect(r.text).toBe('Fix {{pr.url}} now');
  });

  it.each([
    ['at the very start', '', 0, 0, '{{gitRules}}'],
    ['at the end of a line', 'a', 1, 1, 'a\n{{gitRules}}'],
    ['at the start of a line', 'a\nb', 2, 2, 'a\n{{gitRules}}\nb'],
    ['mid-line', 'ab', 1, 1, 'a\n{{gitRules}}\nb'],
    ['between blank lines', 'a\n\nb', 2, 2, 'a\n{{gitRules}}\nb'],
  ])('puts a block variable on its own line %s', (_label, text, start, end, expected) => {
    expect(insertVariableAt(text, start, end, block).text).toBe(expected);
  });

  it('appends at the end when the caret is at the end', () => {
    const r = insertVariableAt('abc', 3, 3, value);
    expect(r.text).toBe('abc{{pr.url}}');
    expect(r.caret).toBe(r.text.length);
  });
});

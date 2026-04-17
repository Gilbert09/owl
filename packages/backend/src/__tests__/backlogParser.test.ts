import { describe, it, expect } from 'vitest';
import { parseMarkdownBacklog } from '../services/backlog/parser.js';

describe('parseMarkdownBacklog', () => {
  it('parses a flat list of checkboxes', () => {
    const md = `
- [ ] first item
- [x] second item
- [ ] third item
`;
    const items = parseMarkdownBacklog(md);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ text: 'first item', completed: false, blocked: false, orderIndex: 0 });
    expect(items[1]).toMatchObject({ text: 'second item', completed: true, orderIndex: 1 });
    expect(items[2]).toMatchObject({ text: 'third item', completed: false, orderIndex: 2 });
  });

  it('honors nesting via indentation', () => {
    const md = `
- [ ] parent
  - [ ] child
    - [ ] grandchild
- [ ] sibling
`;
    const items = parseMarkdownBacklog(md);
    expect(items).toHaveLength(4);
    const [parent, child, grandchild, sibling] = items;
    expect(parent.parentExternalId).toBeUndefined();
    expect(child.parentExternalId).toBe(parent.externalId);
    expect(grandchild.parentExternalId).toBe(child.externalId);
    expect(sibling.parentExternalId).toBeUndefined();
  });

  it('restricts parsing to a named section when given', () => {
    const md = `
# Ignored

- [ ] not this one

## Priority Queue

- [ ] first priority
- [ ] second priority

## After

- [ ] also ignored
`;
    const items = parseMarkdownBacklog(md, { section: 'Priority Queue' });
    expect(items.map((item) => item.text)).toEqual(['first priority', 'second priority']);
  });

  it('stops at a heading of equal or higher level', () => {
    const md = `
## Section A
- [ ] a1
- [ ] a2
### Section A sub
- [ ] a3
## Section B
- [ ] b1
`;
    const items = parseMarkdownBacklog(md, { section: 'Section A' });
    expect(items.map((item) => item.text)).toEqual(['a1', 'a2', 'a3']);
  });

  it('returns empty when the section is missing', () => {
    const md = `# Foo\n- [ ] noise\n`;
    expect(parseMarkdownBacklog(md, { section: 'Missing' })).toEqual([]);
  });

  it('flags blocked items', () => {
    const md = `
- [ ] ready to go
- [ ] waiting (blocked)
- [ ] parked [blocked] on design review
- [ ] not blocked: just has the word
`;
    const items = parseMarkdownBacklog(md);
    expect(items[0].blocked).toBe(false);
    expect(items[1].blocked).toBe(true);
    expect(items[2].blocked).toBe(true);
    // word 'blocked' alone (without parens/brackets) should NOT flag
    expect(items[3].blocked).toBe(false);
  });

  it('produces stable external ids across reparses', () => {
    const md = `
- [ ] first
  - [ ] nested
- [ ] second
`;
    const first = parseMarkdownBacklog(md);
    const second = parseMarkdownBacklog(md);
    expect(first.map((item) => item.externalId)).toEqual(second.map((item) => item.externalId));
  });

  it('gives different external ids when text differs or nesting differs', () => {
    const a = parseMarkdownBacklog(`- [ ] same text\n  - [ ] child\n`);
    const b = parseMarkdownBacklog(`- [ ] same text\n- [ ] child\n`);
    // root items are the same, child is different (different parents)
    expect(a[0].externalId).toBe(b[0].externalId);
    expect(a[1].externalId).not.toBe(b[1].externalId);
  });

  it('ignores blank checkbox lines', () => {
    const md = `
- [ ]
- [ ] real one
`;
    const items = parseMarkdownBacklog(md);
    expect(items.map((item) => item.text)).toEqual(['real one']);
  });

  it('matches heading by prefix (case-insensitive)', () => {
    const md = `
## Priority Queue (Next Up)
- [ ] do it
`;
    const items = parseMarkdownBacklog(md, { section: 'priority queue' });
    expect(items.map((item) => item.text)).toEqual(['do it']);
  });
});

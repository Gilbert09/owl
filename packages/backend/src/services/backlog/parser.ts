import { createHash } from 'node:crypto';

export interface ParsedBacklogItem {
  externalId: string;
  text: string;
  parentExternalId?: string;
  completed: boolean;
  blocked: boolean;
  orderIndex: number;
}

export interface ParseOptions {
  /** If set, only parse checkboxes under a heading with this title (case-insensitive). */
  section?: string;
}

const CHECKBOX_RE = /^(\s*)-\s+\[([ xX])\]\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * Parse GitHub-flavored markdown checklist into backlog items.
 *
 * Nesting is preserved via indentation: an item indented past its preceding
 * item becomes a child. External IDs are a stable hash of text + parent id,
 * so lightly reordering items in the source doesn't churn the DB, but editing
 * an item's text does create a new id (the old one is retired on next sync).
 */
export function parseMarkdownBacklog(
  markdown: string,
  opts: ParseOptions = {}
): ParsedBacklogItem[] {
  const lines = markdown.split('\n');
  const { startLine, endLine } = resolveSectionRange(lines, opts.section);
  if (startLine === -1) return [];

  const items: ParsedBacklogItem[] = [];
  const indentStack: { indent: number; externalId: string }[] = [];
  let orderIndex = 0;

  for (let i = startLine; i < endLine; i++) {
    const match = CHECKBOX_RE.exec(lines[i]);
    if (!match) continue;

    const indent = match[1].length;
    const text = match[3].trim();
    if (!text) continue;

    const completed = match[2] === 'x' || match[2] === 'X';
    const blocked = detectBlocked(text);

    while (
      indentStack.length > 0 &&
      indentStack[indentStack.length - 1].indent >= indent
    ) {
      indentStack.pop();
    }
    const parent = indentStack[indentStack.length - 1];

    const externalId = hashItem(text, parent?.externalId);
    items.push({
      externalId,
      text,
      parentExternalId: parent?.externalId,
      completed,
      blocked,
      orderIndex: orderIndex++,
    });
    indentStack.push({ indent, externalId });
  }

  return items;
}

function resolveSectionRange(
  lines: string[],
  section?: string
): { startLine: number; endLine: number } {
  if (!section) {
    return { startLine: 0, endLine: lines.length };
  }

  const target = section.toLowerCase().trim();
  let startLine = -1;
  let endLine = lines.length;
  let sectionLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = HEADING_RE.exec(lines[i]);
    if (!match) continue;
    const level = match[1].length;
    const title = match[2].toLowerCase().trim();

    if (startLine === -1) {
      if (title === target || title.startsWith(target)) {
        startLine = i + 1;
        sectionLevel = level;
      }
    } else if (level <= sectionLevel) {
      endLine = i;
      break;
    }
  }

  return { startLine, endLine };
}

function detectBlocked(text: string): boolean {
  return /\(blocked\)/i.test(text) || /\[blocked\]/i.test(text);
}

function hashItem(text: string, parent?: string): string {
  const h = createHash('sha1');
  h.update(text);
  if (parent) h.update('\u0000' + parent);
  return h.digest('hex').slice(0, 16);
}

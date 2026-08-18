import type { PromptVariableSpec } from '@talyn/shared';

export interface InsertResult {
  text: string;
  caret: number;
}

// Block variables land on their own line; inline ones go exactly where the caret is.
export function insertVariableAt(
  text: string,
  start: number,
  end: number,
  spec: Pick<PromptVariableSpec, 'name' | 'shape'>
): InsertResult {
  const token = `{{${spec.name}}}`;
  const before = text.slice(0, start);
  const after = text.slice(end);
  let insert = token;
  if (spec.shape === 'block') {
    const needsLeading = before.length > 0 && !before.endsWith('\n');
    const needsTrailing = after.length > 0 && !after.startsWith('\n');
    insert = `${needsLeading ? '\n' : ''}${token}${needsTrailing ? '\n' : ''}`;
  }
  return { text: before + insert + after, caret: before.length + insert.length };
}

import { eq } from 'drizzle-orm';
import { promptTemplateFor, type PromptKind, type WorkspaceSettings } from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';

export async function workspacePromptTemplate(workspaceId: string, kind: PromptKind): Promise<string> {
  const rows = await getDbClient()
    .select({ settings: workspacesTable.settings })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return promptTemplateFor((rows[0]?.settings as WorkspaceSettings | null) ?? null, kind);
}

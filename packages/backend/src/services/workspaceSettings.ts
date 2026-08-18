import { eq } from 'drizzle-orm';
import type { WorkspaceSettings } from '@talyn/shared';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';

export async function readWorkspaceSettings(
  db: Database,
  workspaceId: string
): Promise<WorkspaceSettings> {
  const rows = await db
    .select({ settings: workspacesTable.settings })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return (rows[0]?.settings as WorkspaceSettings | null) ?? {};
}

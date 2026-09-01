import { eq } from 'drizzle-orm';
import { promptTemplateFor, type PromptKind, type WorkspaceSettings } from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';

async function readSettings(workspaceId: string): Promise<WorkspaceSettings | null> {
  // Projects the settings column alone — `workspaces.logo` is an inline data
  // URL and must never ship on a dispatch path (egress rules).
  const rows = await getDbClient()
    .select({ settings: workspacesTable.settings })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return (rows[0]?.settings as WorkspaceSettings | null) ?? null;
}

export async function workspacePromptTemplate(workspaceId: string, kind: PromptKind): Promise<string> {
  return promptTemplateFor(await readSettings(workspaceId), kind);
}

/**
 * Whether a fix run may reply to, resolve, or push code for HUMAN review
 * threads on this workspace's PRs.
 *
 * Defaults to `true` — absent means the workspace has never expressed a
 * preference, and that has to keep meaning today's behaviour rather than
 * silently muting every existing workspace's replies.
 */
export async function workspaceRespondToHumanComments(workspaceId: string): Promise<boolean> {
  return (await readSettings(workspaceId))?.respondToHumanComments !== false;
}

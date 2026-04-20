-- Add permission_token column to agents. Populated at spawn time by
-- agent.ts after permissionService.registerRun(); read back on
-- backend-restart resume so the child's existing FASTOWL_PERMISSION_TOKEN
-- env var still authenticates. Cleared implicitly when the agent row
-- is deleted on structured-exit.
--
-- See docs/DAEMON_EVERYWHERE.md Slice 6 follow-up.

ALTER TABLE "agents" ADD COLUMN "permission_token" text;

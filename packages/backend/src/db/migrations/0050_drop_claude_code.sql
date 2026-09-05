-- Remove the Claude Code (Anthropic Managed Agents) provider.
--
-- The provider module, its registration, and `'claude_code'` as a
-- CloudProviderType are all gone from the code. This migration removes what the
-- code can no longer speak for. It must land BEFORE the instance that stops
-- recognising the provider serves traffic, which is what running migrations at
-- boot already guarantees.
--
-- 1. IN-FLIGHT TASKS FIRST, and this is the step that matters.
--
-- `cloudProviders/poller.ts` resolves a task's provider through the registry and
-- skips a row whose provider is not registered, logging once per type per tick.
-- Nothing else advances such a row. So a task left `in_progress` here does not
-- fail — it sits there forever, holding a slot against the free plan's active
-- task cap and showing the user a run that never finishes. Fail them explicitly,
-- with a reason they can read.
UPDATE "tasks"
  SET "status" = 'failed',
      "completed_at" = now(),
      "updated_at" = now(),
      "result" = COALESCE("result", '{}'::jsonb) || jsonb_build_object(
        'success', false,
        'error', 'Claude Code was removed as a cloud provider. Re-run this task on Talyn Fleet or PostHog Code.'
      ),
      "metadata" = COALESCE("metadata", '{}'::jsonb)
        || jsonb_build_object('cloudTask',
             COALESCE("metadata" -> 'cloudTask', '{}'::jsonb) || '{"status":"failed"}'::jsonb)
  WHERE "metadata" -> 'cloudTask' ->> 'provider' = 'claude_code'
    AND "status" IN ('pending', 'queued', 'in_progress');

-- 2. The stored Anthropic API keys. Nothing can spend them any more, and a
-- credential nobody can use is a credential nobody is watching.
DELETE FROM "integrations" WHERE "type" = 'claude_code';

-- 3. The env markers. Safe: `tasks.assigned_environment_id` is ON DELETE SET
-- NULL (see db/schema.ts), so a completed task keeps its transcript and simply
-- loses a pointer the task screen already renders without.
DELETE FROM "environments" WHERE "type" = 'claude_code';

-- 4. Workspace settings that name it.
--
-- `defaultCloudProvider = 'claude_code'` would otherwise pin a provider the
-- registry cannot resolve; `resolveCloudEnvChain` skips an unknown link, so the
-- effect is silent rather than broken — but the setting would keep reappearing
-- in the API response and in the Settings dropdown as a value with no option
-- behind it. Removing the key restores "auto", which is the honest answer.
UPDATE "workspaces"
  SET "settings" = "settings" - 'defaultCloudProvider', "updated_at" = now()
  WHERE "settings" ->> 'defaultCloudProvider' = 'claude_code';

-- `claudeModel` is gone from WorkspaceSettings entirely.
UPDATE "workspaces"
  SET "settings" = "settings" - 'claudeModel', "updated_at" = now()
  WHERE "settings" ? 'claudeModel';

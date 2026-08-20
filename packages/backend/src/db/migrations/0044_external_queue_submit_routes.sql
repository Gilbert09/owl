-- The external merge queue's submit COMMAND, remembered per repo — durably.
--
-- It lived in a process-local Map (services/externalQueueSubmitRoute.ts). The
-- reasoning there covers staleness carefully and never mentions process
-- lifetime, which is the thing that actually breaks it: every deploy wipes the
-- memo, and Railway deploys on every push to main.
--
-- That matters because the memo is not an optimisation, it is a DOOR. trunk
-- rewrites its one comment per PR through the lifecycle, so the instruction
-- naming `/trunk merge` is present only while the PR is unsubmitted. On a PR
-- whose comment has moved on, the memo is the only way to find the command —
-- and on PostHog/posthog the command door is the one that demonstrably works
-- (trunk accepts `/trunk merge` from talyn-app[bot] and answers "Submitted to
-- Merge by talyn-app[bot]"), while the submit LABEL is refused for the same App
-- and deleted again. So a cold memo does not degrade to a slower door, it
-- degrades to a worse one: PostHog/posthog#82679 fell past the empty memo onto
-- the label and looped 61 times in an hour.
--
-- Repo-scoped, not workspace-scoped, for the same reason external_state is:
-- which command a queue accepts is a property of the repo, not of who is
-- looking at it. One row per repo, so it cannot grow with traffic.
CREATE TABLE IF NOT EXISTS "external_queue_submit_routes" (
  -- `owner/repo`, lowercased.
  "repo_full_name" text PRIMARY KEY,
  -- ExternalQueueProvider — 'trunk' today.
  "provider" text NOT NULL,
  -- The comment body that submits a PR, verbatim from the provider's own
  -- instruction (e.g. `/trunk merge`).
  "command" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

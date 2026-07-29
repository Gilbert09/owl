-- Where the external merge queue says a PR actually is.
--
-- Until now the only channel Talyn read was trunk.io's status LABELS, which are
-- optional in trunk's config: on posthog/posthog they were absent on PRs trunk
-- was actively testing (#74552 ran a full test cycle unlabelled) and stale on
-- ones it had long since merged. With no label to see, the queue concluded its
-- `/trunk merge` comment had been ignored and blocked seven healthy PRs
-- (2026-07-29).
--
-- The reliable channel is trunk's own PR comment, which it EDITS IN PLACE
-- through the lifecycle ("Submitted to Merge" → "Running tests" → "Merged
-- successfully" / a failure). Every edit is an `issue_comment` webhook, so the
-- state arrives for free; this column persists the last observation so the
-- desktop badge, the entry timeline and a restarted backend all see it.
ALTER TABLE "merge_queue_entries"
  ADD COLUMN IF NOT EXISTS "external_state" text,
  ADD COLUMN IF NOT EXISTS "external_state_at" timestamp with time zone;

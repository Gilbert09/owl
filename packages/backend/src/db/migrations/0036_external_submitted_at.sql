-- When an external-queue submission was made.
--
-- The submit door that actually works on posthog/posthog is trunk.io's own
-- command comment ("check the box to the left or comment `/trunk merge`"), and
-- a posted comment leaves nothing on GitHub we can re-read. This timestamp plus
-- a grace window is how the queue tells "trunk hasn't labelled it yet" from
-- "trunk ignored us" — the latter blocks with an actionable reason instead of
-- re-posting the same command on someone else's repo.
ALTER TABLE "merge_queue_entries"
  ADD COLUMN IF NOT EXISTS "external_submitted_at" timestamp with time zone;

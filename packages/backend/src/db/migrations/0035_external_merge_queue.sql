-- External merge queues (trunk.io, GitHub's native merge queue).
--
-- Some base branches are governed by a merge system Talyn can't merge past —
-- posthog/posthog's `master` since July 2026, where a "Trunk merge" ruleset adds
-- an `update` rule and exempts only trunk.io's App. The queue now SUBMITS such a
-- PR to that system (arm GitHub auto-merge, or apply the repo's submit label)
-- instead of attempting a doomed merge, and takes it back when the provider
-- ejects it.
--
--   submit_attempts     — resubmit budget per head, mirroring fix_attempts: the
--                         provider can hand the PR back (its tests fail merging
--                         with the base) and this bounds the loop.
--   external_submit_via — how the live submission was made ('auto_merge' |
--                         'label'), so a submission removed outside Talyn is
--                         detectable and the timeline can say which door we used.
ALTER TABLE "merge_queue_entries"
  ADD COLUMN IF NOT EXISTS "submit_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "merge_queue_entries"
  ADD COLUMN IF NOT EXISTS "external_submit_via" text;

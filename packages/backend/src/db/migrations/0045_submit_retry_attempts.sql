-- Per-head budget for submit attempts that never reached the provider.
--
-- The submit ladder returns `retry` when its call FAILED rather than when the
-- queue answered: a 5xx, a network blip — or a permanent condition that simply
-- isn't a 403, such as "GitHub not connected for this workspace". `decide`
-- handled `retry` with `ensure('queued')` and spent nothing, so a permanent
-- condition was retried on every evaluation, forever.
--
-- It is deliberately NOT `submit_attempts`. That budget answers "stop spending
-- QUEUE cycles on an unchanged commit", and it is read to explain what the
-- provider did with the PR; a call that never reached the provider is a
-- different fact and must not exhaust the door for a PR whose real submissions
-- are still available. Separate counters also mean a couple of transient blips
-- cannot block a healthy PR out of its actual submit budget.
--
-- Resets on a new head like every other per-head budget (decide's resetBudgets,
-- R2): a new commit is the one thing that plausibly changes the answer.
ALTER TABLE "merge_queue_entries"
  ADD COLUMN IF NOT EXISTS "submit_retry_attempts" integer NOT NULL DEFAULT 0;

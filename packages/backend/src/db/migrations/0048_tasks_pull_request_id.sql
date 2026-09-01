-- A hard reference from a task to the pull request it is working.
--
-- This is the reverse of `pull_requests.task_id`, and the reverse is the
-- direction that was missing. A PR accumulates MANY tasks over its life, but
-- `pull_requests.task_id` holds only the most recent — `attachTaskToPullRequestRow`
-- overwrites it on every dispatch, from any source. So the question every
-- dispatch path actually needs to ask ("is a run already working this PR?")
-- could only ever be answered for the last writer.
--
-- That is not hypothetical: on 2026-09-01 the auto-keep-mergeable watcher
-- dispatched three concurrent runs at PostHog/posthog#92090 and two at #92089,
-- because its in-flight guard read `pull_requests.task_id` and found a task that
-- had already gone terminal. The three duplicates then filled the free plan's
-- 3-active-task cap, which starved a genuine fix run on #91948 for six minutes
-- and surfaced to the user as an unexplained paywall.
--
-- The alternative — matching tasks by title (`'Get owner/repo#N mergeable'`) —
-- was rejected: it silently stops working the moment anyone edits a title.
--
-- `set null`, not cascade: un-watching a PR deletes its row (see the watch
-- route), and a task record is the history of work that actually ran. It should
-- outlive the tracking of the PR, orphaned rather than erased.
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "pull_request_id" text;
--> statement-breakpoint
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_pull_request_id_pull_requests_id_fk"
  FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_pull_request" ON "tasks" USING btree ("pull_request_id");
--> statement-breakpoint
-- Backfill 1: the existing forward pointer. One PR names one task, so this
-- recovers the most recent task per PR — which is every link we still hold.
UPDATE "tasks" t
  SET "pull_request_id" = pr."id"
  FROM "pull_requests" pr
  WHERE pr."task_id" = t."id" AND t."pull_request_id" IS NULL;
--> statement-breakpoint
-- Backfill 2: the jsonb pointer createCloudTask stashes for the task screen's
-- PR pill. Covers the older tasks a PR has since overwritten `task_id` past.
-- The EXISTS guard is load-bearing — metadata can name a PR row that has since
-- been deleted, and the new FK would reject it.
UPDATE "tasks" t
  SET "pull_request_id" = t."metadata" -> 'pullRequest' ->> 'id'
  WHERE t."pull_request_id" IS NULL
    AND t."metadata" -> 'pullRequest' ->> 'id' IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "pull_requests" p
      WHERE p."id" = t."metadata" -> 'pullRequest' ->> 'id'
    );

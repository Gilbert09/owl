-- Merge stack: drain a chain of dependent PRs bottom-up.
--
-- A stack is a chain where each PR's base branch is the previous one's head
-- branch. The queue's serialization unit is (repository_id, base_branch), so
-- every member of a stack is a group of one and nothing orders them — a child
-- merges into its parent's branch whenever it goes green. The queue now parks
-- a child in `awaiting_stack` until its parent lands, then retargets it onto
-- the parent's base and lets it re-enter the normal flow.
--
-- The parent edge is NOT persisted: it is derived per evaluation from the
-- summary jsonb. A parent_pull_request_id column would be the same class of
-- unmaintained denormalization that let base_branch rot (it was written only
-- at enqueue and nothing refreshed it). These two columns are display and a
-- loop bound; neither is read to make a decision.

-- Which PR the entry is parked behind. Display only — it feeds the badge's
-- "Waiting for #123"; a stale value makes the badge briefly wrong, nothing more.
ALTER TABLE "merge_queue_entries"
  ADD COLUMN IF NOT EXISTS "stack_parent_number" integer;
--> statement-breakpoint
-- Belt and braces on the retarget. A retarget can only fire when the resolver
-- finds a MERGED parent for the entry's CURRENT base, and it moves the base
-- strictly one hop up a finite chain, so it cannot structurally loop. This
-- counts ACTIONS, not successes, so a PATCH that keeps erroring is bounded too.
-- Deliberately NOT reset by the new-head rule: a push that reset the loop guard
-- would defeat it.
ALTER TABLE "merge_queue_entries"
  ADD COLUMN IF NOT EXISTS "retarget_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Resolving a stack parent asks "which open PR's HEAD is this branch?" — the
-- reverse of every existing base-branch lookup. Branch names live only inside
-- last_summary (there are no headRef/baseRef columns), and jsonb ->> text is
-- IMMUTABLE, so an expression index is legal here.
CREATE INDEX IF NOT EXISTS "idx_pr_repo_head_branch"
  ON "pull_requests" ("repository_id", ("last_summary" ->> 'headBranch'), "state");
--> statement-breakpoint
-- The mirror. Not needed by the stack work, but prMonitor.openPrNumbersForBase
-- runs this exact predicate on every push webhook and had no index at all.
CREATE INDEX IF NOT EXISTS "idx_pr_repo_base_branch"
  ON "pull_requests" ("repository_id", ("last_summary" ->> 'baseBranch'), "state");

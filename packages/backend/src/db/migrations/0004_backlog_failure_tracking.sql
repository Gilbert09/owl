ALTER TABLE "backlog_items" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "backlog_items" ADD COLUMN "last_failure_at" timestamp with time zone;
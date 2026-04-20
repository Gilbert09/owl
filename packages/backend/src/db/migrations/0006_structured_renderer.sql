ALTER TABLE "environments" ADD COLUMN "renderer" text DEFAULT 'pty' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "transcript" jsonb;
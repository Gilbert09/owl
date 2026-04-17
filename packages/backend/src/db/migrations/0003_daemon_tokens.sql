ALTER TABLE "environments" ADD COLUMN "device_token_hash" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_environments_device_token" ON "environments" USING btree ("device_token_hash");
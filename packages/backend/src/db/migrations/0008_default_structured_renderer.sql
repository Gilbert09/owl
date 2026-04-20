-- Slice 4c: structured is now the only runtime. Flip the default
-- for new rows, and back-fill any existing 'pty' rows so the removed
-- PTY dispatcher can't be reached.
ALTER TABLE "environments" ALTER COLUMN "renderer" SET DEFAULT 'structured';
--> statement-breakpoint
UPDATE "environments" SET "renderer" = 'structured' WHERE "renderer" = 'pty';

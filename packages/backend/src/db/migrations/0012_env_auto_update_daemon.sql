-- Per-env opt-in: when true, the backend auto-triggers the daemon's
-- self-update whenever it sees a stale daemon connect (or on a
-- periodic check). Default false — users have to deliberately enable
-- it per env, matching the "desktop controls updates" model.

ALTER TABLE "environments" ADD COLUMN "auto_update_daemon" boolean NOT NULL DEFAULT false;

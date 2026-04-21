-- Track the daemon build currently connected to each env. Populated
-- from the `daemonVersion` field on every hello; used by the desktop
-- Settings → Environments row to show a "stale" badge when the
-- daemon is out of date vs the backend's latest. Feeds Slice 2's
-- "Update daemon" button.

ALTER TABLE "environments" ADD COLUMN "daemon_version" text;

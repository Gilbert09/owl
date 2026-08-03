-- The self-hosted fleet's host registry.
--
-- Hosts PUSH a snapshot here every ~15s rather than the backend scraping them,
-- and that direction is the whole point: the fleet runs untrusted code on bare
-- metal behind a private interface, on addresses that accept no inbound
-- connections. Giving a hosted PaaS an inbound path to every one of those
-- machines is exactly the shape the fleet design exists to avoid. Outbound from
-- the metal is trivial and needs no exposure.
--
-- It also degrades better than scraping: a host that goes dark simply stops
-- reporting, and its last snapshot stays on record with a timestamp, so the
-- product can say "hetzner-64, last seen 4 minutes ago" rather than showing an
-- error and nothing else.
--
-- The payload is a SNAPSHOT, not a delta — idempotent, survives a missed
-- interval with no reconciliation, and lets this table be a dumb upsert.
CREATE TABLE IF NOT EXISTS "fleet_hosts" (
  -- The host's own name for itself (fleetd's -host-name, default os.Hostname).
  -- Natural key: a host that restarts, redeploys or changes address is still
  -- the same host, and a surrogate id would let it register twice.
  "name" text PRIMARY KEY,

  -- Where the backend should dial this host's Fleet API. Advertised BY the
  -- host, because only it knows which of its addresses is the reachable one
  -- (a WireGuard/tailnet address, not the loopback fleetd binds).
  --
  -- Nullable: a host that reports without one is visible and observable but
  -- not dispatchable, which is a real and useful state — it is what a host
  -- looks like before its private link is up.
  "api_endpoint" text,

  "version" text,
  "reported_at" timestamp with time zone NOT NULL,

  "draining" boolean NOT NULL DEFAULT false,
  "runs_live" integer NOT NULL DEFAULT 0,
  "runs_max" integer NOT NULL DEFAULT 0,
  "mem_reserved_mib" integer NOT NULL DEFAULT 0,
  "mem_budget_mib" integer NOT NULL DEFAULT 0,
  "disk_free_mib" integer NOT NULL DEFAULT 0,
  "max_idle_seconds" double precision NOT NULL DEFAULT 0,

  -- The fleet's own metrics snapshot and its in-flight runs, stored whole.
  -- Deliberately opaque jsonb: the fleet ships on its own cadence and adding a
  -- counter there must not need a migration here.
  "metrics" jsonb,
  "active_runs" jsonb,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- "Which hosts could take work right now" is the dispatch question, and it is
-- answered by recency first.
CREATE INDEX IF NOT EXISTS "idx_fleet_hosts_reported_at"
  ON "fleet_hosts" ("reported_at" DESC);

-- No RLS policy and no owner column, deliberately. A fleet host belongs to the
-- deployment, not to a user: it is infrastructure that many workspaces dispatch
-- onto. Reads go through the authenticated API, which is admin-gated; the
-- report endpoint authenticates with the shared fleet token instead of a user
-- JWT, because the thing writing here is a daemon with no user.
ALTER TABLE "fleet_hosts" ENABLE ROW LEVEL SECURITY;

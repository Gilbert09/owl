-- Daemon everywhere: collapse env types.
--
-- Before: 'local' | 'ssh' | 'coder' | 'daemon'
-- After:  'local' | 'remote'  (both transport via daemon WS)
--
-- Rules:
--   * type='daemon' + name starting with 'This Mac ' → 'local'
--     (the auto-paired local daemon created by the desktop app)
--   * type='daemon' (everything else)                → 'remote'
--   * type='ssh' or 'coder'                          → deleted
--     (no real users; legacy in-process transports no longer supported)
--
-- See docs/DAEMON_EVERYWHERE.md Slice 5.

UPDATE "environments"
SET "type" = 'local'
WHERE "type" = 'daemon' AND "name" LIKE 'This Mac %';

UPDATE "environments"
SET "type" = 'remote'
WHERE "type" = 'daemon';

DELETE FROM "environments"
WHERE "type" IN ('ssh', 'coder');

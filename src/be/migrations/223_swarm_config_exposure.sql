-- Per-row secret exposure: who may read a secret row's value over HTTP.
-- NULL means "use the code default" (src/be/secret-exposure.ts), so existing
-- rows keep their meaning and no backfill is needed.
ALTER TABLE swarm_config ADD COLUMN exposure TEXT
  CHECK (exposure IS NULL OR exposure IN ('worker', 'lead', 'api'));

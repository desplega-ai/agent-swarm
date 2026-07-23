-- Keep-alive opt-in for the generalized OAuth keepalive job.
--
-- The keepalive job (src/oauth/keepalive.ts) no longer hardcodes
-- ["linear","jira"]; it selects active authorizations whose app either rotates
-- refresh tokens (requiresRefreshTokenRotation=1) or opts in via a `keepAlive`
-- metadata flag. Jira already qualifies via rotation; backfill the flag on the
-- migrated tracker rows so Linear (and any future keep-warm provider) qualifies
-- automatically without reintroducing a provider allowlist.
--
-- Data-only: no schema change. json('true') stores a JSON boolean so
-- json_extract(metadata, '$.keepAlive') reads back as 1.

UPDATE oauth_apps
SET metadata = CASE
  WHEN json_valid(metadata) = 1 THEN json_set(metadata, '$.keepAlive', json('true'))
  ELSE json_object('keepAlive', json('true'))
END
WHERE provider IN ('linear', 'jira') AND mcpServerId IS NULL;

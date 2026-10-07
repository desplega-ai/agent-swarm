-- Codex device-login flow state, moved out of `kv_entries`.
--
-- `state` is the encrypted flow (device auth id, user code, poll lease). It
-- lived in `kv_entries` namespace 'codex-oauth-device', which db-query must
-- keep readable for general KV debugging. A dedicated table lets db-query deny
-- this store by table name, with no SQL-text parsing.
--
-- expires_at: unix-ms. Expired rows are deleted on read and on every write.

CREATE TABLE IF NOT EXISTS codex_oauth_device_flows (
  flow_id     TEXT PRIMARY KEY,
  state       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

INSERT OR IGNORE INTO codex_oauth_device_flows (flow_id, state, expires_at, created_at, updated_at)
  SELECT key, value, expires_at, created_at, updated_at
    FROM kv_entries
   WHERE namespace = 'codex-oauth-device'
     AND expires_at IS NOT NULL;

DELETE FROM kv_entries WHERE namespace = 'codex-oauth-device';

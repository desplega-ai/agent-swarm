-- KV store: one table, namespaced. Namespace mirrors `agent_tasks.contextKey`
-- (task:slack:..., task:trackers:..., task:agent:..., task:page:..., etc.)
-- so the same string used to find sibling tasks for a Slack thread / PR /
-- Linear issue also indexes KV state for that entity.
--
-- value_type:
--   'json'    — `value` is the JSON-encoded payload (default; arbitrary shape).
--   'string'  — `value` is the raw UTF-8 string verbatim.
--   'integer' — `value` is the decimal-string form of a JS-safe integer.
--               INCR uses this column; mixing with 'json'/'string' returns 409.
--
-- expires_at:
--   Unix-ms (matches `unixepoch('subsec') * 1000`). NULL means never expires.
--   Lazy expire on read: getKv DELETEs single expired rows; listKv filters in
--   the SELECT but does not delete (keeps cursors stable). No background sweep.
--
-- WITHOUT ROWID: every read is by full PK (namespace, key); the rowid -> btree
-- hop is wasted.

CREATE TABLE IF NOT EXISTS kv_entries (
  namespace   TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  value_type  TEXT NOT NULL DEFAULT 'json'
                CHECK (value_type IN ('json','string','integer')),
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (namespace, key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_kv_expires
  ON kv_entries(expires_at)
  WHERE expires_at IS NOT NULL;

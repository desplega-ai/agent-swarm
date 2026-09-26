-- Durable receipts for inbound Slack deliveries (events, interactions, commands).
--
-- A receipt is admitted with one atomic INSERT against the unique dedup key, so a
-- retried delivery can never create a second drain job. The payload is stored
-- encrypted (AES-256-GCM, the secrets cipher) only while it may still be needed:
-- processed and ignored receipts erase it on completion. Pending, processing and
-- uncertain receipts are never expired by retention; completed dedup keys are kept
-- for 48 hours so Slack's retry schedule cannot replay them.
--
-- A receipt left `processing` by a crash becomes `uncertain` at the next boot and is
-- never replayed automatically: a handler may already have created tasks.
CREATE TABLE slack_inbound_receipts (
  id                  TEXT PRIMARY KEY,
  dedup_key           TEXT NOT NULL UNIQUE,
  transport           TEXT NOT NULL CHECK (transport IN ('socket', 'http')),
  kind                TEXT NOT NULL CHECK (kind IN ('event', 'interaction', 'command')),
  payload_type        TEXT NOT NULL,
  api_app_id          TEXT,
  event_id            TEXT,
  payload_ciphertext  TEXT,
  payload_bytes       INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
  retry_num           INTEGER,
  retry_reason        TEXT,
  state               TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'processed', 'ignored', 'failed', 'uncertain')),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  duplicate_count     INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  outcome_code        TEXT,
  error_code          TEXT,
  received_at         TEXT NOT NULL,
  available_at        TEXT NOT NULL,
  claimed_at          TEXT,
  completed_at        TEXT,
  last_duplicate_at   TEXT,
  payload_erased_at   TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by          TEXT REFERENCES users(id),
  updated_by          TEXT REFERENCES users(id)
);

CREATE INDEX idx_slack_inbound_receipts_claim
  ON slack_inbound_receipts(available_at, received_at)
  WHERE state = 'pending';

CREATE INDEX idx_slack_inbound_receipts_state
  ON slack_inbound_receipts(state, received_at);

CREATE INDEX idx_slack_inbound_receipts_completed
  ON slack_inbound_receipts(completed_at)
  WHERE state IN ('processed', 'ignored', 'failed');

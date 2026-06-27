-- Inbox item state — per-user dismiss/snooze/done state for action-items inbox
-- buckets (approval, credential_missing, broken_task, to_read, to_start_template).
--
-- itemType is enforced via Zod (`InboxItemTypeSchema` in src/types.ts), not a
-- SQL CHECK constraint — Phase 1 lesson, lets us extend the enum without a
-- forward-only migration. Direct SQL inserts can bypass; the HTTP layer
-- (`PATCH /api/inbox-state`) is the only sanctioned writer.
--
-- itemId references the underlying entity (task id, approval-request id,
-- agent id, template id, …) but is left as a free TEXT column rather than a
-- typed FK because itemType disambiguates which table it points at.
CREATE TABLE IF NOT EXISTS inbox_item_state (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  itemType TEXT NOT NULL,
  itemId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  snoozeUntil TEXT,
  dismissedAt TEXT,
  doneAt TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(userId, itemType, itemId)
);

CREATE INDEX IF NOT EXISTS idx_inbox_item_state_userId_status
  ON inbox_item_state(userId, status);

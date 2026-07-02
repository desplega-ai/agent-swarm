-- Per-user favorites for frequently revisited app entities.
-- Used by the SPA to star pages, workflows, and schedules and float them to
-- the top of list views.

CREATE TABLE IF NOT EXISTS user_favorites (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  userId        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  itemType      TEXT NOT NULL CHECK (itemType IN ('page','workflow','schedule')),
  itemId        TEXT NOT NULL,
  createdAt     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lastUpdatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by    TEXT,
  updated_by    TEXT,
  UNIQUE (userId, itemType, itemId)
);

CREATE INDEX IF NOT EXISTS idx_user_favorites_user_type ON user_favorites(userId, itemType);
CREATE INDEX IF NOT EXISTS idx_user_favorites_item ON user_favorites(itemType, itemId);

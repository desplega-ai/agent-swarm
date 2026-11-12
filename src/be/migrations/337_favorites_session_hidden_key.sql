-- Sessions sidebar: a single session can be starred (`session`, item id = the
-- root task id), and a group can be hidden from the sidebar (`hidden-key`,
-- item id = the normalized group key, like `key`). Both are per-principal
-- flags, so they reuse the favorites table and its owner scoping.
-- SQLite cannot change a CHECK in place, so rebuild the table with the 301
-- shape plus the new item types. Every row is copied unchanged.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE user_favorites_new (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  favoriteScope TEXT NOT NULL,
  userId        TEXT REFERENCES users(id) ON DELETE CASCADE,
  itemType      TEXT NOT NULL CHECK (itemType IN ('page','workflow','schedule','agent-fs-path','key','session','hidden-key')),
  itemId        TEXT NOT NULL,
  createdAt     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lastUpdatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by    TEXT,
  updated_by    TEXT,
  UNIQUE (favoriteScope, itemType, itemId)
);

INSERT INTO user_favorites_new (
  id, favoriteScope, userId, itemType, itemId,
  createdAt, lastUpdatedAt, created_by, updated_by
)
SELECT
  id, favoriteScope, userId, itemType, itemId,
  createdAt, lastUpdatedAt, created_by, updated_by
FROM user_favorites;

DROP TABLE user_favorites;
ALTER TABLE user_favorites_new RENAME TO user_favorites;

CREATE INDEX idx_user_favorites_scope_type
  ON user_favorites(favoriteScope, itemType);
CREATE INDEX idx_user_favorites_user_type
  ON user_favorites(userId, itemType);
CREATE INDEX idx_user_favorites_item
  ON user_favorites(itemType, itemId);

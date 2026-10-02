-- Comb pins: an agent-fs file or folder can be a favorite. The item id is
-- `<orgId>/<driveId>/<path>` (a folder path ends with "/"). SQLite cannot
-- change a CHECK in place, so rebuild the table with the 116 shape plus the
-- new item type. Every row is copied unchanged.

CREATE TABLE user_favorites_new (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  favoriteScope TEXT NOT NULL,
  userId        TEXT REFERENCES users(id) ON DELETE CASCADE,
  itemType      TEXT NOT NULL CHECK (itemType IN ('page','workflow','schedule','agent-fs-path')),
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

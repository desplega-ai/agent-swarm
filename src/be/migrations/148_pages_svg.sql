-- Allow SVG images while preserving page IDs, versions, audit fields, and asset keys.
-- The migration runner disables foreign keys around the transactional rebuild.
CREATE TABLE pages_new (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agentId      TEXT NOT NULL,
  slug         TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  contentType  TEXT NOT NULL CHECK (contentType IN ('text/html','application/json','image/svg+xml')),
  authMode     TEXT NOT NULL DEFAULT 'authed' CHECK (authMode IN ('public','authed','password')),
  passwordHash TEXT,
  body         TEXT NOT NULL,
  needsCredentials TEXT,
  createdAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  view_count   INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT REFERENCES users(id),
  updated_by   TEXT REFERENCES users(id),
  "key" TEXT NOT NULL DEFAULT 'shared/',
  UNIQUE (agentId, slug)
);

INSERT INTO pages_new (
  id,
  agentId,
  slug,
  title,
  description,
  contentType,
  authMode,
  passwordHash,
  body,
  needsCredentials,
  createdAt,
  updatedAt,
  view_count,
  created_by,
  updated_by,
  "key"
)
SELECT
  id,
  agentId,
  slug,
  title,
  description,
  contentType,
  authMode,
  passwordHash,
  body,
  needsCredentials,
  createdAt,
  updatedAt,
  view_count,
  created_by,
  updated_by,
  "key"
FROM pages;

DROP TABLE pages;
ALTER TABLE pages_new RENAME TO pages;

CREATE INDEX IF NOT EXISTS idx_pages_agentId ON pages(agentId);
CREATE INDEX IF NOT EXISTS idx_pages_updatedAt ON pages(updatedAt DESC);
CREATE INDEX IF NOT EXISTS idx_pages_created_by ON pages(created_by) WHERE created_by IS NOT NULL;

CREATE INDEX idx_pages_asset_key ON pages("key");
CREATE TRIGGER validate_pages_asset_key_insert
BEFORE INSERT ON pages
WHEN NEW."key" IS NULL
  OR length(NEW."key") = 0
  OR NEW."key" != trim(NEW."key")
  OR length(NEW."key") > 255
  OR substr(NEW."key", -1, 1) != '/'
  OR instr(NEW."key", char(0)) > 0
  OR instr(NEW."key", char(92)) > 0
  OR instr(NEW."key", '//') > 0
  OR instr(NEW."key", '/../') > 0
  OR instr(NEW."key", '/./') > 0
  OR NEW."key" != lower(NEW."key")
  OR NOT (
    NEW."key" = 'shared/'
    OR NEW."key" LIKE 'shared/%'
    OR (
      NEW."key" LIKE 'personal/%/%'
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = substr(NEW."key", 10, instr(substr(NEW."key", 10), '/') - 1)
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid asset namespace key');
END;

CREATE TRIGGER validate_pages_asset_key_update
BEFORE UPDATE OF "key" ON pages
WHEN NEW."key" IS NULL
  OR length(NEW."key") = 0
  OR NEW."key" != trim(NEW."key")
  OR length(NEW."key") > 255
  OR substr(NEW."key", -1, 1) != '/'
  OR instr(NEW."key", char(0)) > 0
  OR instr(NEW."key", char(92)) > 0
  OR instr(NEW."key", '//') > 0
  OR instr(NEW."key", '/../') > 0
  OR instr(NEW."key", '/./') > 0
  OR NEW."key" != lower(NEW."key")
  OR NOT (
    NEW."key" = 'shared/'
    OR NEW."key" LIKE 'shared/%'
    OR (
      NEW."key" LIKE 'personal/%/%'
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = substr(NEW."key", 10, instr(substr(NEW."key", 10), '/') - 1)
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid asset namespace key');
END;


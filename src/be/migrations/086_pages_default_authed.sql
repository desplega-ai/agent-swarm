-- Flip the SQL-level default for new page rows from public to authed.
-- Existing row values are preserved; this only changes behavior when a caller
-- omits authMode at the database layer.

CREATE TABLE pages_new (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agentId      TEXT NOT NULL,
  slug         TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  contentType  TEXT NOT NULL CHECK (contentType IN ('text/html','application/json')),
  authMode     TEXT NOT NULL DEFAULT 'authed' CHECK (authMode IN ('public','authed','password')),
  passwordHash TEXT,
  body         TEXT NOT NULL,
  needsCredentials TEXT,
  createdAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  view_count   INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT REFERENCES users(id),
  updated_by   TEXT REFERENCES users(id),
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
  updated_by
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
  updated_by
FROM pages;

DROP TABLE pages;
ALTER TABLE pages_new RENAME TO pages;

CREATE INDEX IF NOT EXISTS idx_pages_agentId ON pages(agentId);
CREATE INDEX IF NOT EXISTS idx_pages_updatedAt ON pages(updatedAt DESC);
CREATE INDEX IF NOT EXISTS idx_pages_created_by ON pages(created_by) WHERE created_by IS NOT NULL;

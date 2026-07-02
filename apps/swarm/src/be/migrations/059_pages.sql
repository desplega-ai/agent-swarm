-- DB-backed Pages (parent table) — lightweight artifacts stored in SQLite and
-- served as HTML or JSON. Replaces PM2+localtunnel for static cases.
--
-- `body` stores agent-emitted content verbatim. For contentType='text/html',
-- callers MAY pass either a fragment (`<h1>hi</h1>`) or a full document
-- (`<!doctype html>...<html>...`). Step-3's `/p/:id` serving logic detects
-- `<head>` and injects BROWSER_SDK_JS after it; if absent, it prepends.
-- For contentType='application/json', the body is a JSON-render-compatible
-- spec stored as a string (parsed at render time).
--
-- `needsCredentials` is reserved for follow-up credential capture work; the
-- v1 renderer ignores it (Zod accepts, no UI prompt).
--
-- `authMode` CHECK constraint MUST stay in sync with PageAuthModeSchema in
-- src/types.ts.

CREATE TABLE IF NOT EXISTS pages (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agentId      TEXT NOT NULL,
  slug         TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  contentType  TEXT NOT NULL CHECK (contentType IN ('text/html','application/json')),
  authMode     TEXT NOT NULL DEFAULT 'public' CHECK (authMode IN ('public','authed','password')),
  passwordHash TEXT,
  body         TEXT NOT NULL,
  needsCredentials TEXT,
  createdAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agentId, slug)
);

CREATE INDEX IF NOT EXISTS idx_pages_agentId ON pages(agentId);
CREATE INDEX IF NOT EXISTS idx_pages_updatedAt ON pages(updatedAt DESC);

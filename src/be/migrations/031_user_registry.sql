-- User registry: canonical user profiles for cross-channel identity resolution
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  email TEXT,
  role TEXT,
  notes TEXT,
  slackUserId TEXT UNIQUE,
  linearUserId TEXT UNIQUE,
  githubUsername TEXT UNIQUE,
  gitlabUsername TEXT UNIQUE,
  emailAliases TEXT DEFAULT '[]',
  preferredChannel TEXT DEFAULT 'slack',
  timezone TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUpdatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reverse lookup indexes (partial — only index non-null values)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slack ON users(slackUserId) WHERE slackUserId IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_linear ON users(linearUserId) WHERE linearUserId IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github ON users(githubUsername) WHERE githubUsername IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_gitlab ON users(gitlabUsername) WHERE gitlabUsername IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;

-- Link tasks to canonical users
ALTER TABLE agent_tasks ADD COLUMN requestedByUserId TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_tasks_requested_by ON agent_tasks(requestedByUserId) WHERE requestedByUserId IS NOT NULL;

-- Seed initial users
INSERT OR IGNORE INTO users (id, name, email, role, slackUserId, githubUsername)
VALUES (lower(hex(randomblob(16))), 'Taras', 't@desplega.ai', 'founder', 'U08NR6QD6CS', 'tarasyarema');

INSERT OR IGNORE INTO users (id, name, email, role, slackUserId)
VALUES (lower(hex(randomblob(16))), 'Eze', 'e@desplega.ai', 'founder', 'U08NY4B5R2M');

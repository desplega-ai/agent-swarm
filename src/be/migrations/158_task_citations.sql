-- Claim sources are independent of produced artifacts. Upsert per task/index.
CREATE TABLE task_citations (
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  citation_index INTEGER NOT NULL CHECK (citation_index >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('task','memory','github','slack','agent-fs','page','script-run','url')),
  ref TEXT NOT NULL,
  label TEXT,
  quote TEXT CHECK (length(quote) <= 300),
  resolved_url TEXT,
  verified TEXT NOT NULL CHECK (verified IN ('true','false','unchecked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  PRIMARY KEY (task_id, citation_index)
);

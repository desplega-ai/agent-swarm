ALTER TABLE agent_tasks ADD COLUMN routing_reason TEXT
  CHECK (
    routing_reason IS NULL OR routing_reason IN (
      'skill',
      'continuity',
      'overflow',
      'human_pinned',
      'reroute_fault'
    )
  );

ALTER TABLE agent_tasks ADD COLUMN routing_note TEXT
  CHECK (routing_note IS NULL OR length(routing_note) <= 200);

-- Continuity snapshots run while task creation holds BEGIN IMMEDIATE. Keep
-- each context lookup filter-first and recency-ordered. SQLite stores rowid as
-- the implicit final index key, so a reverse scan also satisfies the
-- createdAt DESC, rowid DESC deterministic tie-break.
CREATE INDEX idx_agent_tasks_routing_pr_recency
  ON agent_tasks(vcsRepo, vcsNumber, createdAt);

CREATE INDEX idx_agent_tasks_routing_repo_recency
  ON agent_tasks(vcsRepo, createdAt);

CREATE INDEX idx_agent_tasks_routing_slack_thread_recency
  ON agent_tasks(slackChannelId, slackThreadTs, createdAt);

CREATE INDEX idx_agent_tasks_routing_agentmail_thread_recency
  ON agent_tasks(agentmailThreadId, createdAt);

-- Immutable decision-time telemetry. Agent ids deliberately are not foreign
-- keys: deleting an agent must not erase which target or candidate was visible
-- when the task was created.
CREATE TABLE routing_decisions (
  task_id                TEXT PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE CASCADE,
  selected_agent_id      TEXT,
  captured_at            TEXT NOT NULL,
  worker_statuses        TEXT NOT NULL
                         CHECK (json_valid(worker_statuses) AND json_type(worker_statuses) = 'array'),
  continuity_candidates  TEXT NOT NULL
                         CHECK (json_valid(continuity_candidates) AND json_type(continuity_candidates) = 'object'),
  created_by             TEXT,
  updated_by             TEXT
);

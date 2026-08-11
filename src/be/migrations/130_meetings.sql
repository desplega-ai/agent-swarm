-- Structured Meetings — gated multi-agent decision records.
--
-- A meeting is a coordination primitive that makes "we talked but never
-- decided" structurally impossible: it can only be concluded once every
-- expected participant has recorded at least one contribution (the attendance
-- gate) AND an actionable conclusion has been supplied. Ported (concept, not
-- plumbing) from CronusL-1141/AI-company's Meetings feature; adapted to our
-- task/message primitives.
--
-- `participants` stores a JSON array of agent identifiers (agent IDs
-- recommended) expected to attend. Attendance is satisfied when a row exists
-- in `meeting_contributions` whose `agentId` matches a participant string.
--
-- `status` CHECK constraint MUST stay in sync with MeetingStatusSchema in
-- src/types.ts.

CREATE TABLE IF NOT EXISTS meetings (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agentId      TEXT NOT NULL,                 -- creator (from X-Agent-ID)
  title        TEXT NOT NULL,
  agenda       TEXT NOT NULL,                 -- the question/topic to decide
  template     TEXT,                          -- optional built-in template key
  participants TEXT NOT NULL DEFAULT '[]',    -- JSON array of expected attendee ids
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','concluded','cancelled')),
  conclusion   TEXT,                          -- required (non-empty) to conclude
  concludedBy  TEXT,                          -- agentId that concluded it
  concludedAt  TEXT,
  createdAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- User-attribution audit columns (see migration 082 pattern). Nullable:
  -- agent-authored meetings carry no human user id.
  created_by   TEXT REFERENCES users(id),
  updated_by   TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_meetings_agentId ON meetings(agentId);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
CREATE INDEX IF NOT EXISTS idx_meetings_updatedAt ON meetings(updatedAt DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_created_by ON meetings(created_by) WHERE created_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS meeting_contributions (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  meetingId  TEXT NOT NULL,
  agentId    TEXT NOT NULL,                   -- contributor (from X-Agent-ID)
  round      INTEGER NOT NULL DEFAULT 1,
  content    TEXT NOT NULL,
  createdAt  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  FOREIGN KEY (meetingId) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meeting_contributions_meetingId
  ON meeting_contributions(meetingId, createdAt);

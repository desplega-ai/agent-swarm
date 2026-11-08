-- Per-line reasoning counts, set by the INSERT that writes the line.
-- NULL = the line has no reasoning block. 0 = a reasoning block with empty or omitted text.
ALTER TABLE session_logs ADD COLUMN reasoningChars INTEGER;
-- 'reasoning' | 'update', constrained in TypeScript. A CHECK on ADD COLUMN
-- makes SQLite validate every existing row, past the large `content` column.
ALTER TABLE session_logs ADD COLUMN reasoningKind TEXT;

-- Covering for reasoning analysis and the Claude update lookup. Existing rows
-- are all NULL, so the build reads only record headers and the index starts empty.
CREATE INDEX IF NOT EXISTS idx_session_logs_reasoning
  ON session_logs(createdAt, cli, reasoningKind, reasoningChars, sessionId, taskId)
  WHERE reasoningChars IS NOT NULL;

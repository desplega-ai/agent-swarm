CREATE TABLE routing_trace (
  id          TEXT PRIMARY KEY,
  routingRunId TEXT NOT NULL,
  taskId      TEXT,
  edge        TEXT NOT NULL CHECK (edge IN ('task.before_assign','prompt.compose')),
  via         TEXT NOT NULL CHECK (via IN ('creation','delegation','claim','resume','completion','prompt')),
  handlerId   TEXT NOT NULL,
  handlerName TEXT NOT NULL,
  flavor      TEXT NOT NULL CHECK (flavor IN ('route','guard')),
  mode        TEXT NOT NULL CHECK (mode IN ('soft','hard')),
  matched     INTEGER NOT NULL DEFAULT 1,
  resultJson  TEXT,
  decisive    INTEGER NOT NULL DEFAULT 0,
  suggestion  TEXT,
  deviated    INTEGER,
  dryRun      INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  durationMs  INTEGER,
  createdAt   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_routing_trace_task ON routing_trace(taskId);
CREATE INDEX idx_routing_trace_handler ON routing_trace(handlerName, createdAt);
CREATE INDEX idx_routing_trace_run ON routing_trace(routingRunId);

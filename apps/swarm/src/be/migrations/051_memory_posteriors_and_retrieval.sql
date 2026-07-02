-- 051_memory_posteriors_and_retrieval.sql
-- Memory rater v1.5 — brainstorm spine.
--
-- Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-1.md
-- (The plan referred to this as `049_*`; numbers 049 and 050 were taken by the
-- wait-node feature on main between plan-write and plan-implement, so this
-- migration ships at 051 — semantics are unchanged.)
--
-- Adds:
--   * agent_memory.alpha / beta  — Beta-Binomial usefulness posteriors
--                                  (Beta(1,1) prior → reranker no-op until
--                                  raters move them).
--   * memory_retrieval           — audit log of which memories were surfaced
--                                  to which task (used by ImplicitCitationRater
--                                  + worker rating endpoints in steps 2/3).
--   * memory_rating              — append-only audit of every RatingEvent the
--                                  framework applied. Hot-path posteriors live
--                                  on agent_memory; this table preserves the
--                                  signal/weight/source for offline analysis.
--
-- Spam guard (R6): partial unique index on (taskId, memoryId) WHERE source =
-- 'explicit-self'. Enforces "at most one explicit-self rating per (task, memory)"
-- at the DB layer; HTTP/MCP can surface SQLITE_CONSTRAINT as 409.
--
-- FK target is agent_tasks(id) — the brainstorm referenced `tasks(id)` but the
-- actual table name is agent_tasks (see Deviation A in step-1.md).

-- 1. Beta posteriors on every memory row (default Beta(1,1) → usefulness 1.0).
ALTER TABLE agent_memory ADD COLUMN alpha REAL NOT NULL DEFAULT 1.0;
ALTER TABLE agent_memory ADD COLUMN beta  REAL NOT NULL DEFAULT 1.0;

-- 2. Retrieval audit — populated by /api/memory/search when X-Source-Task-ID
--    is present (wired in step-2). Created here so step-2 can land in parallel.
CREATE TABLE IF NOT EXISTS memory_retrieval (
  id          TEXT PRIMARY KEY,
  taskId      TEXT,
  agentId     TEXT NOT NULL,
  sessionId   TEXT,
  memoryId    TEXT NOT NULL,
  similarity  REAL,
  retrievedAt TEXT NOT NULL,
  FOREIGN KEY (taskId) REFERENCES agent_tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memret_task   ON memory_retrieval(taskId);
CREATE INDEX IF NOT EXISTS idx_memret_agent  ON memory_retrieval(agentId);
CREATE INDEX IF NOT EXISTS idx_memret_memory ON memory_retrieval(memoryId);

-- 3. Rating audit — every applied RatingEvent. `source` is the rater name,
--    set by applyRating (raters MUST NOT populate it themselves).
CREATE TABLE IF NOT EXISTS memory_rating (
  id        TEXT PRIMARY KEY,
  memoryId  TEXT NOT NULL,
  taskId    TEXT,
  source    TEXT NOT NULL,
  signal    REAL NOT NULL,
  weight    REAL NOT NULL,
  reasoning TEXT,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (taskId) REFERENCES agent_tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memrat_memory ON memory_rating(memoryId);
CREATE INDEX IF NOT EXISTS idx_memrat_task   ON memory_rating(taskId);

-- DB-owned spam guard (R6): one explicit-self per (taskId, memoryId).
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_rating_explicit_unique
  ON memory_rating(taskId, memoryId)
  WHERE source = 'explicit-self';

-- 052_memory_edges.sql
-- Memory rater v1.5 step-6 — `references-source` edges, lite (v1.5 wedge).
--
-- Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-6.md §1
-- (The plan referred to this as `050_*`; numbers 049–051 were taken on main
-- between plan-write and step-6 implement, so this migration ships at 052 —
-- semantics are unchanged.)
--
-- Adds:
--   * agent_memory_edge — directed edges from a memory to an external entity,
--                         with their own Beta-Binomial usefulness posteriors.
--                         v1.5 ships exactly one edge type — references-source.
--
-- Q2 LOCKED (per step-6.md §1) — `to_id` is a free-form TEXT column. No closed
-- enum, no parser, no migration when a new integration shows up. Convention is
-- documented as `<source>:<identifier>` (e.g. github:owner/repo#N,
-- linear:KEY-N, customer:<slug>) but enforced only at write-site (≤512 chars,
-- control-char strip, no NUL).
--
-- The `CHECK (type = 'references-source')` constraint is intentionally
-- restrictive — lifting it = a forward migration that drops + recreates the
-- constraint with the v2 enum. Edge GC + multi-type edges are reserved for v2.

CREATE TABLE IF NOT EXISTS agent_memory_edge (
  from_id   TEXT NOT NULL,                                                -- memory id
  to_id     TEXT NOT NULL,                                                -- free-form external entity id (Q2 contract)
  type      TEXT NOT NULL CHECK (type = 'references-source'),             -- v1.5: ONE type only
  alpha     REAL NOT NULL DEFAULT 1.0,
  beta      REAL NOT NULL DEFAULT 1.0,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, type),
  FOREIGN KEY (from_id) REFERENCES agent_memory(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memedge_from ON agent_memory_edge(from_id);
CREATE INDEX IF NOT EXISTS idx_memedge_to   ON agent_memory_edge(to_id);
CREATE INDEX IF NOT EXISTS idx_memedge_type ON agent_memory_edge(type);

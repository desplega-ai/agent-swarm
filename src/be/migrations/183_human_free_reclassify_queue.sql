-- Continuation queue for the human-free reclassification (migration 182).
--
-- Reclassifying a subtree used to walk every descendant inside the request that
-- changed a classifying input, so a very large task tree could hold the write
-- lock and the event loop for the whole walk. The walk now handles a bounded
-- batch inline and parks the rest here; a background drain
-- (src/be/human-free-drain.ts) works the queue off in bounded batches, each in
-- its own transaction. Rows are written in the same transaction as the mutation
-- that needs them, so a crash can neither lose nor half-apply the remainder.
--
--   scope = 'self'      re-evaluate `taskId` and everything below it
--   scope = 'children'  re-evaluate the children of `taskId` whose rowid is
--                       above `afterRowid`, and everything below them
--
-- One row per (taskId, scope): a repeat enqueue restarts that row from the top.
-- `hops` counts how many batches deep a continuation is, so a parent cycle that
-- the product never writes cannot re-queue itself forever.
CREATE TABLE human_free_reclassify_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('self', 'children')),
  afterRowid INTEGER NOT NULL DEFAULT 0,
  hops INTEGER NOT NULL DEFAULT 0,
  UNIQUE (taskId, scope)
);

-- Supporting indexes for the usefulness readout (GET /api/memory/usefulness)
-- and the per-arm citation EXISTS probe. Prior to this, the windowed volume
-- query scanned memory_retrieval (no retrievedAt index) and the citation
-- EXISTS probed memory_rating via the single-column taskId index only.

CREATE INDEX IF NOT EXISTS idx_memret_retrieved_at ON memory_retrieval(retrievedAt);

-- Per-arm citation probe: EXISTS (taskId, memoryId, source, signal).
CREATE INDEX IF NOT EXISTS idx_memrat_task_memory_source ON memory_rating(taskId, memoryId, source);

-- Citation-by-source window: WHERE source = ? AND createdAt > ?.
CREATE INDEX IF NOT EXISTS idx_memrat_source_created_at ON memory_rating(source, createdAt);

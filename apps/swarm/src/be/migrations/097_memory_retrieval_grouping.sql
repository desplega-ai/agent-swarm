-- Add explicit per-search grouping to memory_retrieval.
--
-- `recordRetrievals()` writes one row per returned memory. A single
-- retrievalId groups all rows from the same search/get call, and rank
-- preserves the result order within that call for precision@k/MRR analysis.

ALTER TABLE memory_retrieval ADD COLUMN retrievalId TEXT;
ALTER TABLE memory_retrieval ADD COLUMN rank INTEGER;

CREATE INDEX idx_memret_retrieval_id ON memory_retrieval(retrievalId);

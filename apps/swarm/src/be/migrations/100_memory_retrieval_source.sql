-- Surface which search arm retrieved each memory_retrieval row.
--
-- Values are written by recordRetrievals(): vec, fts, hybrid, or fallback.
-- Existing rows stay NULL because older searches did not record provenance.

ALTER TABLE memory_retrieval ADD COLUMN retrievalSource TEXT;

CREATE INDEX idx_memret_retrieval_source ON memory_retrieval(retrievalSource);

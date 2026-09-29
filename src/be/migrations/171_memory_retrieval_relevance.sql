-- Record the pre-boost relevance each memory_retrieval row was gated on.
--
-- `similarity` stays the reranker's composite score (it includes recency,
-- access, source-quality and usefulness multipliers, so it is not bounded).
-- `relevance` is the [0,1] match score the pre-task injection threshold
-- compares against. Existing rows stay NULL.

ALTER TABLE memory_retrieval ADD COLUMN relevance REAL;

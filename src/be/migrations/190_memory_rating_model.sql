-- Record which model produced each `llm` memory rating. The judge comes from a
-- per-credential default, so it can change without any row-level trace; on
-- 2026-09-23 it moved from Gemini 3 Flash to DeepSeek v4.1 Flash and the score
-- distribution shifted with nothing on the rows to explain it.
-- Holds the resolved "<provider>/<model-id>" string. NULL for every other
-- rating source, and for `llm` rows written before this column existed.
ALTER TABLE memory_rating ADD COLUMN model TEXT;

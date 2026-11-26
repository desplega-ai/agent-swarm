-- Phrase search on task text without rereading the text. The GIN index of
-- migration 368 (agent_tasks_fts_task) stores which words a task has, not
-- where, so a phrase such as "ping-gate" ('ping' <-> 'gate':*) rechecks every
-- task that has both words by rebuilding its tsvector from the text. On a
-- production-sized table that is thousands of long texts and takes 25-45 s.
-- This index stores each pair of adjacent words as one lexeme ("ping" + "gate"
-- becomes "pingǂgate"), so a phrase is a lookup of its pairs. The repository
-- (packages/storage-postgres/src/repositories/tasks.ts, TASK_PAIRS_TSVECTOR)
-- repeats the indexed expression exactly.

-- The words of fts_words, each joined to the next one by ǂ (U+01C2, a letter
-- that the parser keeps inside a word and that task text does not use). The
-- first pass joins words 1+2, 3+4, ...; the second pass drops word 1 and
-- joins 2+3, 4+5, ...; together they hold every adjacent pair. A word left
-- without a partner stays as a lexeme of its own, which a pair query never
-- matches.
CREATE OR REPLACE FUNCTION fts_join_pairs(words text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN regexp_replace(words, '(\S+) (\S+)', '\1ǂ\2', 'g')
    || ' '
    || regexp_replace(regexp_replace(words, '^\S+ ?', ''), '(\S+) (\S+)', '\1ǂ\2', 'g');

CREATE OR REPLACE FUNCTION fts_word_pairs(input text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN fts_join_pairs(btrim(fts_words(input)));

-- The build reads every task text and holds a SHARE lock on agent_tasks, which
-- blocks task writes for minutes on a large table. To avoid that, run this file
-- by hand before the deploy with CREATE INDEX CONCURRENTLY: every statement here
-- is idempotent, so the migration then finds the index and skips it.
CREATE INDEX IF NOT EXISTS "agent_tasks_fts_task_pairs" ON "agent_tasks" USING gin ((to_tsvector('simple', fts_word_pairs("task"))));

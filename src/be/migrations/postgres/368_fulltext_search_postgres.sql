-- Full-text search on Postgres (decision D15): built-in tsvector with GIN
-- expression indexes over the base tables. They are the counterparts of the
-- SQLite FTS5 tables skills_fts (239), skills_meta_fts (241) and
-- agent_tasks_fts (257). An expression index stays in sync with its table by
-- itself, so there is no shadow table and no sync trigger (D9), and nothing to
-- backfill: agent_tasks_fts_state only keeps the SQLite watermark contract.
-- The repositories (packages/storage-postgres/src/repositories/skills.ts and
-- tasks.ts) repeat each indexed expression exactly; the planner uses an index
-- only for an equal expression (packages/storage-postgres/test/fulltext.test.ts).

-- The text a tokenizer sees. FTS5 unicode61 splits on every character that is
-- not a letter or a digit; the Postgres parser keeps hyphenated words, file
-- paths, URLs, e-mail addresses and version numbers as tokens of their own.
-- ASCII punctuation, Latin-1 symbols and the common Unicode punctuation and
-- symbol blocks turn into spaces, so both engines split the same words (the C
-- ctype of a swarm database has no Unicode [:alnum:] class). The first 100000
-- characters only: a tsvector holds at most 1 MB, and an index expression that
-- fails would fail the INSERT. Positions above 16383 collapse in a tsvector
-- anyway, so a longer text loses phrase matches beyond that point already.
CREATE FUNCTION fts_words(input text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN regexp_replace(
    left(input, 100000),
    '[\x01-\x2f\x3a-\x40\x5b-\x60\x7b-\xa9\xab-\xb1\xb4\xb6-\xb8\xbb\xbf\xd7\xf7\u2000-\u2bff\u3000-\u303f\ufe30-\ufe4f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\U0001f000-\U0001faff]+',
    ' ',
    'g'
  );

-- Skills: the skills_fts columns with the bm25 weights as tsvector weights
-- (name A, description B, content C). english stems like the porter tokenizer.
CREATE INDEX "skills_fts_search" ON "skills" USING gin ((
  setweight(to_tsvector('english', fts_words("name")), 'A')
  || setweight(to_tsvector('english', fts_words("description")), 'B')
  || setweight(to_tsvector('english', fts_words("content")), 'C')
));

-- Tasks: one index per column, as an FTS5 phrase never spans two columns.
-- simple does not stem, like the unicode61 tokenizer without porter.
CREATE INDEX "agent_tasks_fts_task" ON "agent_tasks" USING gin ((to_tsvector('simple', fts_words("task"))));
CREATE INDEX "agent_tasks_fts_title" ON "agent_tasks" USING gin ((to_tsvector('simple', fts_words("title"))));

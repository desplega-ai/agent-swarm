-- Memory full-text and vector search on Postgres (milestone M4, decision D15).
-- SQLite keeps these as run-time tables outside the chain: memory_fts (FTS5,
-- porter unicode61) and memory_vec (sqlite-vec vec0, cosine). The SQLite file
-- of this ordinal is a no-op.

-- Full text: an expression GIN index on agent_memory, so no shadow table and no
-- sync trigger (D9). The text configuration is english with a snowball stemmer
-- that keeps stop words: FTS5 indexes every word, and the memory query ORs its
-- terms, so a stop word must match on both engines.
CREATE TEXT SEARCH DICTIONARY memory_english_stem (TEMPLATE = snowball, LANGUAGE = english);
CREATE TEXT SEARCH CONFIGURATION memory_english (COPY = english);
ALTER TEXT SEARCH CONFIGURATION memory_english
  ALTER MAPPING REPLACE english_stem WITH memory_english_stem;

-- unicode61 splits on every character that is not a letter or a digit. The
-- default Postgres parser keeps some punctuation inside tokens (paths, emails,
-- URLs, hyphenated words, versions), and in a C ctype database it reads every
-- non-ASCII character as a letter. This turns ASCII punctuation and the common
-- Unicode punctuation and symbol blocks into spaces first, on the indexed text
-- and on each query term alike.
CREATE FUNCTION memory_fts_text(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT regexp_replace(value,
    '[[:punct:][:space:]\u00A0-\u00BF\u00D7\u00F7\u2000-\u206F\u2190-\u2BFF\u3000-\u303F\uFE30-\uFE4F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\U0001F000-\U0001FAFF]+',
    ' ', 'g') $$;

-- name and content weigh the same, as bm25() with no column weights.
CREATE INDEX "idx_agent_memory_fts" ON "agent_memory" USING gin ((
  to_tsvector('memory_english'::regconfig, memory_fts_text("name"))
  || to_tsvector('memory_english'::regconfig, memory_fts_text("content"))));

-- Vectors: one row per memory whose embedding has the configured dimension,
-- written by the memory store as it writes memory_vec on SQLite. The column has
-- no fixed dimension: SQLite sizes memory_vec from EMBEDDING_DIMENSIONS at run
-- time, which a migration cannot read, and exact k-NN (no ANN index, D15) does
-- not need one. No foreign key: memory_vec on SQLite has none, and the health
-- counts report rows whose memory is gone (extraInVec).
CREATE TABLE "memory_vec" (
  "memory_id" text NOT NULL,
  "embedding" vector NOT NULL,
  PRIMARY KEY ("memory_id")
);

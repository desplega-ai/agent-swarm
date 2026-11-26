-- Memory full-text search reads stored documents (decision D15). Migration 369
-- indexed an expression over agent_memory, so each search ran to_tsvector on
-- the name and content of every matching memory, several times for each row:
-- seconds on a large corpus. This migration stores what the search needs, as
-- SQLite keeps the run-time FTS5 table memory_fts:
--
-- - memory_fts: one row per memory. doc is the name and the content as one
--   tsvector, the name positions with weight B and the content positions with
--   the default weight D. A phrase query with one weight on each word stays
--   inside one field, as an FTS5 phrase does. doc_len is the token count bm25
--   reads. The memory store writes the row in the transaction that writes the
--   memory (no trigger, D9); the foreign key deletes it with the memory.
-- - The expression index of 369 goes: no statement reads it any more, and it
--   ran to_tsvector on each memory insert and update.

-- The stored document of one memory. IMMUTABLE as to_tsvector with a fixed
-- configuration and memory_fts_text are.
CREATE FUNCTION memory_fts_document(name text, content text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT setweight(to_tsvector('memory_english'::regconfig, memory_fts_text(name)), 'B')
               || to_tsvector('memory_english'::regconfig, memory_fts_text(content)) $$;

-- The token count of a document: the positions of each lexeme (a tsvector
-- keeps at most 256 for each lexeme).
CREATE FUNCTION memory_fts_length(document tsvector) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT COALESCE(SUM(COALESCE(array_length(u.positions, 1), 1)), 0)::integer
          FROM unnest(document) u $$;

CREATE TABLE "memory_fts" (
  "memory_id" text NOT NULL,
  "doc" tsvector NOT NULL,
  "doc_len" integer NOT NULL,
  PRIMARY KEY ("memory_id"),
  FOREIGN KEY ("memory_id") REFERENCES "agent_memory" ("id") ON DELETE CASCADE
);

-- The rows of existing memories. db-copy runs this on empty tables and fills
-- memory_fts itself after it copies agent_memory.
INSERT INTO "memory_fts" ("memory_id", "doc", "doc_len")
SELECT s.id, s.doc, memory_fts_length(s.doc)
  FROM (SELECT id, memory_fts_document("name", "content") AS doc FROM "agent_memory") s;

CREATE INDEX "idx_memory_fts_doc" ON "memory_fts" USING gin ("doc");
-- bm25 reads the row count and the average length on each search. With this
-- index that read is an index-only scan, not a scan of every stored document.
CREATE INDEX "idx_memory_fts_doc_len" ON "memory_fts" ("doc_len");

DROP INDEX IF EXISTS "idx_agent_memory_fts";

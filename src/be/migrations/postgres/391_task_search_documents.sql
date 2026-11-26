-- Task search reads stored search documents (decision D15). Migration 368
-- indexed expressions over agent_tasks, so a phrase search ran to_tsvector on
-- the text of each candidate task to check the word positions, and a search
-- that the planner ran in list order parsed every task until it had a page.
-- On a database with long task texts that took seconds to minutes. This
-- migration stores the documents, as SQLite keeps the FTS5 table
-- agent_tasks_fts (257):
--
-- - task_search_document: the tsvector of one text, equal to the expressions
--   of 368 (the first 100000 characters, fts_words, the simple configuration).
-- - agent_tasks_search: one row per task, the document of its task text and
--   of its title. The tasks repository writes the row in the statement that
--   writes the task text or title (no trigger, D9); the foreign key deletes it
--   with the task.
--
-- The documents of existing tasks are not built here: on a large database that
-- takes minutes, and the API does not serve requests while migrations run. The
-- task search backfill builds them in batches after the start
-- (src/be/db/tasks/search-index.ts), from the mark in agent_tasks_fts_state,
-- which this migration sets back to 0. Until the mark is complete, a task past
-- it matches through the expression indexes of 368, so search stays correct.
-- db-copy builds the documents of the copied tasks itself.

CREATE FUNCTION task_search_document(input text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN to_tsvector('simple', fts_words(input));

CREATE TABLE "agent_tasks_search" (
  "task_id" text NOT NULL,
  "task_doc" tsvector NOT NULL,
  "title_doc" tsvector,
  PRIMARY KEY ("task_id"),
  FOREIGN KEY ("task_id") REFERENCES "agent_tasks" ("id") ON DELETE CASCADE
);

CREATE INDEX "agent_tasks_search_task_doc" ON "agent_tasks_search" USING gin ("task_doc");
CREATE INDEX "agent_tasks_search_title_doc" ON "agent_tasks_search" USING gin ("title_doc");

UPDATE "agent_tasks_fts_state" SET "indexedThrough" = 0
  WHERE "id" = 1 AND EXISTS (SELECT 1 FROM "agent_tasks");

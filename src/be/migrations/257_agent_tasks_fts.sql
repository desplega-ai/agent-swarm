-- Token index for task search (getAllTasks / getTasksCount `search`), which
-- used to run `task LIKE '%q%'` over every task body. External content: the
-- index stores no copy of the text, rows are keyed by agent_tasks.rowid, and
-- the default unicode61 tokenizer (no porter: ids and numbers stay exact).
CREATE VIRTUAL TABLE IF NOT EXISTS agent_tasks_fts USING fts5(
  task,
  title,
  content='agent_tasks',
  content_rowid='rowid'
);

-- Rows with rowid <= indexedThrough are in the index. A full backfill would
-- block boot and hold the write lock, so the migration indexes nothing and
-- the API backfills in rowid batches after boot (backfillTaskSearchIndex in
-- src/be/db/tasks/search-index.ts), raising indexedThrough in the same
-- transaction as each batch. Once it reaches 9007199254740991 every row is
-- indexed and search switches from LIKE to the index. An empty table starts
-- complete.
CREATE TABLE IF NOT EXISTS agent_tasks_fts_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  indexedThrough INTEGER NOT NULL
);

INSERT OR IGNORE INTO agent_tasks_fts_state (id, indexedThrough)
  SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM agent_tasks) THEN 0 ELSE 9007199254740991 END;

-- Triggers keep the index in sync on every write path (the two INSERT sites,
-- title updates, the draft append, the boot scrub sweep, deletes). They touch
-- only rows the backfill has reached: an external-content 'delete' must name
-- a row the index holds, or it corrupts the index. A rebuild of agent_tasks
-- must keep rowids (the index is keyed by them) and recreate these triggers;
-- src/tests/task-search-fts.test.ts covers the runtime.ts rebuild.
CREATE TRIGGER IF NOT EXISTS agent_tasks_fts_insert
AFTER INSERT ON agent_tasks
WHEN NEW.rowid <= (SELECT indexedThrough FROM agent_tasks_fts_state WHERE id = 1)
BEGIN
  INSERT INTO agent_tasks_fts(rowid, task, title) VALUES (NEW.rowid, NEW.task, NEW.title);
END;

CREATE TRIGGER IF NOT EXISTS agent_tasks_fts_update
AFTER UPDATE OF task, title ON agent_tasks
WHEN OLD.rowid <= (SELECT indexedThrough FROM agent_tasks_fts_state WHERE id = 1)
BEGIN
  INSERT INTO agent_tasks_fts(agent_tasks_fts, rowid, task, title)
    VALUES ('delete', OLD.rowid, OLD.task, OLD.title);
  INSERT INTO agent_tasks_fts(rowid, task, title) VALUES (NEW.rowid, NEW.task, NEW.title);
END;

CREATE TRIGGER IF NOT EXISTS agent_tasks_fts_delete
AFTER DELETE ON agent_tasks
WHEN OLD.rowid <= (SELECT indexedThrough FROM agent_tasks_fts_state WHERE id = 1)
BEGIN
  INSERT INTO agent_tasks_fts(agent_tasks_fts, rowid, task, title)
    VALUES ('delete', OLD.rowid, OLD.task, OLD.title);
END;

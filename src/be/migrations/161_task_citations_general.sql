-- A general citation backs the whole answer rather than one claim; it may stay
-- unreferenced in the task output and renders under "General sources".
ALTER TABLE task_citations ADD COLUMN general INTEGER NOT NULL DEFAULT 0 CHECK (general IN (0, 1));

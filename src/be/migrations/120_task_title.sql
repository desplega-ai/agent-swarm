-- Human-facing display title for a task. In v1 only set on root tasks
-- ("sessions"); NULL falls back to the task prompt in every UI surface.
ALTER TABLE agent_tasks ADD COLUMN title TEXT;

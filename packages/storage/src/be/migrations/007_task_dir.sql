-- Add optional working directory field to tasks
ALTER TABLE agent_tasks ADD COLUMN dir TEXT;

-- Add outputSchema column to agent_tasks for structured output validation
ALTER TABLE agent_tasks ADD COLUMN outputSchema TEXT;

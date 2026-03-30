-- Store which credential type (env var name) was used per task
ALTER TABLE agent_tasks ADD COLUMN credentialKeyType TEXT;

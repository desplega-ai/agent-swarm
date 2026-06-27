-- Add runnerSessionId and providerSessionId to active_sessions
-- for correlating session logs with pool tasks
ALTER TABLE active_sessions ADD COLUMN runnerSessionId TEXT;
ALTER TABLE active_sessions ADD COLUMN providerSessionId TEXT;

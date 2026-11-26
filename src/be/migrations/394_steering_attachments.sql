-- Steering messages can carry files a person attached in the steer composer.
-- The files are ordinary task attachments (uploaded through the task files
-- route); this column keeps a JSON snapshot of the ones a message points at
-- (`[{id, taskId, name, mimeType?, sizeBytes?}]`) so delivery can list them
-- without a lookup per message. NULL: a text-only message.
ALTER TABLE task_steering_messages ADD COLUMN attachments TEXT;

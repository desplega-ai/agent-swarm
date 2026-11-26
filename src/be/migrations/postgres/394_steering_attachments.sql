-- Same as the SQLite 394: a JSON snapshot of the task attachments a steering
-- message points at, stored as text and parsed by the API. NULL: text only.
ALTER TABLE "task_steering_messages" ADD COLUMN "attachments" text;

-- Acceptance note for steering messages: accept-steer's optional `note`
-- ("how the steering was incorporated") was previously response-only; persist
-- it so the UI can surface it on the HANDLED state.
ALTER TABLE task_steering_messages ADD COLUMN handled_note TEXT;

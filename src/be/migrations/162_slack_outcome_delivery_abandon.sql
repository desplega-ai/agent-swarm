-- Persist the outcome-delivery give-up. The renderer counted failures in
-- process memory (render-v2.ts outcomeDeliveryFailures), so every restart
-- re-armed 5 more attempts and 1 more "Couldn't deliver" warning for a card
-- Slack refuses for good.
ALTER TABLE slack_messages ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;

-- Set once the renderer stops trying to deliver this outcome card: a terminal
-- Slack error, or delivery_attempts reached the ceiling. A row with this set
-- is settled for the tree query and the per-task loops, like finalized_at.
ALTER TABLE slack_messages ADD COLUMN delivery_abandoned_at TEXT;

-- Last Slack verdict for the card: "<code>: <response_metadata.messages>",
-- truncated to 500 characters. Diagnostic only.
ALTER TABLE slack_messages ADD COLUMN delivery_last_error TEXT;

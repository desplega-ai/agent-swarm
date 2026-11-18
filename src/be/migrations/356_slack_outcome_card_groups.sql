-- A Lead follow-up outcome card can merge into the previous card of the same
-- agent in the thread: the renderer edits that card (the "host") and adds the
-- follow-up's answer under it, so the thread gets one message, not two.
--
-- The follow-up keeps its own outcome row, so every per-task check (settled,
-- relay delivered, thread closure) works without change. That row has no
-- Slack message of its own: its ts is the placeholder "merged:<id>" (the
-- (channel_id, ts) index stays unique), its permalink is the host's, and this
-- column points at the host row.
ALTER TABLE slack_messages ADD COLUMN merged_into_id TEXT
  REFERENCES slack_messages(id) ON DELETE SET NULL;

CREATE INDEX idx_slack_messages_merged_into
  ON slack_messages(merged_into_id) WHERE merged_into_id IS NOT NULL;

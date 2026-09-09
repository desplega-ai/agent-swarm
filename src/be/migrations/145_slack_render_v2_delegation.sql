-- Delegated-delivery lifecycle state for Slack render v2.
--
-- delegation_activated_at: first instant SLACK_RENDER_V2_DELEGATION was on.
-- Ask tasks created before it keep the pre-delegation card behavior.
ALTER TABLE slack_render_v2_state ADD COLUMN delegation_activated_at TEXT;

-- conclusion_kind: how an ask's outcome card concluded.
--   'complete' — closure settled-terminal.
--   'timeout'  — concluded with unfinished work after the idle timeout.
-- NULL for child cards, agent messages, trees, and pre-delegation cards.
ALTER TABLE slack_messages ADD COLUMN conclusion_kind TEXT
  CHECK (conclusion_kind IN ('complete', 'timeout') OR conclusion_kind IS NULL);

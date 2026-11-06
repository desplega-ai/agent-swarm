-- Multi-person Slack threads: the people in the thread when the task was
-- created ({people: [{slackUserId, userId?, trust, starter?, newest?, asked?}],
-- more}). NULL: not a Slack task, or created before this column existed.
ALTER TABLE agent_tasks ADD COLUMN slackParticipants TEXT;

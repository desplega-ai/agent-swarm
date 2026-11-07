-- JSON of AgentSlackIcon for the agent's Slack posts. NULL = default emoji.
ALTER TABLE agents ADD COLUMN slack_icon TEXT;

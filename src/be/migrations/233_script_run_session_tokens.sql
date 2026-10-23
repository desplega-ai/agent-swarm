-- Mark the ephemeral session token a script run uses for its ctx.swarm SDK
-- calls, so it stands in for the executing agent instead of the operator key.
-- It shares the all-null binding shape of an agent (worker) token, so this
-- flag is what keeps the two lifecycles apart: worker-token queries
-- (AGENT_TOKEN_BINDING) filter on scriptRun = 0, so minting or revoking an
-- agent's worker token never touches a script run's in-flight token, and a
-- script run's token never counts as the agent's worker token.
ALTER TABLE session_tokens ADD COLUMN scriptRun INTEGER NOT NULL DEFAULT 0;

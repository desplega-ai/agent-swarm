-- The agent a workflow run was started by, stamped by the server.
--
-- A `swarm-script` node in a workflow with no creator used to run as
-- `trigger.agentId`, which the caller supplies. Any agent could then start a
-- creator-less workflow with `{"agentId": "<lead id>"}` and run its scripts
-- with a credential minted for the lead. The principal now comes from this
-- column: the calling agent for manual and API triggers, the schedule's
-- creator for scheduled runs, the parent run's principal for a child run,
-- and NULL (no agent) for webhooks and events. Existing runs keep NULL.

ALTER TABLE workflow_runs ADD COLUMN triggeredByAgentId TEXT;

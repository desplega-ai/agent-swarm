-- 055_agent_cred_status.sql
--
-- Worker-self-reported credential snapshot. Pairs with `harness_provider`
-- (054): the JSON describes the agent's creds for whichever harness that
-- agent runs. NULL = unreported (worker hasn't booted yet, or
-- CRED_CHECK_DISABLE=1 was set).
--
-- The existing `credentialMissing` column (053) stays. This one is additive
-- and carries the full snapshot (ready, missing, satisfiedBy, hint,
-- liveTest, reportedAt, reportKind). Once `cred_status.missing` is proven
-- across deploys, `credentialMissing` can be retired in a later migration.
--
-- Forward-only.

ALTER TABLE agents ADD COLUMN cred_status TEXT;

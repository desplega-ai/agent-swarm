-- 113_task_routing_affinity.sql
-- Routing-affinity snapshot for interrupted/pooled tasks (routing-affinity
-- follow-up to DES-523). Nullable JSON blob: { sourceAgentId, role,
-- harnessProvider, capabilities }, always written/read whole. NULL = the
-- task is untagged and pool behavior is unchanged. See
-- `isAgentEligibleForTask` in src/be/db.ts and `RoutingAffinitySchema` in
-- src/types.ts.

ALTER TABLE agent_tasks ADD COLUMN routingAffinity TEXT;

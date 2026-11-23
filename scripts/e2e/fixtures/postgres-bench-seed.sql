-- Bench-only seed for `E2E_POSTGRES_SEED_SQL` (decision D7 re-measure, ledger part 7).
-- Gives a per-run Postgres database a production-like history before the API boots:
-- 300 offline worker agents and 60,000 finished tasks. With tables this size the
-- planner uses index scans, so SERIALIZABLE takes tuple and page predicate locks
-- instead of the relation locks it takes on the near-empty e2e tables.
INSERT INTO agents (id, name, "isLead", status, role, "maxTasks", "createdAt", "lastUpdatedAt")
SELECT 'bench-seed-agent-' || g, 'bench-seed-agent-' || g, false, 'offline', 'worker', 1,
       now() - interval '30 days', now() - interval '30 days'
FROM generate_series(1, 300) AS g;

INSERT INTO agent_tasks (id, "agentId", task, status, source, priority, "createdAt", "lastUpdatedAt", "finishedAt")
SELECT 'bench-seed-task-' || g,
       'bench-seed-agent-' || (1 + g % 300),
       'Bench seed task ' || g,
       CASE WHEN g % 10 = 0 THEN 'failed' ELSE 'completed' END,
       'mcp', 50,
       now() - (g || ' seconds')::interval,
       now() - (g || ' seconds')::interval,
       now() - (g || ' seconds')::interval
FROM generate_series(1, 60000) AS g;

ANALYZE;

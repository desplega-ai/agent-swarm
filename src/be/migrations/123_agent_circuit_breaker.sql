-- Provider-health circuit breaker (zero-token death detection).
--
-- Two real installs burned tens of thousands of dead sessions when their
-- provider (OpenRouter) rejected every call with 401/402 after credits ran
-- out: the harness reported "completed" sessions with 0 tokens, and the
-- existing heartbeat crash-recovery + Lead-escalation loop kept
-- re-dispatching indefinitely. The resume-generation cap only bounds a
-- single task lineage (a task tag) — every Lead re-dispatch via send-task
-- mints a brand-new, ungoverned lineage with no generation heritage. This
-- tracks health at the AGENT level instead, sourced from session_costs, so
-- no dispatch path (resume creation, pool auto-assign, explicit send-task)
-- can loop forever once tripped, regardless of how many task trees it spins
-- up. See src/be/circuit-breaker.ts for the decision logic.
--
-- No CHECK constraint on circuitBreakerState (validated at the application
-- layer) — avoids the full-table-rebuild dance migration 053 needed for a
-- CHECK'd enum column.
ALTER TABLE agents ADD COLUMN circuitBreakerState TEXT NOT NULL DEFAULT 'closed';
ALTER TABLE agents ADD COLUMN consecutiveZeroTokenSessions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN circuitBreakerTrippedAt TEXT;
ALTER TABLE agents ADD COLUMN circuitBreakerReason TEXT;

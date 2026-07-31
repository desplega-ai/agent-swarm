/**
 * Provider-health circuit breaker.
 *
 * Detects the "zero-token death" signature — a session that reports as
 * completed with zero input/output tokens and a near-instant duration,
 * meaning the harness's upstream provider rejected the call before any
 * inference ran (401/402: revoked key or exhausted credits) — and stops the
 * swarm from re-dispatching to that agent indefinitely.
 *
 * Why per-AGENT and not per-task-lineage: the existing resume-generation cap
 * (`HEARTBEAT_MAX_RESUME_GENERATIONS`, src/heartbeat/heartbeat.ts) only bounds
 * a single task lineage via a tag inherited from parent to child. It works
 * correctly within one lineage, but a Lead re-dispatch via `send-task` mints a
 * brand-new task with no generation tag at all — so every escalation cycle
 * resets the effective budget to zero. The 2026-07-31 incident measured this:
 * one dead OpenRouter key produced ~2,300-3,500 self-generated tasks/day for
 * 15 days (34k+ total) via exactly this reset. Tracking health per-agent from
 * `session_costs` — independent of task tags/trees — closes that gap: no
 * dispatch chokepoint (resume creation, pool auto-assign, explicit send-task)
 * can loop forever once tripped, no matter how many fresh lineages it spins
 * up in the attempt.
 */

import { telemetry } from "../telemetry";
import type { SessionCost } from "../types";
import {
  getAgentById,
  resetAgentCircuitBreaker,
  tryClaimCircuitBreakerProbe,
  updateAgentCircuitBreaker,
} from "./db";

/** Consecutive zero-token sessions required to trip the breaker. */
function zeroTokenThreshold(): number {
  return Number(process.env.CIRCUIT_BREAKER_ZERO_TOKEN_THRESHOLD) || 3;
}

/** A session shorter than this AND carrying zero tokens is "death", not a legitimately cheap real session. */
function maxDeathDurationMs(): number {
  return Number(process.env.CIRCUIT_BREAKER_ZERO_TOKEN_MAX_DURATION_MS) || 5000;
}

/** Cooldown before a tripped breaker allows a single half-open probe through. */
function cooldownMinutes(): number {
  return Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MIN) || 30;
}

/**
 * The zero-token-death signature: no tokens in either direction, and fast
 * enough that real inference plausibly never started. Duration is required
 * in addition to the token check — a legitimately cheap real session (a
 * one-line "ack" reply) can also report low tokens on some harnesses, but it
 * cannot report BOTH zero input and zero output AND finish near-instantly,
 * since even a trivial round trip to the provider takes real wall-clock time.
 */
export function isZeroTokenDeath(
  session: Pick<SessionCost, "inputTokens" | "outputTokens" | "durationMs">,
): boolean {
  return (
    session.inputTokens === 0 &&
    session.outputTokens === 0 &&
    session.durationMs < maxDeathDurationMs()
  );
}

function humanReason(agentId: string, count: number): string {
  return `Provider returned no tokens for ${count} consecutive session(s) on agent ${agentId} — check your provider API key and credit balance.`;
}

/**
 * Call after every `session_costs` write. Updates the per-agent consecutive
 * zero-token-death counter and trips/closes the breaker accordingly.
 *
 * - A real-token session always closes the breaker (covers both normal
 *   operation and a successful half-open probe).
 * - A zero-token-death session increments the counter; once it reaches the
 *   threshold the breaker trips. If the breaker was ALREADY open (this is the
 *   result of a half-open probe), any zero-token-death session re-trips it
 *   immediately and extends the cooldown, regardless of the raw count vs.
 *   threshold — a probe only gets one shot.
 */
export function recordSessionForCircuitBreaker(session: SessionCost): void {
  const agent = getAgentById(session.agentId);
  if (!agent) return;

  if (!isZeroTokenDeath(session)) {
    if (agent.circuitBreakerState !== "closed" || (agent.consecutiveZeroTokenSessions ?? 0) > 0) {
      resetAgentCircuitBreaker(agent.id);
    }
    return;
  }

  const count = (agent.consecutiveZeroTokenSessions ?? 0) + 1;
  const wasOpen = agent.circuitBreakerState === "open";
  const threshold = zeroTokenThreshold();

  if (wasOpen || count >= threshold) {
    const reason = humanReason(agent.id, count);
    updateAgentCircuitBreaker(agent.id, {
      state: "open",
      consecutiveZeroTokenSessions: count,
      trippedAt: new Date().toISOString(),
      reason,
    });
    if (wasOpen) {
      console.warn(
        `[CircuitBreaker] Agent ${agent.id.slice(0, 8)} half-open probe still zero-token — re-opened, cooldown extended`,
      );
    } else {
      console.warn(`[CircuitBreaker] Agent ${agent.id.slice(0, 8)} tripped — ${reason}`);
      telemetry.agent("circuit_tripped", {
        agentId: agent.id,
        consecutiveZeroTokenSessions: count,
        model: session.model,
      });
    }
    return;
  }

  updateAgentCircuitBreaker(agent.id, {
    state: "closed",
    consecutiveZeroTokenSessions: count,
    trippedAt: null,
    reason: null,
  });
}

export interface DispatchDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * The single choke point every dispatch path (crash-recovery resume creation,
 * pool auto-assign, explicit send-task) should call before handing an agent
 * new work.
 *
 * - Closed → always allowed.
 * - Open, cooldown not elapsed → refused.
 * - Open, cooldown elapsed → exactly one caller wins the half-open probe
 *   (atomic DB claim); every other concurrent caller is still refused until
 *   the probe's outcome lands and either closes or re-trips the breaker.
 */
export function canDispatchToAgent(agentId: string): DispatchDecision {
  const agent = getAgentById(agentId);
  if (!agent) return { allowed: true }; // Unknown agent — not this breaker's problem.
  if (agent.circuitBreakerState !== "open") return { allowed: true };

  const cooldownCutoff = new Date(Date.now() - cooldownMinutes() * 60_000).toISOString();
  const wonProbe = tryClaimCircuitBreakerProbe(agentId, cooldownCutoff);
  if (wonProbe) {
    console.log(
      `[CircuitBreaker] Agent ${agentId.slice(0, 8)} half-open probe allowed (cooldown elapsed)`,
    );
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      agent.circuitBreakerReason ?? `Agent ${agentId} has an open provider-health circuit breaker.`,
  };
}

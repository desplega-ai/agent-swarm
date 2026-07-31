import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  canDispatchToAgent,
  isZeroTokenDeath,
  recordSessionForCircuitBreaker,
} from "../be/circuit-breaker";
import type { CreateSessionCostInput } from "../be/db";
import { closeDb, createAgent, createSessionCost, getAgentById, getDb, initDb } from "../be/db";

const TEST_DB_PATH = "./test-circuit-breaker.sqlite";

function zeroTokenSession(agentId: string, overrides: Partial<CreateSessionCostInput> = {}) {
  return createSessionCost({
    sessionId: crypto.randomUUID(),
    agentId,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 1200,
    numTurns: 2,
    model: "openrouter/deepseek/deepseek-v4-flash",
    isError: false,
    ...overrides,
  });
}

function realSession(agentId: string, overrides: Partial<CreateSessionCostInput> = {}) {
  return createSessionCost({
    sessionId: crypto.randomUUID(),
    agentId,
    totalCostUsd: 0.42,
    inputTokens: 175_000,
    outputTokens: 2_000,
    durationMs: 45_000,
    numTurns: 8,
    model: "openrouter/deepseek/deepseek-v4-flash",
    isError: false,
    ...overrides,
  });
}

describe("Provider-health circuit breaker", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {}
    closeDb();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {}
  });

  beforeEach(() => {
    getDb().run("DELETE FROM session_costs");
    getDb().run("DELETE FROM agents");
  });

  afterEach(() => {
    delete process.env.CIRCUIT_BREAKER_ZERO_TOKEN_THRESHOLD;
    delete process.env.CIRCUIT_BREAKER_ZERO_TOKEN_MAX_DURATION_MS;
    delete process.env.CIRCUIT_BREAKER_COOLDOWN_MIN;
  });

  describe("isZeroTokenDeath", () => {
    test("true for 0 tokens + fast duration (the incident signature)", () => {
      expect(isZeroTokenDeath({ inputTokens: 0, outputTokens: 0, durationMs: 1200 })).toBe(true);
    });

    test("false for a legitimately cheap real session (nonzero tokens)", () => {
      expect(isZeroTokenDeath({ inputTokens: 50, outputTokens: 10, durationMs: 900 })).toBe(false);
    });

    test("false for 0 tokens but a long duration (not the death signature)", () => {
      process.env.CIRCUIT_BREAKER_ZERO_TOKEN_MAX_DURATION_MS = "5000";
      expect(isZeroTokenDeath({ inputTokens: 0, outputTokens: 0, durationMs: 60_000 })).toBe(false);
    });
  });

  describe("recordSessionForCircuitBreaker — trip behavior", () => {
    test("trips after N (default 3) consecutive zero-token sessions", () => {
      const agent = createAgent({ name: "dead-key-agent", isLead: false, status: "idle" });

      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      expect(getAgentById(agent.id)?.circuitBreakerState).toBe("closed");

      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      expect(getAgentById(agent.id)?.circuitBreakerState).toBe("closed");

      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      const tripped = getAgentById(agent.id);
      expect(tripped?.circuitBreakerState).toBe("open");
      expect(tripped?.consecutiveZeroTokenSessions).toBe(3);
      expect(tripped?.circuitBreakerReason).toContain("check your provider API key");
      expect(tripped?.circuitBreakerTrippedAt).toBeTruthy();
    });

    test("does not trip on legitimately cheap-but-real sessions", () => {
      const agent = createAgent({ name: "cheap-real-agent", isLead: false, status: "idle" });

      for (let i = 0; i < 10; i++) {
        recordSessionForCircuitBreaker(realSession(agent.id, { inputTokens: 40, outputTokens: 5 }));
      }

      const result = getAgentById(agent.id);
      expect(result?.circuitBreakerState).toBe("closed");
      expect(result?.consecutiveZeroTokenSessions).toBe(0);
    });

    test("a real-token session resets the counter, so the streak must be consecutive", () => {
      const agent = createAgent({ name: "flappy-agent", isLead: false, status: "idle" });

      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      expect(getAgentById(agent.id)?.consecutiveZeroTokenSessions).toBe(2);

      recordSessionForCircuitBreaker(realSession(agent.id));
      expect(getAgentById(agent.id)?.consecutiveZeroTokenSessions).toBe(0);
      expect(getAgentById(agent.id)?.circuitBreakerState).toBe("closed");

      // Two more zero-token sessions after the reset must NOT trip a
      // threshold-3 breaker — the streak restarted.
      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      expect(getAgentById(agent.id)?.circuitBreakerState).toBe("closed");
    });

    test("threshold is env-tunable", () => {
      process.env.CIRCUIT_BREAKER_ZERO_TOKEN_THRESHOLD = "1";
      const agent = createAgent({ name: "hair-trigger-agent", isLead: false, status: "idle" });

      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      expect(getAgentById(agent.id)?.circuitBreakerState).toBe("open");
    });
  });

  describe("canDispatchToAgent — the dispatch chokepoint", () => {
    test("allows dispatch when closed", () => {
      const agent = createAgent({ name: "healthy-agent", isLead: false, status: "idle" });
      expect(canDispatchToAgent(agent.id)).toEqual({ allowed: true });
    });

    test("refuses dispatch while open and cooldown has not elapsed", () => {
      process.env.CIRCUIT_BREAKER_ZERO_TOKEN_THRESHOLD = "1";
      process.env.CIRCUIT_BREAKER_COOLDOWN_MIN = "30";
      const agent = createAgent({ name: "just-tripped-agent", isLead: false, status: "idle" });
      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));

      const decision = canDispatchToAgent(agent.id);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("check your provider API key");
    });

    test("half-open: exactly one caller wins the probe after cooldown elapses, even under concurrent attempts", () => {
      process.env.CIRCUIT_BREAKER_ZERO_TOKEN_THRESHOLD = "1";
      const agent = createAgent({ name: "cooldown-elapsed-agent", isLead: false, status: "idle" });
      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      expect(getAgentById(agent.id)?.circuitBreakerState).toBe("open");

      // Simulate the cooldown having elapsed by backdating the trip timestamp
      // directly, rather than sleeping in the test.
      getDb().run("UPDATE agents SET circuitBreakerTrippedAt = ? WHERE id = ?", [
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        agent.id,
      ]);

      // "Concurrent" callers — this closely simulates what would otherwise be
      // the Lead-escalation loop retrying dispatch repeatedly.
      const decisions = [
        canDispatchToAgent(agent.id),
        canDispatchToAgent(agent.id),
        canDispatchToAgent(agent.id),
      ];
      const allowedCount = decisions.filter((d) => d.allowed).length;
      expect(allowedCount).toBe(1); // Only the first probe wins; the rest are refused.
    });

    test("half-open probe outcome: a real-token session closes the breaker", () => {
      process.env.CIRCUIT_BREAKER_ZERO_TOKEN_THRESHOLD = "1";
      const agent = createAgent({ name: "recovers-agent", isLead: false, status: "idle" });
      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      getDb().run("UPDATE agents SET circuitBreakerTrippedAt = ? WHERE id = ?", [
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        agent.id,
      ]);

      expect(canDispatchToAgent(agent.id).allowed).toBe(true); // Probe granted.
      recordSessionForCircuitBreaker(realSession(agent.id)); // Provider is back — real tokens.

      const recovered = getAgentById(agent.id);
      expect(recovered?.circuitBreakerState).toBe("closed");
      expect(recovered?.consecutiveZeroTokenSessions).toBe(0);
      expect(canDispatchToAgent(agent.id)).toEqual({ allowed: true });
    });

    test("half-open probe outcome: another zero-token session re-trips and extends the cooldown", () => {
      process.env.CIRCUIT_BREAKER_ZERO_TOKEN_THRESHOLD = "1";
      const agent = createAgent({ name: "still-dead-agent", isLead: false, status: "idle" });
      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      getDb().run("UPDATE agents SET circuitBreakerTrippedAt = ? WHERE id = ?", [
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        agent.id,
      ]);

      expect(canDispatchToAgent(agent.id).allowed).toBe(true); // Probe granted.
      recordSessionForCircuitBreaker(zeroTokenSession(agent.id)); // Still dead.

      const stillOpen = getAgentById(agent.id);
      expect(stillOpen?.circuitBreakerState).toBe("open");
      // The cooldown was just reset to "now" by the re-trip — an immediate
      // follow-up dispatch attempt must be refused again, not endlessly probe.
      expect(canDispatchToAgent(agent.id).allowed).toBe(false);
    });

    /**
     * This is the actual incident mechanism: the per-task resume-generation
     * cap resets to zero on every Lead re-dispatch because a fresh task has
     * no inherited generation tag. `canDispatchToAgent` takes no task/lineage
     * argument at all — it is purely agent-scoped — so no amount of "Lead
     * decides to redispatch as a brand-new task" can bypass it. This test
     * simulates many independent "fresh lineage" dispatch attempts (as a
     * repeated escalation loop would produce) and confirms the breaker still
     * blocks every one of them until the cooldown elapses.
     */
    test("closes the generation-reset loop: repeated fresh-lineage dispatch attempts stay blocked", () => {
      process.env.CIRCUIT_BREAKER_ZERO_TOKEN_THRESHOLD = "3";
      process.env.CIRCUIT_BREAKER_COOLDOWN_MIN = "30";
      const agent = createAgent({ name: "escalation-loop-agent", isLead: false, status: "idle" });

      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      recordSessionForCircuitBreaker(zeroTokenSession(agent.id));
      expect(getAgentById(agent.id)?.circuitBreakerState).toBe("open");

      // Simulate 50 independent "fresh task tree" dispatch attempts, as a
      // Lead stuck in the escalation loop would generate — none should get
      // through, unlike the pre-fix behavior where each reset the budget.
      for (let i = 0; i < 50; i++) {
        expect(canDispatchToAgent(agent.id).allowed).toBe(false);
      }
    });
  });
});

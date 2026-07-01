import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  getAgentById,
  getIdleWorkersWithCapacity,
  incrementEmptyPollCount,
  initDb,
  MAX_EMPTY_POLLS,
  updateAgentCredentialState,
} from "../be/db";

/**
 * Phase 3 of the worker credential safe-loop plan
 * (thoughts/taras/plans/2026-05-06-worker-credential-safe-loop.md).
 *
 * Verifies that:
 *   - The migration applies cleanly to a fresh DB.
 *   - `waiting_for_credentials` is a valid status enum value.
 *   - `credentialMissing` round-trips through the helper + reader.
 *   - `getIdleWorkersWithCapacity` (the dispatcher's read site) routes
 *     around blocked workers — they're implicitly excluded by the
 *     `status = 'idle'` predicate.
 *   - `updateAgentCredentialState(ready=true)` transitions blocked → idle
 *     and clears the missing list.
 */

const TEST_DB_PATH = "./test-credential-status-routing.sqlite";

describe("Phase 3 — credential status routing", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // first run
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // best-effort
    }
  });

  test("migration applies on fresh DB — waiting_for_credentials enum + credentialMissing column exist", () => {
    // The fact that initDb succeeded above means migrations applied. Now
    // verify we can actually create an agent and persist the new state
    // without hitting the old CHECK constraint.
    const agent = createAgent({
      name: "routing-blocked",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 1,
    });

    const updated = updateAgentCredentialState(agent.id, false, [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("waiting_for_credentials");
    expect(updated!.credentialMissing).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);

    // Read-back through getAgentById should preserve the JSON parse.
    const refetched = getAgentById(agent.id);
    expect(refetched!.status).toBe("waiting_for_credentials");
    expect(refetched!.credentialMissing).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  });

  test("dispatcher routes around blocked workers — getIdleWorkersWithCapacity skips them", () => {
    // Sanity: clear DB state by creating fresh agents in this test.
    const ready = createAgent({
      name: "routing-ready",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 5,
    });
    const blocked = createAgent({
      name: "routing-blocked-2",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 5,
    });
    updateAgentCredentialState(blocked.id, false, ["DEVIN_API_KEY"]);

    const idleWorkers = getIdleWorkersWithCapacity();
    const idleIds = idleWorkers.map((a) => a.id);
    expect(idleIds).toContain(ready.id);
    expect(idleIds).not.toContain(blocked.id);
  });

  test("transition waiting → idle: dispatcher picks the agent up again", () => {
    const agent = createAgent({
      name: "routing-recovery",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 5,
    });

    // Park the agent.
    updateAgentCredentialState(agent.id, false, ["OPENAI_API_KEY"]);
    expect(getIdleWorkersWithCapacity().some((a) => a.id === agent.id)).toBe(false);

    // Simulate creds arriving.
    const recovered = updateAgentCredentialState(agent.id, true, null);
    expect(recovered!.status).toBe("idle");
    expect(recovered!.credentialMissing).toBeNull();

    // Dispatcher should now pick the agent up.
    expect(getIdleWorkersWithCapacity().some((a) => a.id === agent.id)).toBe(true);
  });

  test("ready=true clears any prior missing list even if missing[] is provided", () => {
    const agent = createAgent({
      name: "routing-clear",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 1,
    });

    updateAgentCredentialState(agent.id, false, ["X", "Y"]);
    // Even if a caller passes a non-null `missing` with `ready=true`, the helper
    // canonicalises to NULL so the dashboard doesn't render a stale list.
    const cleared = updateAgentCredentialState(agent.id, true, ["X"]);
    expect(cleared!.status).toBe("idle");
    expect(cleared!.credentialMissing).toBeNull();
  });

  test("credential-refresh deadlock: recovery clears accumulated emptyPollCount", () => {
    // Reproduces the wedge: a worker's credentials expire, its sessions exit and
    // emptyPollCount climbs to MAX_EMPTY_POLLS. The agent is parked on
    // `waiting_for_credentials`. When creds are refreshed the SAME parked session
    // continues past awaitCredentials and reaches the poll gate WITHOUT
    // re-registering (re-register is the only other path that resets the count).
    // Before the fix, emptyPollCount stayed >= MAX_EMPTY_POLLS, so the gate
    // blocked every new poll and the deadlock repeated forever.
    const agent = createAgent({
      name: "deadlock-recovery",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 1,
    });

    // Park the agent on waiting_for_credentials (creds expired).
    updateAgentCredentialState(agent.id, false, ["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(getAgentById(agent.id)!.status).toBe("waiting_for_credentials");

    // Sessions exit empty until the poll gate would trip.
    for (let i = 0; i < MAX_EMPTY_POLLS; i++) incrementEmptyPollCount(agent.id);
    expect(getAgentById(agent.id)!.emptyPollCount).toBe(MAX_EMPTY_POLLS);

    // Creds arrive: genuine waiting_for_credentials -> ready transition.
    const recovered = updateAgentCredentialState(agent.id, true, null);
    expect(recovered!.status).toBe("idle");
    // The gate is cleared, so the next poll is no longer blocked.
    expect(getAgentById(agent.id)!.emptyPollCount).toBe(0);
  });

  test("guard: routine ready=true report does NOT clobber an accumulated emptyPollCount", () => {
    // updateAgentCredentialState is called on EVERY ready:true credential report,
    // including routine post-task reports where the agent is already `idle`.
    // Such a report must not reset a legitimately accumulated empty-poll count,
    // or it would silently defeat the MAX_EMPTY_POLLS gate for idle agents.
    const agent = createAgent({
      name: "deadlock-guard",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 1,
    });

    // Agent is idle (never parked) and has accumulated empty polls.
    for (let i = 0; i < MAX_EMPTY_POLLS; i++) incrementEmptyPollCount(agent.id);
    expect(getAgentById(agent.id)!.emptyPollCount).toBe(MAX_EMPTY_POLLS);

    // A routine post-task ready:true report arrives while status is already idle.
    const updated = updateAgentCredentialState(agent.id, true, null);
    expect(updated!.status).toBe("idle");
    // The count must be preserved — no waiting_for_credentials -> ready transition.
    expect(getAgentById(agent.id)!.emptyPollCount).toBe(MAX_EMPTY_POLLS);
  });

  test("isLead agents are not eligible (predicate also filters isLead = 0)", () => {
    const lead = createAgent({
      name: "routing-lead",
      isLead: true,
      status: "idle",
      capabilities: [],
      maxTasks: 1,
    });

    expect(getIdleWorkersWithCapacity().some((a) => a.id === lead.id)).toBe(false);
  });
});

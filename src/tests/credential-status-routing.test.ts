import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  getAgentById,
  getIdleWorkersWithCapacity,
  initDb,
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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SwarmClient } from "../swarm/client.ts";
import { bootStack } from "../swarm/sandbox.ts";

/**
 * No-network tests for the v4 cancel fix (§1.1): every polling helper and the
 * boot path must FAIL FAST on an aborted signal instead of spinning until its
 * deadline. "No network" = nothing leaves the machine — the only address used
 * is an unreachable loopback port that refuses connections instantly.
 */
const DEAD_URL = "http://127.0.0.1:1";

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe("SwarmClient polling fails fast on abort (RC-2)", () => {
  const client = new SwarmClient(DEAD_URL, "test-key");

  test("waitForTask: pre-aborted signal throws before consuming the budget", async () => {
    const t0 = Date.now();
    await expect(
      client.waitForTask("t1", { timeoutMs: 60_000, signal: abortedSignal() }),
    ).rejects.toThrow("aborted");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("waitForTask: abort mid-poll breaks the loop within the poll interval", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const t0 = Date.now();
    await expect(
      client.waitForTask("t1", {
        timeoutMs: 60_000,
        intervalMs: 10,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("getStableSessionLogs: pre-aborted signal throws before the first fetch", async () => {
    const t0 = Date.now();
    await expect(client.getStableSessionLogs("t1", 30_000, abortedSignal())).rejects.toThrow(
      "aborted",
    );
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("waitForSessionCostRows: pre-aborted signal throws before the first fetch", async () => {
    const t0 = Date.now();
    await expect(
      client.waitForSessionCostRows("t1", { timeoutMs: 60_000, signal: abortedSignal() }),
    ).rejects.toThrow("aborted");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("polling helpers still resolve without a signal (additive contract)", async () => {
    // Dead API + zero budget: getStableSessionLogs swallows fetch errors and
    // returns [] at its deadline — the no-signal behavior is unchanged.
    const rows = await client.getStableSessionLogs("t1", 0);
    expect(rows).toEqual([]);
    const costs = await client.waitForSessionCostRows("t1", { timeoutMs: 0 });
    expect(costs).toEqual([]);
  });
});

describe("bootStack fails fast on abort (RC-3)", () => {
  let savedKey: string | undefined;

  beforeAll(() => {
    savedKey = process.env.E2B_API_KEY;
    process.env.E2B_API_KEY = process.env.E2B_API_KEY ?? "test-e2b-key";
  });

  afterAll(() => {
    if (savedKey === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = savedKey;
  });

  test("pre-aborted signal throws before any sandbox is created", async () => {
    const t0 = Date.now();
    const promise = bootStack({
      members: [
        {
          index: 0,
          role: "worker",
          spec: {},
          config: { id: "test-config", provider: "claude" },
          overridden: false,
        },
      ],
      swarmSlug: "evals-test",
      signal: abortedSignal(),
      log: () => {},
    });
    // throwIfAborted throws the signal's DOMException AbortError reason.
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

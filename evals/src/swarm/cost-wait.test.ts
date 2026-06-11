import { describe, expect, test } from "bun:test";
import { type SessionCostRow, SwarmClient } from "./client.ts";

/**
 * No-network tests for the v5 cost-wait contract (§6.2): stability return,
 * empty short-circuit, hard-budget cut, and abort threading. getSessionCosts
 * is scripted per call — nothing leaves the machine (the base URL is an
 * unreachable loopback port that is never contacted).
 */

function row(): SessionCostRow {
  return {
    totalCostUsd: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model: "test-model",
    costSource: "harness",
  };
}

const rows = (n: number): SessionCostRow[] => Array.from({ length: n }, row);

/** SwarmClient whose getSessionCosts plays a script: rows per call, or a throw. */
class ScriptedClient extends SwarmClient {
  calls = 0;
  constructor(private readonly script: (call: number) => SessionCostRow[] | Error) {
    super("http://127.0.0.1:1", "test-key");
  }
  override async getSessionCosts(_taskId: string): Promise<SessionCostRow[]> {
    const out = this.script(this.calls++);
    if (out instanceof Error) throw out;
    return out;
  }
}

describe("waitForSessionCostRows (v5 contract)", () => {
  test("rows grow then stabilize → returns the full set, never the first poll", async () => {
    // Poll 1: one row (a multi-iteration task mid-trickle). Polls 2+3: two rows.
    const client = new ScriptedClient((call) => rows(call === 0 ? 1 : 2));
    const result = await client.waitForSessionCostRows("t1", {
      intervalMs: 5,
      emptyTimeoutMs: 1_000,
      timeoutMs: 5_000,
    });
    expect(result.length).toBe(2); // the grown set, not the first non-empty poll
    expect(client.calls).toBe(3); // stability needs two consecutive equal non-empty polls
  });

  test("happy path: rows complete on the first poll → returns after one interval", async () => {
    const client = new ScriptedClient(() => rows(3));
    const t0 = Date.now();
    const result = await client.waitForSessionCostRows("t1", {
      intervalMs: 10,
      emptyTimeoutMs: 1_000,
      timeoutMs: 5_000,
    });
    expect(result.length).toBe(3);
    expect(client.calls).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("a failed poll keeps the previous snapshot (stability not reset)", async () => {
    const client = new ScriptedClient((call) => (call === 1 ? new Error("api blip") : rows(2)));
    const result = await client.waitForSessionCostRows("t1", {
      intervalMs: 5,
      emptyTimeoutMs: 1_000,
      timeoutMs: 5_000,
    });
    // Poll 1 (2 rows) + failed poll 2 + poll 3 (2 rows) = stable across the blip.
    expect(result.length).toBe(2);
    expect(client.calls).toBe(3);
  });

  test("permanently empty → returns [] at emptyTimeoutMs, well before timeoutMs", async () => {
    const client = new ScriptedClient(() => []);
    const t0 = Date.now();
    const result = await client.waitForSessionCostRows("t1", {
      intervalMs: 10,
      emptyTimeoutMs: 60,
      timeoutMs: 10_000,
    });
    const elapsed = Date.now() - t0;
    expect(result).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(2_000); // nowhere near the 10s hard budget
  });

  test("rows appearing before emptyTimeoutMs disable the empty short-circuit", async () => {
    const client = new ScriptedClient((call) => (call === 0 ? [] : rows(1)));
    const result = await client.waitForSessionCostRows("t1", {
      intervalMs: 5,
      emptyTimeoutMs: 5_000,
      timeoutMs: 5_000,
    });
    expect(result.length).toBe(1); // stabilized rows, not the empty cut's []
    expect(client.calls).toBe(3); // [], [row], [row]
  });

  test("never-stable growth → returns the last snapshot at timeoutMs", async () => {
    const client = new ScriptedClient((call) => rows(call + 1)); // grows every poll
    const t0 = Date.now();
    const result = await client.waitForSessionCostRows("t1", {
      intervalMs: 5,
      emptyTimeoutMs: 10_000,
      timeoutMs: 60,
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60);
    expect(result.length).toBe(client.calls); // exactly the last successful snapshot
    expect(result.length).toBeGreaterThan(1);
  });

  test('abort mid-wait → throws "aborted" without consuming the budget', async () => {
    const client = new ScriptedClient(() => []);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);
    const t0 = Date.now();
    await expect(
      client.waitForSessionCostRows("t1", {
        intervalMs: 5,
        emptyTimeoutMs: 60_000,
        timeoutMs: 60_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("pre-aborted signal throws before the first fetch", async () => {
    const client = new ScriptedClient(() => rows(1));
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.waitForSessionCostRows("t1", { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(client.calls).toBe(0);
  });

  test("timeoutMs 0 budget-cuts to the first snapshot immediately", async () => {
    // The default 25s budget would instead poll for stability.
    const client = new ScriptedClient(() => rows(2));
    const t0 = Date.now();
    const result = await client.waitForSessionCostRows("t1", { timeoutMs: 0 });
    expect(result.length).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

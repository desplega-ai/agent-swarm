import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetAutoConnectAttemptsForTests,
  autoConnectRunKey,
  currentAttempt,
  settledOutcome,
  startAttempt,
  subscribeSettled,
} from "./auto-connect-attempts";

afterEach(() => _resetAutoConnectAttemptsForTests());

describe("auto-connect attempts", () => {
  test("the run key names the swarm, the endpoint, and the dashboard user", () => {
    expect(autoConnectRunKey("https://swarm", null, "u1")).toBeNull();
    expect(autoConnectRunKey("https://swarm", "https://fs", "u1")).not.toBe(
      autoConnectRunKey("https://swarm", "https://fs", "u2"),
    );
  });

  test("the latest attempt's outcome is recorded and announced", async () => {
    let calls = 0;
    const stop = subscribeSettled(() => calls++);
    const attempt = startAttempt("k", async () => ({ kind: "unsupported" }));
    expect(currentAttempt("k")).toBe(attempt);
    expect(settledOutcome("k")).toBeNull();
    await attempt;
    await Promise.resolve();
    expect(settledOutcome("k")).toEqual({ kind: "unsupported" });
    expect(settledOutcome("other")).toBeNull();
    expect(calls).toBeGreaterThan(0);
    stop();
  });

  test("a retry clears the old outcome, and a superseded attempt never records", async () => {
    let resolveOld: (value: { kind: "connected" }) => void = () => {};
    const old = startAttempt(
      "k",
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const fresh = startAttempt("k", async () => ({ kind: "failed", message: "no" }));
    await fresh;
    await Promise.resolve();
    resolveOld({ kind: "connected" });
    await old;
    await Promise.resolve();
    expect(settledOutcome("k")).toEqual({ kind: "failed", message: "no" });
  });
});

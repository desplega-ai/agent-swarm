/**
 * Coverage for the delivery loop's orphan-recovery throttle.
 *
 * The throttle's `boot()` is the runner's real boot recovery and `tick()` is
 * the call the delivery loop makes. The fake API counts requests, so the test
 * observes what the worker actually sends: one recovery at boot, none on the
 * first tick, and another after the interval.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { recoverOrphanedInProgressTasks } from "../commands/runner";
import { createOrphanRecoveryThrottle } from "../utils/orphan-recovery-throttle";
import { listenOnFreePort } from "./test-net";

const INTERVAL_MS = 60_000;
const AGENT_ID = "3f0b7a52-8c1d-4e6a-9b27-5d4c1e8a7f10";

let server: Server;
let apiUrl: string;
let recoveryRequests = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/active-sessions/recover-orphaned-tasks") {
      recoveryRequests++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ recovered: 1 }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  apiUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  recoveryRequests = 0;
});

function makeThrottle(clock: { now: number }) {
  return createOrphanRecoveryThrottle({
    recover: () =>
      recoverOrphanedInProgressTasks({ apiUrl, apiKey: "test-key", agentId: AGENT_ID }),
    intervalMs: INTERVAL_MS,
    now: () => clock.now,
  });
}

describe("orphan recovery throttle", () => {
  test("the boot recovery stops the first delivery tick from repeating it", async () => {
    const clock = { now: 1_000_000 };
    const throttle = makeThrottle(clock);

    expect(await throttle.boot()).toBe(1);
    expect(recoveryRequests).toBe(1);

    // The first tick of the delivery loop, one second after boot. With the
    // pre-fix seed of 0 this fired a second identical request.
    clock.now += 1_000;
    expect(await throttle.tick()).toBe(0);
    expect(recoveryRequests).toBe(1);
  });

  test("recovery returns once the interval has elapsed since the last one", async () => {
    const clock = { now: 1_000_000 };
    const throttle = makeThrottle(clock);
    await throttle.boot();

    clock.now += INTERVAL_MS;
    expect(await throttle.tick()).toBe(0);
    expect(recoveryRequests).toBe(1);

    clock.now += 1;
    expect(await throttle.tick()).toBe(1);
    expect(recoveryRequests).toBe(2);

    // The interval restarts from that recovery, not from boot.
    clock.now += INTERVAL_MS;
    expect(await throttle.tick()).toBe(0);
    expect(recoveryRequests).toBe(2);
  });
});

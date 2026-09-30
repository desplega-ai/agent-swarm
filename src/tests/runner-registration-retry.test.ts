import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  AgentRegistrationHttpError,
  isRetryableRegistrationError,
  registerAgent,
  registerAgentWithRetry,
} from "../commands/runner";
import { getFreePort, listenOnFreePort } from "./test-net";

/**
 * After the 2026-09-30 deploy every worker got `500 {"error":"database is
 * locked"}` from `POST /api/agents` for ~4 minutes and exited on the first
 * failure. Boot registration now retries transient failures inside a budget
 * and still exits on a 4xx. These tests drive the real `registerAgent` against
 * a fake API, with an injected clock so no real time passes.
 */

const AGENT_ID = "3f0b7a52-8c1d-4e6a-9b27-5d4c1e8a7f10";

let server: Server;
let baseUrl: string;
/** Responses served in order; the last one repeats. */
let script: Array<{ status: number; body: unknown }>;
let calls: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/agents") {
      const next = script[Math.min(calls, script.length - 1)] ?? { status: 200, body: {} };
      calls++;
      res.writeHead(next.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(next.body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  const port = await listenOnFreePort(server);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  script = [];
  calls = 0;
});

function fakeClock() {
  let t = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
  };
}

function register(apiUrl = baseUrl) {
  return registerAgent({
    apiUrl,
    apiKey: "example-test-swarm-key",
    agentId: AGENT_ID,
    name: "retry-test-worker",
    isLead: false,
    harnessProvider: "claude",
  });
}

describe("boot registration retry", () => {
  test("rides out 'database is locked' 500s, then registers", async () => {
    script = [
      { status: 500, body: { error: "database is locked" } },
      { status: 500, body: { error: "database is locked" } },
      { status: 503, body: { error: "unavailable" } },
      { status: 200, body: { enabledCapabilities: ["core"] } },
    ];
    const clock = fakeClock();
    const reg = await registerAgentWithRetry(() => register(), { label: "test", ...clock });
    expect(reg.serverCapabilities).toEqual(["core"]);
    expect(calls).toBe(4);
    expect(clock.waits).toHaveLength(3);
    // Backoff grows (2s, 4s, 8s nominal, +/-20% jitter).
    expect(clock.waits[0]).toBeGreaterThanOrEqual(1_600);
    expect(clock.waits[2]).toBeGreaterThanOrEqual(6_400);
  });

  test("exits on the first 4xx without retrying", async () => {
    script = [{ status: 401, body: { error: "unauthorized" } }];
    const clock = fakeClock();
    const err = await registerAgentWithRetry(() => register(), { label: "test", ...clock }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentRegistrationHttpError);
    expect((err as AgentRegistrationHttpError).status).toBe(401);
    expect(calls).toBe(1);
    expect(clock.waits).toHaveLength(0);
  });

  test("gives up once the budget is spent", async () => {
    script = [{ status: 500, body: { error: "database is locked" } }];
    const clock = fakeClock();
    const err = await registerAgentWithRetry(() => register(), {
      label: "test",
      budgetMs: 60_000,
      ...clock,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRegistrationHttpError);
    expect(clock.now()).toBeLessThanOrEqual(60_000);
    // 2 + 4 + 8 + 16 + 30 nominal fits only partly in 60s; more than one try, bounded.
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(10);
  });

  test("retries a connection error", async () => {
    const deadPort = await getFreePort();
    const clock = fakeClock();
    let attempts = 0;
    const reg = await registerAgentWithRetry(
      () => {
        attempts++;
        return attempts < 3 ? register(`http://127.0.0.1:${deadPort}`) : register();
      },
      { label: "test", ...clock },
    );
    expect(reg).toEqual({});
    expect(attempts).toBe(3);
    expect(clock.waits).toHaveLength(2);
  });

  test("classifies statuses", () => {
    const http = (status: number, body = "{}") => new AgentRegistrationHttpError(status, body);
    expect(isRetryableRegistrationError(http(500))).toBe(true);
    expect(isRetryableRegistrationError(http(502))).toBe(true);
    expect(isRetryableRegistrationError(http(429))).toBe(true);
    expect(isRetryableRegistrationError(http(400))).toBe(false);
    expect(isRetryableRegistrationError(http(403))).toBe(false);
    expect(isRetryableRegistrationError(http(409, '{"error":"database is locked"}'))).toBe(true);
    expect(isRetryableRegistrationError(new TypeError("fetch failed"))).toBe(true);
  });
});

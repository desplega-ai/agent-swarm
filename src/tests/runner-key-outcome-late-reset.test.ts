/**
 * A success reset that times out on the worker can still finish on the API
 * later. These tests run the production reporting code against the real
 * api-keys handler and a real DB, delay the success handler, and check the
 * state AFTER the late handler finishes: it must not clear auth failures
 * recorded after the fence the task read with its key draw, from this runner
 * or any other.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, getKeyStatuses, getKv, initDb } from "../be/db";
import {
  type ApiConfig,
  checkCompletedProcesses,
  type RunnerState,
  type RunningTask,
  reportKeyCompletionOutcome,
} from "../commands/runner";
import { handleApiKeys } from "../http/api-keys";
import type { ProviderResult } from "../providers/types";
import { listenOnFreePort } from "./test-net";

const TEST_DB = `./test-runner-key-outcome-late-reset-${Date.now()}.sqlite`;
const authFailure =
  "[auth-error] Codex authentication failed — check OPENAI_API_KEY or ChatGPT login. Original error: workspace routing discovery unauthorized (401)";

let api: Server;
let proxy: Server;
let apiUrl = "";
let clearDelayMs = 0;
/** Credential reports in the order the API FINISHED handling them. */
const handled: string[] = [];
/** Success resets still in flight on the API side. */
let pendingClears: Promise<void>[] = [];

const status = async (keySuffix: string) =>
  (await getKeyStatuses("CODEX_OAUTH")).find((s) => s.keySuffix === keySuffix)!;
/** The `authFailureFence` a runner reads with its key draw, before the task starts. */
const drawFence = async () => {
  const resp = await fetch(`${apiUrl}/api/keys/available?keyType=CODEX_OAUTH&totalKeys=1`);
  return ((await resp.json()) as { authFailureFence: number }).authFailureFence;
};

beforeAll(async () => {
  process.env.DB_PATH = TEST_DB;
  initDb(TEST_DB);
  // The real api-keys handler on a real DB.
  api = createHttpServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const pathSegments = url.pathname.split("/").filter(Boolean);
    if (await handleApiKeys(req, res, pathSegments, url.searchParams)) {
      if (url.pathname === "/api/keys/clear-rate-limit") handled.push("clear");
      if (url.pathname === "/api/keys/report-auth-failure") handled.push("auth-failure");
      return;
    }
    // Every other worker call (finish, active sessions, ...) is out of scope.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const apiPort = await listenOnFreePort(api);
  // A proxy in front of it. It reads the whole request, then forwards it; a
  // success reset is forwarded late. The worker's abort never cancels it.
  proxy = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const forward = async () => {
      if (req.url === "/api/keys/clear-rate-limit") await Bun.sleep(clearDelayMs);
      const upstream = await fetch(`http://127.0.0.1:${apiPort}${req.url}`, {
        method: req.method,
        headers: { "Content-Type": "application/json" },
        body: req.method === "GET" ? undefined : Buffer.concat(chunks),
      });
      const text = await upstream.text();
      if (!res.destroyed) {
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(text);
      }
    };
    const done = forward();
    if (req.url === "/api/keys/clear-rate-limit") pendingClears.push(done);
    await done;
  });
  const proxyPort = await listenOnFreePort(proxy);
  apiUrl = `http://127.0.0.1:${proxyPort}`;
});

afterAll(async () => {
  await Promise.all(pendingClears);
  for (const s of [proxy, api]) await new Promise<void>((resolve) => s.close(() => resolve()));
  closeDb();
  await unlink(TEST_DB).catch(() => {});
  await unlink(`${TEST_DB}-wal`).catch(() => {});
  await unlink(`${TEST_DB}-shm`).catch(() => {});
});

beforeEach(() => {
  handled.length = 0;
  pendingClears = [];
  clearDelayMs = 0;
});

describe("late success reset", () => {
  test("a timed-out success reset that finishes late keeps the later auth bench", async () => {
    const credential = { keyType: "CODEX_OAUTH", keySuffix: "late1", keyIndex: 0 };
    const authFence = await drawFence();
    const report = (i: number, exitCode: number, failureReason?: string, timeoutMs?: number) =>
      reportKeyCompletionOutcome({
        apiUrl,
        apiKey: "test-key",
        credential: { ...credential, authFence },
        taskId: `00000000-0000-4000-8000-00000000010${i}`,
        exitCode,
        failureReason,
        timeoutMs,
      });

    clearDelayMs = 400;
    const started = Date.now();
    await report(0, 0, undefined, 100);
    expect(Date.now() - started).toBeLessThan(400);
    await report(1, 1, authFailure);
    await report(2, 1, authFailure);

    let row = await status("late1");
    expect(row.consecutiveAuthFailures).toBe(2);
    expect(row.status).toBe("rate_limited");

    // Let the late success handler finish on the API, then check again.
    await Promise.all(pendingClears);
    expect(handled).toEqual(["auth-failure", "auth-failure", "clear"]);
    row = await status("late1");
    expect(row.consecutiveAuthFailures).toBe(2);
    expect(row.status).toBe("rate_limited");
    expect(await getKv("codex-auth-watch", "bench:late1")).not.toBeNull();
  });

  test("two runners: A's late success cannot clear B's later failures, whatever A's clock says", async () => {
    const credential = { keyType: "CODEX_OAUTH", keySuffix: "late3", keyIndex: 2 };
    const report = (
      runner: string,
      authFence: number,
      exitCode: number,
      failureReason?: string,
      timeoutMs?: number,
    ) =>
      reportKeyCompletionOutcome({
        apiUrl,
        apiKey: "test-key",
        credential: { ...credential, authFence },
        taskId: crypto.randomUUID(),
        exitCode,
        failureReason,
        timeoutMs,
      }).then(() => runner);

    // Runner A draws the key first; its clock runs an hour ahead. Nothing it sends
    // carries a clock value, so the skew cannot move its success after B's failures.
    const fenceA = await drawFence();
    const realNow = Date.now;
    Date.now = () => realNow() + 3_600_000;
    clearDelayMs = 400;
    try {
      await report("A", fenceA, 0, undefined, 100);
    } finally {
      Date.now = realNow;
    }
    // Runner B draws after A and fails twice on the same login.
    const fenceB = await drawFence();
    await report("B", fenceB, 1, authFailure);
    await report("B", fenceB, 1, authFailure);

    await Promise.all(pendingClears);
    expect(handled).toEqual(["auth-failure", "auth-failure", "clear"]);
    const row = await status("late3");
    expect(row.consecutiveAuthFailures).toBe(2);
    expect(row.status).toBe("rate_limited");
    expect(await getKv("codex-auth-watch", "bench:late3")).not.toBeNull();
  });

  test("checkCompletedProcesses lands each outcome before it handles the next completion", async () => {
    const credentialInfo = {
      keyType: "CODEX_OAUTH",
      keySuffix: "late2",
      keyIndex: 1,
      authFence: await drawFence(),
    };
    const running = (i: number, result: ProviderResult) =>
      ({
        taskId: `00000000-0000-4000-8000-00000000020${i}`,
        startTime: new Date(),
        result,
        credentialInfo,
        harnessProvider: "codex",
        hasLocalEnvironment: false,
      }) as unknown as RunningTask;
    const state = {
      activeTasks: new Map<string, RunningTask>(),
      maxConcurrent: 3,
      startedAt: Date.now(),
      tasksProcessed: 0,
      harnessProvider: "codex",
      codexCreditsExhaustedCooldownMs: 7_200_000,
      modelWindowBlocks: new Map(),
    } as RunnerState;
    const tasks = [
      running(0, { exitCode: 0, isError: false } as ProviderResult),
      running(1, { exitCode: 1, isError: true, failureReason: authFailure } as ProviderResult),
      running(2, { exitCode: 1, isError: true, failureReason: authFailure } as ProviderResult),
    ];
    for (const t of tasks) state.activeTasks.set(t.taskId, t);
    const apiConfig: ApiConfig = { apiUrl, apiKey: "test-key", agentId: crypto.randomUUID() };

    clearDelayMs = 200;
    await checkCompletedProcesses(state, "worker", apiConfig);

    // Awaited in order: the slow success reset finished before the failures.
    expect(handled).toEqual(["clear", "auth-failure", "auth-failure"]);
    expect(state.activeTasks.size).toBe(0);
    const row = await status("late2");
    expect(row.consecutiveAuthFailures).toBe(2);
    expect(row.status).toBe("rate_limited");
  });
});

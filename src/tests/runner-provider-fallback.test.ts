// The runner side of provider-error fallbacks: a profile task that ends on a
// provider error asks the API to supersede it with `provider_fallback`
// instead of finishing it; anything else finishes as before.

import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  type ApiConfig,
  checkCompletedProcesses,
  type RunnerState,
  type RunningTask,
  requestProviderFallback,
} from "../commands/runner";
import type { ProviderResult } from "../providers/types";
import { listenOnFreePort } from "./test-net";

let server: Server;
let config: ApiConfig;
let requests: Array<{ path: string; body: Record<string, unknown> }>;
let supersedeStatus: number;
let supersedeBody: Record<string, unknown>;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url?.split("?")[0]?.split("/").at(-1) ?? "";
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push({ path, body: text ? JSON.parse(text) : {} });
    if (path === "supersede") {
      res
        .writeHead(supersedeStatus, { "Content-Type": "application/json" })
        .end(JSON.stringify(supersedeBody));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  config = {
    apiUrl: `http://127.0.0.1:${await listenOnFreePort(server)}`,
    apiKey: "provider-fallback-test-credential",
    agentId: crypto.randomUUID(),
  };
});

beforeEach(() => {
  requests = [];
  supersedeStatus = 200;
  supersedeBody = { success: true, kind: "resumed", resumeTaskId: crypto.randomUUID() };
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function completedState(taskId: string, result: Partial<ProviderResult>, resolvedProfile?: string) {
  const state: RunnerState = {
    activeTasks: new Map([
      [
        taskId,
        {
          taskId,
          result: { isError: true, ...result } as ProviderResult,
          triggerType: "task_assigned",
          startTime: new Date(),
          harnessProvider: "claude",
          hasLocalEnvironment: false,
          model: "claude-opus-5-5",
          resolvedProfile,
        } as RunningTask,
      ],
    ]),
    maxConcurrent: 1,
    startedAt: Date.now(),
    tasksProcessed: 0,
    harnessProvider: "claude",
    codexCreditsExhaustedCooldownMs: 0,
    modelWindowBlocks: new Map(),
  };
  return state;
}

const paths = () => requests.map((r) => r.path);

test("a rate-limited profile task is superseded with provider_fallback, not finished", async () => {
  const taskId = crypto.randomUUID();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await checkCompletedProcesses(
      completedState(
        taskId,
        { exitCode: 1, failureReason: "Rate limit hit", rateLimitResetAt: "2099-01-01T00:00:00Z" },
        "claude-glm",
      ),
      "worker",
      config,
    );
  } finally {
    log.mockRestore();
  }
  const supersede = requests.find((r) => r.path === "supersede");
  expect(supersede?.body).toEqual({ reason: "provider_fallback", errorClass: "rate_limit" });
  expect(paths()).not.toContain("finish");
});

test("no fallback left: the task fails, led by the API's chain message", async () => {
  supersedeBody = {
    success: true,
    kind: "noFallback",
    resumeTaskId: null,
    failureReason: "overloaded on claude-c; no fallback left (tried: claude-a → claude-c)",
  };
  const taskId = crypto.randomUUID();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await checkCompletedProcesses(
      completedState(
        taskId,
        { exitCode: 1, failureReason: "Server error (API overloaded): Service unavailable" },
        "claude-c",
      ),
      "worker",
      config,
    );
  } finally {
    log.mockRestore();
  }
  const finish = requests.find((r) => r.path === "finish");
  expect(finish?.body.status).toBe("failed");
  expect(finish?.body.failureReason).toBe(
    "overloaded on claude-c; no fallback left (tried: claude-a → claude-c)\n\nServer error (API overloaded): Service unavailable",
  );
});

test("controls: no profile, a task failure, or an old API all finish as before", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    // No profile at claim: no supersede call at all.
    await checkCompletedProcesses(
      completedState(crypto.randomUUID(), { exitCode: 1, failureReason: "Rate limit hit" }),
      "worker",
      config,
    );
    expect(paths()).not.toContain("supersede");
    expect(paths()).toContain("finish");

    // A task failure on a profile task: no supersede call.
    requests = [];
    await checkCompletedProcesses(
      completedState(
        crypto.randomUUID(),
        { exitCode: 1, failureReason: "Error during execution" },
        "claude-a",
      ),
      "worker",
      config,
    );
    expect(paths()).not.toContain("supersede");
    expect(requests.find((r) => r.path === "finish")?.body.failureReason).toBe(
      "Error during execution",
    );

    // An API without the reason rejects it (400): the task fails with its own text.
    requests = [];
    supersedeStatus = 400;
    supersedeBody = { error: "Invalid enum value" };
    await checkCompletedProcesses(
      completedState(
        crypto.randomUUID(),
        { exitCode: 1, failureReason: "Rate limit hit" },
        "claude-a",
      ),
      "worker",
      config,
    );
    expect(paths()).toContain("supersede");
    expect(requests.find((r) => r.path === "finish")?.body.failureReason).toBe("Rate limit hit");
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
});

test("requestProviderFallback sends nothing without a profile or a class", async () => {
  expect(
    await requestProviderFallback(config, "worker", crypto.randomUUID(), {
      errorClass: "pool_empty",
    }),
  ).toEqual({ superseded: false });
  expect(
    await requestProviderFallback(config, "worker", crypto.randomUUID(), {
      resolvedProfile: "claude-a",
      errorClass: null,
    }),
  ).toEqual({ superseded: false });
  expect(requests).toEqual([]);
});

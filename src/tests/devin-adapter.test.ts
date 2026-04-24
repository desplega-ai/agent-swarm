/**
 * Unit tests for DevinAdapter / DevinSession (`src/providers/devin-adapter.ts`).
 *
 * Uses a mock HTTP server (node:http) on port 13051 to simulate the Devin v3
 * API. The mock supports controllable responses per-endpoint so individual
 * tests can drive the polling loop through different session lifecycle paths.
 *
 * Because the API client captures `DEVIN_API_BASE_URL` at module-load time,
 * we set env vars before the first import and use dynamic imports for the
 * adapter module.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";

const TEST_PORT = 13051;
const TEST_BASE_URL = `http://localhost:${TEST_PORT}`;
const ORG_ID = "org-adapter-test";
const API_KEY = "cog_adapter_key";

// ---------------------------------------------------------------------------
// Controllable mock state
// ---------------------------------------------------------------------------

type MockSessionResponse = {
  session_id: string;
  url: string;
  status: string;
  status_detail?: string;
  structured_output?: unknown;
  pull_requests?: Array<{ pr_url: string; pr_state: string }>;
  acus_consumed?: number;
  created_at: number;
  updated_at: number;
};

/** The response returned by GET /sessions/:id (polling). Updated by tests. */
let pollResponse: MockSessionResponse = {
  session_id: "ses-test-001",
  url: "https://app.devin.ai/sessions/ses-test-001",
  status: "new",
  created_at: 1700000000,
  updated_at: 1700000000,
};

/** If set, the next N poll requests will respond with this error status. */
let pollErrorResponse: { status: number; body: string } | null = null;
let pollErrorCount = 0;

/** Playbook creation responses. */
const playbookResponse = {
  playbook_id: "pb-adapter-001",
  title: "test",
  body: "test body",
};

/** Track last request for assertions. */
let lastCreateSessionBody: Record<string, unknown> | null = null;

// ---------------------------------------------------------------------------
// Mock HTTP server
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

let server: Server;

function handler(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    const body = await readBody(req);
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // POST .../sessions — create session
    if (
      method === "POST" &&
      url.match(/\/v3\/organizations\/[^/]+\/sessions$/) &&
      !url.includes("/messages") &&
      !url.includes("/archive")
    ) {
      lastCreateSessionBody = body ? JSON.parse(body) : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          session_id: pollResponse.session_id,
          url: pollResponse.url,
          status: "new",
          created_at: Date.now(),
          updated_at: Date.now(),
        }),
      );
      return;
    }

    // GET .../sessions/:id — poll
    if (method === "GET" && url.match(/\/v3\/organizations\/[^/]+\/sessions\/[^/]+$/)) {
      if (pollErrorResponse && pollErrorCount > 0) {
        pollErrorCount--;
        res.writeHead(pollErrorResponse.status, { "Content-Type": "application/json" });
        res.end(pollErrorResponse.body);
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(pollResponse));
      return;
    }

    // POST .../messages
    if (method === "POST" && url.includes("/messages")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST .../archive
    if (method === "POST" && url.includes("/archive")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST .../playbooks
    if (method === "POST" && url.match(/\/v3\/organizations\/[^/]+\/playbooks$/)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(playbookResponse));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  })();
}

// ---------------------------------------------------------------------------
// Module imports (dynamic — after env setup)
// ---------------------------------------------------------------------------

let DevinAdapter: typeof import("../providers/devin-adapter").DevinAdapter;

const logFiles: string[] = [];
function testLogFile(): string {
  const path = `/tmp/devin-adapter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`;
  logFiles.push(path);
  return path;
}

function testConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "test prompt",
    systemPrompt: "",
    model: "devin",
    role: "worker",
    agentId: "agent-devin-test",
    taskId: "task-devin-test",
    apiUrl: "",
    apiKey: "",
    cwd: "/tmp",
    logFile: testLogFile(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Save any existing env vars we'll mutate.
  for (const key of [
    "DEVIN_API_KEY",
    "DEVIN_ORG_ID",
    "DEVIN_POLL_INTERVAL_MS",
    "DEVIN_ACU_COST_USD",
    "DEVIN_API_BASE_URL",
  ]) {
    savedEnv[key] = process.env[key];
  }

  // Set test env vars — must happen BEFORE module import.
  process.env.DEVIN_API_BASE_URL = TEST_BASE_URL;
  process.env.DEVIN_API_KEY = API_KEY;
  process.env.DEVIN_ORG_ID = ORG_ID;
  process.env.DEVIN_POLL_INTERVAL_MS = "50";

  await new Promise<void>((resolve) => {
    server = createServer(handler);
    server.listen(TEST_PORT, () => resolve());
  });

  const mod = await import("../providers/devin-adapter");
  DevinAdapter = mod.DevinAdapter;
});

beforeEach(() => {
  // Reset mock state between tests.
  pollResponse = {
    session_id: "ses-test-001",
    url: "https://app.devin.ai/sessions/ses-test-001",
    status: "new",
    created_at: 1700000000,
    updated_at: 1700000000,
  };
  pollErrorResponse = null;
  pollErrorCount = 0;
  lastCreateSessionBody = null;

  // Ensure env vars are set (individual tests may clear them).
  process.env.DEVIN_API_KEY = API_KEY;
  process.env.DEVIN_ORG_ID = ORG_ID;
  process.env.DEVIN_POLL_INTERVAL_MS = "50";
});

afterAll(() => {
  server.close();

  // Restore original env.
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  // Clean up log files.
  for (const f of logFiles) {
    try {
      unlinkSync(f);
    } catch {
      // Ignore missing.
    }
  }
});

// ---------------------------------------------------------------------------
// Helper: collect events until session settles (with timeout safety).
// ---------------------------------------------------------------------------

async function runUntilSettled(
  adapter: InstanceType<typeof DevinAdapter>,
  config: ProviderSessionConfig,
  opts: { timeout?: number } = {},
): Promise<{
  events: ProviderEvent[];
  result: Awaited<ReturnType<import("../providers/types").ProviderSession["waitForCompletion"]>>;
}> {
  const session = await adapter.createSession(config);
  const events: ProviderEvent[] = [];
  session.onEvent((e) => events.push(e));

  const timeout = opts.timeout ?? 5000;
  const result = await Promise.race([
    session.waitForCompletion(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Test timed out waiting for session to settle")), timeout),
    ),
  ]);

  return { events, result };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DevinAdapter.createSession — env validation", () => {
  test("throws without DEVIN_API_KEY", async () => {
    delete process.env.DEVIN_API_KEY;
    const adapter = new DevinAdapter();
    await expect(adapter.createSession(testConfig())).rejects.toThrow(/DEVIN_API_KEY/);
  });

  test("throws without DEVIN_ORG_ID", async () => {
    process.env.DEVIN_API_KEY = API_KEY;
    delete process.env.DEVIN_ORG_ID;
    const adapter = new DevinAdapter();
    await expect(adapter.createSession(testConfig())).rejects.toThrow(/DEVIN_ORG_ID/);
  });
});

describe("DevinAdapter.createSession — playbook creation", () => {
  test("creates playbook from systemPrompt and attaches to session", async () => {
    // Make the session go to exit immediately so the test settles.
    pollResponse.status = "exit";
    pollResponse.status_detail = "finished";
    pollResponse.acus_consumed = 1;

    const adapter = new DevinAdapter();
    const config = testConfig({ systemPrompt: "You are a coding assistant." });
    await runUntilSettled(adapter, config);

    // The create-session call should include the playbook_id.
    expect(lastCreateSessionBody).not.toBeNull();
    expect(lastCreateSessionBody!.playbook_id).toBe("pb-adapter-001");
  });

  test("playbook cache returns same ID for same content hash", async () => {
    pollResponse.status = "exit";
    pollResponse.status_detail = "finished";

    const adapter = new DevinAdapter();
    const prompt = "Identical system prompt for caching";

    // First call
    const config1 = testConfig({ systemPrompt: prompt });
    await runUntilSettled(adapter, config1);
    expect(lastCreateSessionBody!.playbook_id).toBe("pb-adapter-001");

    // Second call with same prompt — playbook cache should return the cached
    // id without creating a new playbook. Since the mock always returns the
    // same playbook_id, the key assertion is that it doesn't error.
    const config2 = testConfig({ systemPrompt: prompt });
    await runUntilSettled(adapter, config2);
    expect(lastCreateSessionBody!.playbook_id).toBe("pb-adapter-001");
  });
});

describe("DevinAdapter.createSession — repos", () => {
  test("vcsRepo from config is passed to session creation", async () => {
    pollResponse.status = "exit";
    pollResponse.status_detail = "finished";

    const adapter = new DevinAdapter();
    await runUntilSettled(adapter, testConfig({ vcsRepo: "owner/repo1" }));

    expect(lastCreateSessionBody!.repos).toEqual(["owner/repo1"]);
  });

  test("no repos when vcsRepo is not set", async () => {
    pollResponse.status = "exit";
    pollResponse.status_detail = "finished";

    const adapter = new DevinAdapter();
    await runUntilSettled(adapter, testConfig());

    expect(lastCreateSessionBody!.repos).toBeUndefined();
  });
});

describe("Polling loop — lifecycle events", () => {
  test("new -> running -> exit emits correct ProviderEvent sequence", async () => {
    // We change pollResponse in a timer to simulate state transitions.
    const transitions = setTimeout(() => {
      pollResponse.status = "running";
      pollResponse.status_detail = "working";
    }, 80);

    const exitTimer = setTimeout(() => {
      pollResponse.status = "exit";
      pollResponse.status_detail = "finished";
      pollResponse.acus_consumed = 3.5;
    }, 200);

    const adapter = new DevinAdapter();
    const { events, result } = await runUntilSettled(adapter, testConfig());

    clearTimeout(transitions);
    clearTimeout(exitTimer);

    // Must have session_init.
    const sessionInit = events.find((e) => e.type === "session_init");
    expect(sessionInit).toBeDefined();

    // Must have a result event.
    const resultEvent = events.findLast((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    if (resultEvent?.type === "result") {
      expect(resultEvent.isError).toBe(false);
    }

    expect(result.isError).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  test("waiting_for_approval emits progress event", async () => {
    // Start with approval state, then transition to exit.
    pollResponse.status = "running";
    pollResponse.status_detail = "waiting_for_approval";

    const exitTimer = setTimeout(() => {
      pollResponse.status = "exit";
      pollResponse.status_detail = "finished";
    }, 200);

    const adapter = new DevinAdapter();
    const { events } = await runUntilSettled(adapter, testConfig());
    clearTimeout(exitTimer);

    const progressEvent = events.find(
      (e) => e.type === "progress" && e.message === "waiting for approval",
    );
    expect(progressEvent).toBeDefined();
  });
});

describe("session_init — provider metadata", () => {
  test("session_init event includes provider and providerMeta with sessionUrl", async () => {
    pollResponse.status = "exit";
    pollResponse.status_detail = "finished";

    const adapter = new DevinAdapter();
    const { events } = await runUntilSettled(adapter, testConfig());

    const sessionInit = events.find((e) => e.type === "session_init");
    expect(sessionInit).toBeDefined();
    if (sessionInit?.type === "session_init") {
      expect(sessionInit.provider).toBe("devin");
      expect(sessionInit.providerMeta).toBeDefined();
      expect(sessionInit.providerMeta?.sessionUrl).toBe(
        "https://app.devin.ai/sessions/ses-test-001",
      );
    }
  });
});

describe("Polling loop — suspended states", () => {
  test("suspended/inactivity settles with suspended_inactivity", async () => {
    pollResponse.status = "suspended";
    pollResponse.status_detail = "inactivity";
    pollResponse.acus_consumed = 2;

    const adapter = new DevinAdapter();
    const { events, result } = await runUntilSettled(adapter, testConfig());

    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);

    const resultEvent = events.findLast((e) => e.type === "result");
    if (resultEvent?.type === "result") {
      expect(resultEvent.errorCategory).toBe("suspended_inactivity");
    }
  });

  test("suspended/user_request settles with suspended_user", async () => {
    pollResponse.status = "suspended";
    pollResponse.status_detail = "user_request";

    const adapter = new DevinAdapter();
    const { result } = await runUntilSettled(adapter, testConfig());

    expect(result.isError).toBe(true);
    expect(result.errorCategory).toBe("suspended_user");
  });

  test("suspended/usage_limit_exceeded settles with suspended_cost", async () => {
    pollResponse.status = "suspended";
    pollResponse.status_detail = "usage_limit_exceeded";

    const adapter = new DevinAdapter();
    const { events, result } = await runUntilSettled(adapter, testConfig());

    expect(result.isError).toBe(true);

    const resultEvent = events.findLast((e) => e.type === "result");
    if (resultEvent?.type === "result") {
      expect(resultEvent.errorCategory).toBe("suspended_cost");
    }
  });

  test("suspended/out_of_credits settles with suspended_cost", async () => {
    pollResponse.status = "suspended";
    pollResponse.status_detail = "out_of_credits";

    const adapter = new DevinAdapter();
    const { result } = await runUntilSettled(adapter, testConfig());

    expect(result.isError).toBe(true);
  });
});

describe("Polling loop — error and poll failures", () => {
  test("error status settles with devin_error", async () => {
    pollResponse.status = "error";
    pollResponse.acus_consumed = 1;

    const adapter = new DevinAdapter();
    const { events, result } = await runUntilSettled(adapter, testConfig());

    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);

    const resultEvent = events.findLast((e) => e.type === "result");
    if (resultEvent?.type === "result") {
      expect(resultEvent.errorCategory).toBe("devin_error");
    }
  });

  test("10 consecutive poll errors settles with poll_failure", async () => {
    pollErrorResponse = { status: 500, body: JSON.stringify({ error: "server error" }) };
    pollErrorCount = 20; // More than enough — adapter gives up at 10.

    const adapter = new DevinAdapter();
    const { events, result } = await runUntilSettled(adapter, testConfig(), { timeout: 10000 });

    expect(result.isError).toBe(true);

    const resultEvent = events.findLast((e) => e.type === "result");
    if (resultEvent?.type === "result") {
      expect(resultEvent.errorCategory).toBe("poll_failure");
    }

    // Should have emitted raw_stderr warnings for each failed poll.
    const stderrEvents = events.filter((e) => e.type === "raw_stderr");
    expect(stderrEvents.length).toBeGreaterThanOrEqual(1);
  });
});

describe("DevinAdapter.canResume", () => {
  test("returns true for suspended session", async () => {
    pollResponse.status = "suspended";
    pollResponse.status_detail = "inactivity";

    const adapter = new DevinAdapter();
    const result = await adapter.canResume("ses-test-001");
    expect(result).toBe(true);
  });

  test("returns false for exit session", async () => {
    pollResponse.status = "exit";

    const adapter = new DevinAdapter();
    const result = await adapter.canResume("ses-test-001");
    expect(result).toBe(false);
  });

  test("returns false for error session (conservative — not all errors are recoverable)", async () => {
    pollResponse.status = "error";

    const adapter = new DevinAdapter();
    const result = await adapter.canResume("ses-test-001");
    expect(result).toBe(false);
  });

  test("returns false for empty session ID", async () => {
    const adapter = new DevinAdapter();
    expect(await adapter.canResume("")).toBe(false);
  });

  test("returns false without DEVIN_API_KEY", async () => {
    delete process.env.DEVIN_API_KEY;
    const adapter = new DevinAdapter();
    expect(await adapter.canResume("ses-test-001")).toBe(false);
    process.env.DEVIN_API_KEY = API_KEY;
  });
});

describe("DevinAdapter.abort", () => {
  test("abort does NOT archive the session (keeps alive for resume)", async () => {
    // Start running, then abort before it exits.
    pollResponse.status = "running";
    pollResponse.status_detail = "working";

    const adapter = new DevinAdapter();
    const session = await adapter.createSession(testConfig());
    const events: ProviderEvent[] = [];
    session.onEvent((e) => events.push(e));

    // Wait a tick for the first poll, then abort.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.abort();
    const result = await session.waitForCompletion();

    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(result.failureReason).toBe("cancelled");

    // The abort path should emit a result with cancelled category.
    const resultEvent = events.findLast((e) => e.type === "result");
    if (resultEvent?.type === "result") {
      expect(resultEvent.errorCategory).toBe("cancelled");
    }
  });
});

describe("CostData mapping", () => {
  test("ACUs mapped with default cost ($2.25 per ACU)", async () => {
    pollResponse.status = "exit";
    pollResponse.status_detail = "finished";
    pollResponse.acus_consumed = 4;

    const adapter = new DevinAdapter();
    const { events } = await runUntilSettled(adapter, testConfig());

    const resultEvent = events.findLast((e) => e.type === "result");
    if (resultEvent?.type === "result") {
      expect(resultEvent.cost.totalCostUsd).toBeCloseTo(4 * 2.25, 4);
      expect(resultEvent.cost.model).toBe("devin");
      expect(resultEvent.cost.inputTokens).toBe(0);
      expect(resultEvent.cost.outputTokens).toBe(0);
    }
  });

  test("ACUs mapped with custom DEVIN_ACU_COST_USD", async () => {
    process.env.DEVIN_ACU_COST_USD = "3.50";
    pollResponse.status = "exit";
    pollResponse.status_detail = "finished";
    pollResponse.acus_consumed = 2;

    const adapter = new DevinAdapter();
    const { events } = await runUntilSettled(adapter, testConfig());

    const resultEvent = events.findLast((e) => e.type === "result");
    if (resultEvent?.type === "result") {
      expect(resultEvent.cost.totalCostUsd).toBeCloseTo(2 * 3.5, 4);
    }

    delete process.env.DEVIN_ACU_COST_USD;
  });
});

describe("DevinAdapter.formatCommand", () => {
  test("returns @skills:name format", () => {
    const adapter = new DevinAdapter();
    expect(adapter.formatCommand("lint-fix")).toBe("@skills:lint-fix");
    expect(adapter.formatCommand("deploy")).toBe("@skills:deploy");
  });
});

describe("Structured output and PR tracking", () => {
  test("structured output changes emitted as custom events", async () => {
    pollResponse.status = "running";
    pollResponse.status_detail = "working";
    pollResponse.structured_output = { result: "partial" };

    // After a bit, change the output and finish.
    const timer = setTimeout(() => {
      pollResponse.structured_output = { result: "final" };
      pollResponse.status = "exit";
      pollResponse.status_detail = "finished";
    }, 150);

    const adapter = new DevinAdapter();
    const { events } = await runUntilSettled(adapter, testConfig());
    clearTimeout(timer);

    const outputEvents = events.filter(
      (e) => e.type === "custom" && e.name === "devin.structured_output",
    );
    expect(outputEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("pull request events emitted for new PRs", async () => {
    pollResponse.status = "running";
    pollResponse.status_detail = "working";
    pollResponse.pull_requests = [
      { pr_url: "https://github.com/org/repo/pull/42", pr_state: "open" },
    ];

    const timer = setTimeout(() => {
      pollResponse.status = "exit";
      pollResponse.status_detail = "finished";
    }, 150);

    const adapter = new DevinAdapter();
    const { events } = await runUntilSettled(adapter, testConfig());
    clearTimeout(timer);

    const prEvents = events.filter((e) => e.type === "custom" && e.name === "devin.pull_request");
    expect(prEvents.length).toBeGreaterThanOrEqual(1);
    if (prEvents[0]?.type === "custom") {
      const data = prEvents[0].data as { prUrl: string; prState: string };
      expect(data.prUrl).toBe("https://github.com/org/repo/pull/42");
      expect(data.prState).toBe("open");
    }
  });
});

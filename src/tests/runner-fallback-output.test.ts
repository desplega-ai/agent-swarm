import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  type ApiConfig,
  ensureTaskFinished,
  type FallbackResult,
  handleStructuredOutputFallback,
} from "../commands/runner";

const TEST_PORT = 13099;

// Configurable mock responses per test
let mockGetTask: Record<string, unknown> | null = null;
let mockGetTaskStatus = 200;
let lastFinishBody: Record<string, unknown> | null = null;
let mockFinishResponse: Record<string, unknown> = { success: true };

function resetMocks() {
  mockGetTask = null;
  mockGetTaskStatus = 200;
  lastFinishBody = null;
  mockFinishResponse = { success: true };
}

let server: Server;

function makeConfig(port = TEST_PORT): ApiConfig {
  return {
    apiUrl: `http://localhost:${port}`,
    apiKey: "test-key",
    agentId: "test-agent-id",
  };
}

beforeAll(async () => {
  server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();
    const url = req.url || "";

    // GET /api/tasks/:id
    if (req.method === "GET" && /^\/api\/tasks\/[^/]+$/.test(url)) {
      if (!mockGetTask) {
        res.writeHead(mockGetTaskStatus);
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(mockGetTaskStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify(mockGetTask));
      return;
    }

    // POST /api/tasks/:id/finish
    if (req.method === "POST" && /^\/api\/tasks\/[^/]+\/finish$/.test(url)) {
      lastFinishBody = body ? JSON.parse(body) : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(mockFinishResponse));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(TEST_PORT, () => resolve());
  });
});

afterAll(() => {
  server.close();
});

describe("handleStructuredOutputFallback", () => {
  test("returns no-schema with lastProgress when task has progress logs", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-1",
      task: "Do something",
      status: "in_progress",
      output: null,
      progress: "older progress",
      logs: [
        { eventType: "task_progress", newValue: "first update", createdAt: "2025-01-01T00:00:00Z" },
        {
          eventType: "task_progress",
          newValue: "latest update",
          createdAt: "2025-01-01T01:00:00Z",
        },
        {
          eventType: "task_status_change",
          newValue: "in_progress",
          createdAt: "2025-01-01T00:00:00Z",
        },
      ],
    };

    const result = await handleStructuredOutputFallback(makeConfig(), "task-1", "claude");
    expect(result).toEqual({ kind: "no-schema", lastProgress: "latest update" });
  });

  test("returns no-schema with progress field when no progress logs exist", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-2",
      task: "Do something",
      status: "in_progress",
      output: null,
      progress: "some progress text",
      logs: [],
    };

    const result = await handleStructuredOutputFallback(makeConfig(), "task-2", "claude");
    expect(result).toEqual({ kind: "no-schema", lastProgress: "some progress text" });
  });

  test("returns no-schema without lastProgress when no progress at all", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-3",
      task: "Do something",
      status: "in_progress",
      output: null,
      progress: null,
      logs: [],
    };

    const result = await handleStructuredOutputFallback(makeConfig(), "task-3", "claude");
    expect(result).toEqual({ kind: "no-schema", lastProgress: undefined });
  });

  test("returns already-has-output when task has output and outputSchema", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-4",
      task: "Do something",
      status: "completed",
      output: '{"result": "done"}',
      outputSchema: { type: "object", properties: { result: { type: "string" } } },
      logs: [],
    };

    const result = await handleStructuredOutputFallback(makeConfig(), "task-4", "claude");
    expect(result).toEqual({ kind: "already-has-output" });
  });

  test("returns fetch-error when API returns non-200", async () => {
    resetMocks();
    mockGetTask = null;
    mockGetTaskStatus = 500;

    const result = await handleStructuredOutputFallback(makeConfig(), "task-5", "claude");
    expect(result).toEqual({ kind: "fetch-error", error: "HTTP 500" });
  });

  test("returns schema-fail for non-claude adapter with outputSchema", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-6",
      task: "Do something",
      status: "in_progress",
      output: null,
      outputSchema: { type: "object", properties: { result: { type: "string" } } },
      logs: [],
    };

    const result = await handleStructuredOutputFallback(makeConfig(), "task-6", "pi-mono");
    expect(result).toEqual({
      kind: "schema-fail",
      failReason: "Structured output required by outputSchema but not provided via store-progress",
    });
  });

  test("returns fetch-error on network error", async () => {
    resetMocks();
    // Use a port that nothing listens on
    const badConfig = makeConfig(19999);

    const result = await handleStructuredOutputFallback(badConfig, "task-7", "claude");
    expect(result.kind).toBe("fetch-error");
    expect((result as { kind: "fetch-error"; error: string }).error).toBeTruthy();
  });
});

describe("ensureTaskFinished", () => {
  test("sets output to last progress for no-schema fallback", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-10",
      task: "Do work",
      status: "in_progress",
      output: null,
      progress: null,
      logs: [
        {
          eventType: "task_progress",
          newValue: "Did some work here",
          createdAt: "2025-01-01T00:00:00Z",
        },
      ],
    };

    await ensureTaskFinished(makeConfig(), "worker", "task-10", 0);

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("completed");
    expect(lastFinishBody!.output).toBe("Did some work here");
  });

  test("sets generic message when no-schema and no progress", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-11",
      task: "Do work",
      status: "in_progress",
      output: null,
      progress: null,
      logs: [],
    };

    await ensureTaskFinished(makeConfig(), "worker", "task-11", 0);

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("completed");
    expect(lastFinishBody!.output).toBe("Process completed successfully (no output captured)");
  });

  test("sets failed status for schema-fail fallback", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-12",
      task: "Do work",
      status: "in_progress",
      output: null,
      outputSchema: { type: "object" },
      logs: [],
    };
    // Force a non-claude adapter via env. The factory at
    // src/providers/index.ts accepts "pi" (NOT "pi-mono") — the prior
    // test value was a typo that silently fell into the unknown-provider
    // error path instead of exercising the pi branch.
    const origProvider = process.env.HARNESS_PROVIDER;
    process.env.HARNESS_PROVIDER = "pi";

    await ensureTaskFinished(makeConfig(), "worker", "task-12", 0);

    process.env.HARNESS_PROVIDER = origProvider;

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("failed");
    expect(lastFinishBody!.failureReason).toContain("outputSchema");
  });

  test("schema-fail fallback also works under HARNESS_PROVIDER=codex", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-12c",
      task: "Do work",
      status: "in_progress",
      output: null,
      outputSchema: { type: "object" },
      logs: [],
    };
    const origProvider = process.env.HARNESS_PROVIDER;
    process.env.HARNESS_PROVIDER = "codex";

    await ensureTaskFinished(makeConfig(), "worker", "task-12c", 0);

    process.env.HARNESS_PROVIDER = origProvider;

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("failed");
    expect(lastFinishBody!.failureReason).toContain("outputSchema");
  });

  test("handles alreadyFinished gracefully", async () => {
    resetMocks();
    mockGetTask = {
      id: "task-13",
      task: "Do work",
      status: "in_progress",
      output: null,
      progress: null,
      logs: [],
    };
    mockFinishResponse = { success: true, alreadyFinished: true, task: { status: "completed" } };

    // Should not throw
    await ensureTaskFinished(makeConfig(), "worker", "task-13", 0);
    expect(lastFinishBody).toBeTruthy();
  });

  test("sends failure reason when exit code is non-zero", async () => {
    resetMocks();

    await ensureTaskFinished(makeConfig(), "worker", "task-14", 1, "Out of memory");

    expect(lastFinishBody).toBeTruthy();
    expect(lastFinishBody!.status).toBe("failed");
    expect(lastFinishBody!.failureReason).toBe("Out of memory");
  });

  test("truncates long progress to 2000 chars", async () => {
    resetMocks();
    const longProgress = "x".repeat(3000);
    mockGetTask = {
      id: "task-15",
      task: "Do work",
      status: "in_progress",
      output: null,
      progress: longProgress,
      logs: [],
    };

    await ensureTaskFinished(makeConfig(), "worker", "task-15", 0);

    expect(lastFinishBody).toBeTruthy();
    expect((lastFinishBody!.output as string).length).toBe(2000);
  });
});

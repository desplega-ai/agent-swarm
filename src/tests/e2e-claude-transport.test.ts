import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { claudeTransportFromEnv, runHarnessLeg } from "../../scripts/e2e/harness";
import type { ApiClient, ApiOptions, ApiResponse } from "../../scripts/e2e/http";

const savedEnvironment = { ...process.env };
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const TASK_ID = "00000000-0000-4000-8000-000000000002";
const SESSION_ID = "00000000-0000-4000-8000-000000000003";

type FakeApiOptions = {
  transport?: unknown;
  costs?: unknown[];
};

function response(status: number, json: unknown): ApiResponse {
  return { status, json, text: JSON.stringify(json) };
}

function fakeApi(
  calls: Array<{ method: string; path: string; options?: ApiOptions }>,
  overrides: FakeApiOptions = {},
): ApiClient {
  let taskMarker = "";
  return async (method, path, requestOptions) => {
    calls.push({ method, path, options: requestOptions });
    if (method === "POST" && path === "/api/agents") {
      return response(201, { id: AGENT_ID });
    }
    if (method === "PUT" && path === "/api/config") {
      return response(200, { id: "00000000-0000-4000-8000-000000000004" });
    }
    if (method === "POST" && path === "/api/tasks") {
      const task = String((requestOptions?.body as { task?: unknown } | undefined)?.task ?? "");
      taskMarker = task.match(/PONG-[A-Za-z0-9-]+/)?.[0] ?? "";
      return response(201, { id: TASK_ID });
    }
    if (method === "GET" && path.startsWith("/api/tasks/")) {
      return response(200, {
        status: "completed",
        output: taskMarker,
        claudeSessionId: SESSION_ID,
        providerMeta: {
          transport: overrides.transport ?? process.env.E2E_CLAUDE_TRANSPORT,
        },
      });
    }
    if (method === "GET" && path.startsWith("/api/session-costs?")) {
      return response(200, {
        costs: overrides.costs ?? [
          { inputTokens: 12, outputTokens: 3, totalCostUsd: 0.01, costSource: "harness" },
        ],
      });
    }
    throw new Error(`Unexpected fake API call: ${method} ${path}`);
  };
}

function fakeWorker(): ReturnType<typeof Bun.spawn> {
  const closed = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  return {
    stdout: closed(),
    stderr: closed(),
    stdin: null,
    exited: Promise.resolve(0),
    exitCode: 0,
    kill: () => {},
    pid: 123,
    killed: false,
    ref: () => {},
    unref: () => {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, savedEnvironment);
});

describe("Claude E2E transport harness", () => {
  test("defaults to CLI and rejects unsupported values", () => {
    expect(claudeTransportFromEnv({})).toBe("cli");
    expect(claudeTransportFromEnv({ E2E_CLAUDE_TRANSPORT: "sdk" })).toBe("sdk");
    expect(() => claudeTransportFromEnv({ E2E_CLAUDE_TRANSPORT: "bridge" })).toThrow(
      "E2E_CLAUDE_TRANSPORT must be cli or sdk",
    );
  });

  test("writes the agent override and validates transport metadata and Claude costs", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.E2E_CLAUDE_BINARY = "/opt/claude-pinned";
    process.env.E2E_WORKER_BINARY = "/opt/agent-swarm";
    const spawnCalls: Parameters<typeof Bun.spawn>[] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args) => {
      spawnCalls.push(args);
      return fakeWorker();
    }) as typeof Bun.spawn);

    try {
      for (const transport of ["cli", "sdk"] as const) {
        process.env.E2E_CLAUDE_TRANSPORT = transport;
        const calls: Array<{ method: string; path: string; options?: ApiOptions }> = [];
        const result = await runHarnessLeg(
          "claude",
          fakeApi(calls),
          "http://transport.test",
          "test-api-key",
          `transport-${transport}`,
        );

        expect(result.status, result.error).toBe("pass");
        expect(result.provider).toBe("claude");
        expect(result.transport).toBe(transport);
        const configCall = calls.find((call) => call.method === "PUT");
        expect(configCall?.options?.body).toEqual({
          scope: "agent",
          scopeId: AGENT_ID,
          key: "CLAUDE_TRANSPORT",
          value: transport,
        });
        expect(result.cost?.records).toBe(1);
        expect(result.cost?.inputTokens).toBeGreaterThan(0);
        expect(result.cost?.outputTokens).toBeGreaterThan(0);
      }

      const workerEnv =
        spawnCalls[0]?.[1] && "env" in spawnCalls[0][1]
          ? (spawnCalls[0][1] as { env?: Record<string, string> }).env
          : undefined;
      expect(workerEnv?.CLAUDE_BINARY).toBe("/opt/claude-pinned");
      expect(spawnCalls[0]?.[0]).toContain("/opt/agent-swarm");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("fails when Claude metadata or costs do not prove the selected transport", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.E2E_CLAUDE_TRANSPORT = "sdk";
    process.env.E2E_COST_TIMEOUT_MS = "1";
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() =>
      fakeWorker()) as typeof Bun.spawn);

    try {
      const wrongMetadata = await runHarnessLeg(
        "claude",
        fakeApi([], { transport: "cli" }),
        "http://transport.test",
        "test-api-key",
        "wrong-metadata",
      );
      expect(wrongMetadata.status).toBe("fail");
      expect(wrongMetadata.error).toContain("providerMeta.transport");

      const missingCosts = await runHarnessLeg(
        "claude",
        fakeApi([], { costs: [] }),
        "http://transport.test",
        "test-api-key",
        "missing-costs",
      );
      expect(missingCosts.status).toBe("fail");
      expect(missingCosts.error).toContain("persisted cost record");

      const zeroCosts = await runHarnessLeg(
        "claude",
        fakeApi([], { costs: [{ inputTokens: 0, outputTokens: 0, totalCostUsd: 0 }] }),
        "http://transport.test",
        "test-api-key",
        "zero-costs",
      );
      expect(zeroCosts.status).toBe("fail");
      expect(zeroCosts.error).toContain("input tokens");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("does not validate the Claude flag for non-Claude legs", async () => {
    process.env.E2E_CLAUDE_TRANSPORT = "invalid";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() =>
      fakeWorker()) as typeof Bun.spawn);

    try {
      const result = await runHarnessLeg(
        "pi",
        fakeApi([]),
        "http://transport.test",
        "test-api-key",
        "non-claude",
      );
      expect(result.status).toBe("pass");
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

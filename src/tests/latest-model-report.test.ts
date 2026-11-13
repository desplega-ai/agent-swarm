import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnProviderProcess } from "../commands/runner";
import type { CostData, ProviderEvent, ProviderSessionConfig } from "../providers/types";

const originalFetch = globalThis.fetch;
const directory = `${import.meta.dir}/../../work/latest-model-${crypto.randomUUID()}`;

const CONFIG = "openai-codex/gpt-5.5";
const RESOLVED = "openai-codex/gpt-5.6-luna";

beforeAll(async () => {
  await Bun.$`mkdir -p ${directory}`.quiet();
});
afterAll(async () => {
  await Bun.$`rm -rf ${directory}`.quiet();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type ReportedModel = { model: string; source: string };

/** Runs one task through the real runner and returns the latest_model of every credential-status PUT. */
async function runTask(
  claim: { resolvedModel?: string; modelSource?: string; modelTier?: "smol" },
  agentConfigModel = CONFIG,
): Promise<ReportedModel[]> {
  const reports: ReportedModel[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (path === "/api/config/resolved") {
      return Response.json({ configs: [{ key: "MODEL_OVERRIDE", value: agentConfigModel }] });
    }
    if (path.endsWith("/credential-status") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { latest_model?: ReportedModel };
      if (body.latest_model) reports.push(body.latest_model);
    }
    return Response.json({ configs: [], enabled: false });
  }) as typeof fetch;

  const agentId = crypto.randomUUID();
  const adapter = {
    name: "pi",
    traits: {},
    async createSession(config: ProviderSessionConfig) {
      const cost: CostData = {
        sessionId: "provider-session",
        agentId,
        totalCostUsd: 0,
        inputTokens: 1,
        outputTokens: 1,
        model: config.model,
        durationMs: 1,
        numTurns: 1,
        isError: false,
        provider: "pi",
      };
      return {
        sessionId: "provider-session",
        onEvent(listener: (event: ProviderEvent) => void) {
          listener({ type: "session_init", sessionId: "provider-session" });
          listener({ type: "result", cost, isError: false });
        },
        async waitForCompletion() {
          return { exitCode: 0, isError: false, cost };
        },
        async abort() {},
      };
    },
  } as unknown as Parameters<typeof spawnProviderProcess>[0];

  const running = await spawnProviderProcess(
    adapter,
    {
      prompt: "hello",
      systemPrompt: "fixture",
      logFile: `${directory}/session.jsonl`,
      role: "worker",
      apiUrl: "http://runner.invalid",
      apiKey: "example-runner-key",
      agentId,
      runnerSessionId: crypto.randomUUID(),
      iteration: 1,
      taskId: crypto.randomUUID(),
      harnessProvider: "pi",
      cwd: directory,
      // `model` stays unset: a tier or profile task carries no raw pin.
      ...claim,
    },
    directory,
  );
  await running.promise;
  return reports;
}

describe("latest model source across the initial, result and final reports", () => {
  test.each([
    "tier-default",
    "tier-config",
    "worker-env",
    "profile:task",
    "profile:tier-alias",
  ])("claim source %s stays task in all three reports", async (modelSource) => {
    const reports = await runTask({ resolvedModel: RESOLVED, modelSource });
    expect(reports.map((r) => [r.model, r.source])).toEqual([
      [RESOLVED, "task"],
      [RESOLVED, "task"],
      [RESOLVED, "task"],
    ]);
  });

  test("a tier resolved only locally (no server resolution) stays task in all three reports", async () => {
    const reports = await runTask({ modelTier: "smol" });
    expect(reports).toHaveLength(3);
    expect(reports.map((r) => r.source)).toEqual(["task", "task", "task"]);
  });

  test("the agent default profile is never task-selected: custom when it differs from the agent config", async () => {
    const reports = await runTask({
      resolvedModel: RESOLVED,
      modelSource: "profile:agent-default",
    });
    expect(reports.map((r) => [r.model, r.source])).toEqual([
      [RESOLVED, "custom"],
      [RESOLVED, "custom"],
      [RESOLVED, "custom"],
    ]);
  });

  test("the agent default profile reports agent_config when it matches the agent config", async () => {
    const reports = await runTask({ resolvedModel: CONFIG, modelSource: "profile:agent-default" });
    expect(reports.map((r) => [r.model, r.source])).toEqual([
      [CONFIG, "agent_config"],
      [CONFIG, "agent_config"],
      [CONFIG, "agent_config"],
    ]);
  });
});

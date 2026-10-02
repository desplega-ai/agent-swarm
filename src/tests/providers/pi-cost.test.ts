// Phase 3 fix — regression guard that PiMonoSession stamps `provider: "pi"`
// on every CostData it emits. Without this tag the API server recompute
// branch in src/http/session-data.ts falls through to costSource='harness'
// instead of engaging the pricing-table lookup, so a perfectly-priced model
// (e.g. `openrouter/deepseek/deepseek-v4-flash`) silently renders as un-priced.
//
// Mirrors the narrow, single-purpose shape of src/tests/providers/codex-cost.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { PiMonoAdapter, PiMonoSession } from "../../providers/pi-mono-adapter";
import type { CostData, ProviderEvent, ProviderSessionConfig } from "../../providers/types";

/**
 * Build a hand-rolled fake `AgentSession` that exercises the pi-mono-adapter
 * cost-emission path without booting the real pi-coding-agent runtime.
 *
 * The adapter calls (in order, inside `runSession()`):
 *   1. `prompt(text, opts)`   — resolves immediately for the fake
 *   2. `waitForIdle()` reads  — `isStreaming` (we pin to `false`)
 *   3. `getSessionStats()`    — returns the canned token/cost shape
 *
 * `subscribe(cb)` is called twice (once in the constructor for the normal
 * event handler, once optionally in `waitForIdle`). Returning a noop
 * unsubscriber is enough.
 */
function makeFakeAgentSession(opts: {
  sessionId: string;
  modelProvider: string;
  modelId: string;
}): {
  fake: import("@earendil-works/pi-coding-agent").AgentSession;
  callPromptResolve: () => void;
} {
  let promptResolve: () => void = () => {};
  const promptDone = new Promise<void>((r) => {
    promptResolve = r;
  });
  const fake = {
    sessionId: opts.sessionId,
    model: { provider: opts.modelProvider, id: opts.modelId },
    isStreaming: false,
    subscribe: (_cb: unknown) => () => {},
    prompt: async () => {
      // Block until the test wants the adapter to proceed past `prompt()`.
      // Pi adapter awaits this before reading session stats, so we resolve
      // synchronously to keep the test deterministic.
      await promptDone;
    },
    getSessionStats: () => ({
      tokens: { input: 64463, output: 313, cacheRead: 31616, cacheWrite: 0, total: 96392 },
      // Pi-mono uses `stats.cost` directly. We pin a non-zero value so we can
      // still assert it round-trips, but the load-bearing field for this
      // suite is `provider` regardless of dollars.
      cost: 0.008,
      userMessages: 1,
      assistantMessages: 1,
    }),
    getContextUsage: () => undefined,
    dispose: () => {},
  };
  // Resolve the prompt gate immediately — the adapter awaits prompt() before
  // waitForIdle() reads `isStreaming`, but our fake's `isStreaming` is `false`
  // so waitForIdle resolves right away.
  promptResolve();
  return {
    // The pi-coding-agent AgentSession surface area is wide; we cast through
    // `unknown` because the test only needs the four methods listed above.
    fake: fake as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
    callPromptResolve: promptResolve,
  };
}

function makeConfig(logFile: string): ProviderSessionConfig {
  return {
    prompt: "do a thing",
    systemPrompt: "be helpful",
    // The exact harness-emitted model id from today's E2E run. This is the
    // case `normalizeModelKey('pi', ...)` must collapse onto a seeded
    // `deepseek/deepseek-v4-flash` row.
    model: "openrouter/deepseek/deepseek-v4-flash",
    role: "worker",
    agentId: "agent-1",
    taskId: "task-1",
    apiUrl: "http://localhost:0",
    apiKey: "example-test-key",
    cwd: "/tmp",
    logFile,
  };
}

describe("PiMonoSession — provider tag on CostData", () => {
  test("waitForCompletion → result.cost.provider === 'pi'", async () => {
    const dir = join(tmpdir(), `pi-cost-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const logFile = join(dir, "session.log");
    try {
      const { fake } = makeFakeAgentSession({
        sessionId: "sess-pi-test",
        modelProvider: "openrouter",
        modelId: "deepseek/deepseek-v4-flash",
      });

      const events: ProviderEvent[] = [];
      const session = new PiMonoSession(fake, makeConfig(logFile), false);
      session.onEvent((e) => events.push(e));

      const sessionInit = events.find((e) => e.type === "session_init");
      expect(sessionInit?.type).toBe("session_init");
      if (sessionInit?.type !== "session_init") {
        throw new Error("Expected pi session_init event");
      }
      expect(sessionInit.provider).toBe("pi");
      expect(sessionInit.harnessVariant).toBe("stock");
      expect(typeof sessionInit.harnessVariantMeta?.version).toBe("string");
      expect((sessionInit.harnessVariantMeta?.version as string).length).toBeGreaterThan(0);

      const result = await session.waitForCompletion();

      // The load-bearing assertion. Phase 2's API recompute path keys off
      // exactly this field; emitting CostData without it silently disables
      // pricing-table tagging for the entire pi provider.
      expect(result.cost?.provider).toBe("pi");
      const resultEvent = events.find((e) => e.type === "result");
      expect(resultEvent).toBeDefined();
      if (resultEvent?.type === "result") {
        expect(resultEvent.cost.provider).toBe("pi");
        // Sanity — the reportedModel() helper composes `provider/id` so the
        // server-side normalizer's prefix-strip has something to bite on.
        expect(resultEvent.cost.model).toBe("openrouter/deepseek/deepseek-v4-flash");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// PI_CODEMODE_MODELS lets a codemode script call `models.classify()` and
// `models.generateImages()`. Those calls spend money that no assistant turn
// carries, so the question is whether the session cost the adapter reports
// includes them. On pi 1.0 it does, through four links, each exercised here
// against pi's real code:
//   1. the codemode tool puts the script's `models.*` usage on its result;
//   2. pi's agent loop copies `result.usage` onto the toolResult message;
//   3. `getSessionStats()` adds `usage` of every toolResult message;
//   4. `buildCostData` reports `stats.cost` as `totalCostUsd`.
describe("PiMonoSession — codemode models usage counts toward cost", () => {
  const envKeys = [
    "PI_CODEMODE",
    "PI_CODEMODE_MODELS",
    "PI_TOOL_DEFERRAL",
    "PI_CODING_AGENT_DIR",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
  ];
  const saved: Record<string, string | undefined> = {};
  let dir = "";

  beforeEach(() => {
    for (const key of envKeys) saved[key] = process.env[key];
    dir = mkdtempSync(join(tmpdir(), "pi-cost-codemode-"));
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    process.env.OPENROUTER_API_KEY = "example-test-key";
    // The session prompts on creation; keep that request off the network.
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
    process.env.PI_CODEMODE = "true";
    process.env.PI_CODEMODE_MODELS = "true";
    delete process.env.PI_TOOL_DEFERRAL;
  });
  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const CLASSIFIER_COST_USD = 0.0042;
  const classifierUsage = {
    input: 1200,
    output: 40,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1240,
    cost: { input: 0.004, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: CLASSIFIER_COST_USD },
  };

  /** A model registry that answers `models.classify()` with a priced usage. */
  function ctxWithClassifier(): ExtensionToolContext {
    const classifier = { provider: "test", id: "clf-1", name: "Test classifier" };
    return {
      tools: [],
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        getModelsOfType: () => [classifier],
        getAvailableOfType: async () => [classifier],
        getModelOfType: (type: string, provider: string, id: string) =>
          type === "classifier" && provider === classifier.provider && id === classifier.id
            ? classifier
            : undefined,
        classify: async () => ({ stopReason: "stop", output: {}, usage: classifierUsage }),
        generateImages: async () => {
          throw new Error("not used");
        },
      },
    } as unknown as ExtensionToolContext;
  }

  const CLASSIFY_SCRIPT = `
    const model = await models.getModelOfType("classifier", "test", "clf-1");
    const result = await models.classify(model, {
      state: {},
      questions: { ok: { type: "bool", instructions: "Is it fine?", criteria: { true: "yes", false: "no" } } },
    });
    return result.stopReason;
  `;

  async function realSession(): Promise<{ provider: PiMonoSession; agentSession: AgentSession }> {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname !== "/mcp") return Response.json({ servers: [] });
        const body = (await req.json()) as { id?: number; method?: string };
        const result =
          body.method === "tools/list"
            ? { tools: [{ name: "store-progress", inputSchema: { type: "object" } }] }
            : { protocolVersion: "2025-03-26", capabilities: {} };
        return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, result });
      },
    });
    try {
      const provider = (await new PiMonoAdapter().createSession({
        prompt: "hello",
        systemPrompt: "",
        model: "openrouter/google/gemini-3-flash-preview",
        role: "worker",
        agentId: "test-agent",
        taskId: "test-task",
        apiUrl: `http://localhost:${server.port}`,
        apiKey: "example-test-key",
        cwd: dir,
        logFile: join(dir, "session.log"),
      })) as PiMonoSession;
      return {
        provider,
        agentSession: (provider as unknown as { agentSession: AgentSession }).agentSession,
      };
    } finally {
      server.stop(true);
    }
  }

  test("a models.classify() script's usage reaches the cost the adapter reports", async () => {
    const { provider, agentSession } = await realSession();
    try {
      const codemode = agentSession.getToolDefinition("codemode");
      if (!codemode) throw new Error("codemode tool was not registered");

      // 1. The real codemode tool, built by the adapter with models on.
      const result = (await codemode.execute(
        "call-1",
        { code: CLASSIFY_SCRIPT },
        undefined,
        undefined,
        ctxWithClassifier(),
      )) as { content: Array<{ text?: string }>; usage?: typeof classifierUsage };
      expect(result.content.map((item) => item.text ?? "").join("\n")).toStartWith(
        "Script completed",
      );
      expect(result.usage?.cost.total).toBe(CLASSIFIER_COST_USD);

      // 2. The toolResult message pi's agent loop builds (createToolResultMessage).
      const before = agentSession.getSessionStats();
      agentSession.sessionManager.appendMessage({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "codemode",
        content: [{ type: "text", text: "Script completed" }],
        usage: result.usage,
        isError: false,
        timestamp: Date.now(),
      } as unknown as Parameters<typeof agentSession.sessionManager.appendMessage>[0]);

      // 3. pi's real session stats sum the toolResult usage.
      const after = agentSession.getSessionStats();
      expect(after.cost - before.cost).toBeCloseTo(CLASSIFIER_COST_USD, 10);
      expect(after.tokens.input - before.tokens.input).toBe(classifierUsage.input);
      expect(after.tokens.output - before.tokens.output).toBe(classifierUsage.output);

      // 4. The adapter's CostData is built from those stats.
      const costOf = (stats: typeof after): CostData =>
        (provider as unknown as { buildCostData(s: typeof after): CostData }).buildCostData(stats);
      expect(costOf(after).totalCostUsd - costOf(before).totalCostUsd).toBeCloseTo(
        CLASSIFIER_COST_USD,
        10,
      );
    } finally {
      agentSession.dispose();
    }
  }, 30_000);

  test("models flag off: a script cannot reach models, so there is no usage to miss", async () => {
    process.env.PI_CODEMODE_MODELS = "false";
    const { agentSession } = await realSession();
    try {
      const codemode = agentSession.getToolDefinition("codemode");
      if (!codemode) throw new Error("codemode tool was not registered");
      const result = (await codemode.execute(
        "call-2",
        { code: CLASSIFY_SCRIPT },
        undefined,
        undefined,
        ctxWithClassifier(),
      )) as { content: Array<{ text?: string }>; usage?: unknown };
      expect(result.content.map((item) => item.text ?? "").join("\n")).toStartWith("Script failed");
      expect(result.usage).toBeUndefined();
    } finally {
      agentSession.dispose();
    }
  }, 30_000);
});

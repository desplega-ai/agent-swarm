// Phase 3 fix — regression guard that PiMonoSession stamps `provider: "pi"`
// on every CostData it emits. Without this tag the API server recompute
// branch in src/http/session-data.ts falls through to costSource='harness'
// instead of engaging the pricing-table lookup, so a perfectly-priced model
// (e.g. `openrouter/deepseek/deepseek-v4-flash`) silently renders as un-priced.
//
// Mirrors the narrow, single-purpose shape of src/tests/providers/codex-cost.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiMonoSession } from "../../providers/pi-mono-adapter";
import type { ProviderEvent, ProviderSessionConfig } from "../../providers/types";

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
    apiKey: "test-key",
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

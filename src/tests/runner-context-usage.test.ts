import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnProviderProcess } from "../commands/runner";
import type { CostData, ProviderEvent, ProviderSessionConfig } from "../providers/types";
import { getContextWindowSize } from "../utils/context-window";

const originalFetch = globalThis.fetch;
const directory = `${import.meta.dir}/../../work/runner-context-${crypto.randomUUID()}`;

beforeAll(async () => {
  await Bun.$`mkdir -p ${directory}`.quiet();
});
afterAll(async () => {
  await Bun.$`rm -rf ${directory}`.quiet();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("runner completion context", () => {
  for (const harness of ["pi", "codex"] as const) {
    for (const withLiveWindow of [true, false]) {
      test(`${harness}: ${withLiveWindow ? "retains the latest throttled live window" : "falls back to the catalog without live usage"}`, async () => {
        const snapshots: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
          if (path === "/api/config/resolved") {
            // Keep Codex on a fake gateway so the runner never reads local OAuth credentials.
            return Response.json({
              configs: [
                { key: "CODEX_GATEWAY_BASE_URL", value: "https://gateway.invalid/v1" },
                { key: "CODEX_GATEWAY_API_KEY", value: "example-gateway-key" },
              ],
            });
          }
          if (path.endsWith("/context")) snapshots.push(JSON.parse(String(init?.body)));
          return Response.json({ configs: [], enabled: false });
        }) as typeof fetch;

        const model = harness === "pi" ? "openai-codex/gpt-5.6-luna" : "gpt-5.6-luna";
        const cost: CostData = {
          sessionId: "provider-session",
          agentId: crypto.randomUUID(),
          totalCostUsd: 0,
          inputTokens: 100,
          outputTokens: 50,
          model,
          durationMs: 1,
          numTurns: 1,
          isError: false,
          provider: harness,
        };
        let configuredModel: string | undefined;
        const adapter = {
          name: harness,
          traits: {},
          async createSession(config: ProviderSessionConfig) {
            configuredModel = config.model;
            return {
              sessionId: "provider-session",
              onEvent(listener: (event: ProviderEvent) => void) {
                listener({ type: "session_init", sessionId: "provider-session" });
                if (withLiveWindow) {
                  // Only the first progress event is posted. A later unknown window
                  // must not erase the second event's authoritative live limit.
                  for (const contextTotalTokens of [258_400, 272_000, null, 0]) {
                    listener({
                      type: "context_usage",
                      contextUsedTokens: 1000,
                      contextTotalTokens,
                      contextPercent: 1,
                      outputTokens: 50,
                      contextFormula: "harness-reported",
                    });
                  }
                }
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
            agentId: cost.agentId,
            runnerSessionId: crypto.randomUUID(),
            iteration: 1,
            taskId: crypto.randomUUID(),
            model,
            harnessProvider: harness,
            cwd: directory,
          },
          directory,
          true,
        );
        await running.promise;
        expect(configuredModel).toBe(model);
        const completion = snapshots.find((snapshot) => snapshot.eventType === "completion");
        expect(completion?.contextTotalTokens).toBe(
          withLiveWindow ? 272_000 : getContextWindowSize(model),
        );
        expect(completion?.cumulativeInputTokens).toBe(100);
        expect(completion?.cumulativeOutputTokens).toBe(50);
        expect(snapshots.filter((snapshot) => snapshot.eventType === "progress")).toHaveLength(
          withLiveWindow ? 1 : 0,
        );
      });
    }
  }
});

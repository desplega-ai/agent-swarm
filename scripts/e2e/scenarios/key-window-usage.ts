import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { claimTask, createAssignedTask, registerWorker, retireAgent } from "./core-helpers";

export const keyWindowUsage: Scenario = {
  name: "key-window-usage",
  order: 612,
  async run(ctx) {
    const path = "/api/keys/window-usage";
    expectStatus(await ctx.api("GET", path, { apiKey: null }), [401], "window usage requires auth");
    expectStatus(
      await ctx.api("GET", `${path}?keySuffix=${"x".repeat(11)}`),
      [400],
      "window usage validates filters",
    );
    const keyType = `E2E_WINDOW_${ctx.nonce}`.toUpperCase();
    const keySuffix = `w${ctx.nonce.slice(0, 8)}`;
    const agentId = await registerWorker(ctx, "window-usage");
    const taskId = await createAssignedTask(ctx, agentId, `Window accounting ${ctx.nonce}`);
    await claimTask(ctx, agentId, taskId);
    const sessionId = `window-cost-${ctx.nonce}`;
    const body = {
      sessionId,
      agentId,
      taskId,
      totalCostUsd: 0,
      provider: "codex",
      harness: "codex",
      credentialKeyType: keyType,
      credentialKeySuffix: keySuffix,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 40,
      reasoningOutputTokens: 7,
      model: "gpt-6",
      durationMs: 7200000,
      numTurns: 1,
    };
    for (let i = 0; i < 2; i++) {
      expectStatus(
        await ctx.api("POST", "/api/session-costs", { body }),
        [201],
        "idempotent cost report",
      );
    }
    expectStatus(
      await ctx.api("POST", "/api/session-costs", {
        body: {
          ...body,
          sessionId: `${sessionId}-retry`,
          isError: true,
        },
      }),
      [201],
      "retry cost report",
    );
    expectStatus(
      await ctx.api("POST", `/api/tasks/${taskId}/finish`, {
        agentId,
        body: { status: "completed", output: "Window fixture complete" },
      }),
      [200],
      "complete attributed task",
    );
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    expectStatus(
      await ctx.api("POST", "/api/keys/report-rate-limit-windows", {
        body: {
          keyType,
          keySuffix,
          keyIndex: 0,
          windows: {
            "codex:codex:primary": {
              source: "codex",
              limitId: "codex",
              status: "allowed",
              durationMins: 120,
              resetsAt,
              lastSeenAt: new Date().toISOString(),
            },
            unknown: {
              source: "codex",
              status: "allowed",
              resetsAt,
              lastSeenAt: new Date().toISOString(),
            },
            expired: {
              source: "codex",
              status: "allowed",
              durationMins: 120,
              resetsAt: Math.floor(Date.now() / 1000) - 10,
              lastSeenAt: new Date().toISOString(),
            },
          },
        },
      }),
      [200],
      "report current and unavailable windows",
    );
    const response = await ctx.api("GET", `${path}?keyType=${keyType}`);
    expectStatus(response, [200], "read window usage");
    const result = asRecord(response.json);
    expect(
      result.success === true && result.accounting === "session_cost_receipt_time",
      "receipt accounting contract",
    );
    const windows = asRecords(result, "windows");
    expect(windows.length === 2, "expired window is absent");
    const current = windows.find((window) => window.windowKey === "codex:codex:primary")!;
    expect(
      Date.parse(String(current.endsAt)) - Date.parse(String(current.startsAt)) === 7200000,
      "reset anchored bounds",
    );
    expect(
      Date.parse(String(current.dataThrough)) <= Date.parse(String(result.asOf)),
      "data bound does not exceed query time",
    );
    const usage = asRecord(current.usage);
    expect(
      usage.sessions === 2 && usage.errorSessions === 1 && usage.completedTasks === 1,
      "retries count one completed task",
    );
    const tokens = asRecord(usage.tokens);
    expect(
      asRecord(tokens.uncachedInput).value === 120 && asRecord(tokens.cacheRead).value === 80,
      "Codex cache is counted once",
    );
    expect(
      asRecord(tokens.cacheWrite).value === null &&
        asRecord(tokens.cacheWrite).missingSessions === 2,
      "missing cache writes remain unknown",
    );
    expect(asRecord(tokens.reasoning).value === 14, "reasoning remains separate");
    expect(
      windows.find((window) => window.windowKey === "unknown")?.usage === null,
      "unknown duration has no usage estimate",
    );
    expectStatus(
      await ctx.api("GET", `${path}?keyType=${keyType}&keySuffix=absent`),
      [200],
      "filter absent credential",
    );
    const empty = await ctx.api("GET", `${path}?keyType=${keyType}&scope=agent&scopeId=${agentId}`);
    expect(asRecords(empty.json, "windows").length === 0, "scope does not reuse global cache");
    expectStatus(
      await ctx.api("POST", "/api/keys/report-rate-limit-windows", {
        body: {
          keyType,
          keySuffix,
          keyIndex: 0,
          windows: Object.fromEntries(
            Array.from({ length: 65 }, (_, index) => [
              `custom-${index}`,
              { status: "allowed", lastSeenAt: new Date().toISOString() },
            ]),
          ),
        },
      }),
      [400],
      "reject oversized telemetry maps",
    );
    expectStatus(
      await ctx.api("POST", "/api/keys/report-rate-limit-windows", {
        body: {
          keyType,
          keySuffix,
          keyIndex: 0,
          windows: {
            "codex:codex:primary": {
              source: "codex",
              limitId: "codex",
              status: "allowed",
              durationMins: 576000,
              resetsAt,
              lastSeenAt: new Date().toISOString(),
            },
          },
        },
      }),
      [200],
      "retain long provider display windows",
    );
    const oversized = await ctx.api("GET", `${path}?keyType=${keyType}`);
    expectStatus(oversized, [422], "reject oversized lookback without partial usage");
    expect(
      !("windows" in asRecord(oversized.json)),
      "an incomplete total never appears as complete",
    );
    expectStatus(
      await ctx.api("POST", "/api/keys/report-rate-limit-windows", {
        body: {
          keyType,
          keySuffix,
          keyIndex: 0,
          windows: {
            "codex:codex:primary": {
              source: "codex",
              limitId: "codex",
              status: "allowed",
              durationMins: 120,
              resetsAt,
              lastSeenAt: new Date().toISOString(),
            },
          },
        },
      }),
      [200],
      "restore ordinary usage bounds for later scenarios",
    );
    await retireAgent(ctx, agentId);
  },
};

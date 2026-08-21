import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type CodexHookConfig,
  handleCodexHookEvent,
  resolveCodexHookConfig,
} from "../hooks/codex-hook";
import type { SteeringMessage } from "../types";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const config: CodexHookConfig = {
  apiUrl: "http://steering.test",
  apiKey: "test-key",
  agentId: "11111111-1111-4111-8111-111111111111",
};

const enabledEnv = { STEERING_ENABLED: "true" };

function message(overrides: Partial<SteeringMessage> = {}): SteeringMessage {
  return {
    id: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    body: "change course now",
    mode: "queue",
    status: "pending",
    source: "api",
    createdByKind: "system",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Fake fetch capturing delivered-POSTs; `failDeliveredFor` simulates a
 * delivered-callback outage for specific message IDs.
 */
function fakeFetch(
  messages: SteeringMessage[],
  options: { failDeliveredFor?: string[]; deliveredCalls?: string[] } = {},
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.includes("/delivered")) {
      const id = url.split("/").at(-2) ?? "";
      if (options.failDeliveredFor?.includes(id)) {
        return new Response("{}", { status: 500 });
      }
      options.deliveredCalls?.push(id);
      return new Response("{}", { status: 200 });
    }
    if (url.endsWith("/api/steering-messages")) {
      return Response.json({ messages });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

// The delivery envelope resolves through the prompt template registry; no
// STEERING_ENABLED in process.env is needed (the hook takes env explicitly),
// but pin it anyway so ambient state can't flip mid-suite.
const originalSteeringEnabled = process.env.STEERING_ENABLED;
beforeAll(() => {
  delete process.env.STEERING_ENABLED;
});
afterAll(() => {
  if (originalSteeringEnabled === undefined) delete process.env.STEERING_ENABLED;
  else process.env.STEERING_ENABLED = originalSteeringEnabled;
});

describe("codex steering hook", () => {
  test(
    "standalone hook rendering loads the delivery template defaults",
    async () => {
      const steeringMessageId = crypto.randomUUID();
      const moduleUrl = new URL("../prompts/steering-delivery.ts", import.meta.url).href;
      const script = [
        `import { renderSteeringDelivery } from ${JSON.stringify(moduleUrl)};`,
        `console.log(await renderSteeringDelivery(${JSON.stringify(steeringMessageId)}, "change course now"));`,
      ].join("\n");
      const result = await runChild([process.execPath, "-e", script]);
      expectChildOk(result, "steering-delivery render probe");

      expect(result.stdout).toContain(`[steering ${steeringMessageId}]`);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test("PostToolUse injects the envelope and marks the row delivered first", async () => {
    const pending = message();
    const deliveredCalls: string[] = [];
    const output = await handleCodexHookEvent(
      { hook_event_name: "PostToolUse" },
      config,
      enabledEnv,
      fakeFetch([pending], { deliveredCalls }),
    );

    expect(deliveredCalls).toEqual([pending.id]);
    const hookOutput = output?.hookSpecificOutput as {
      hookEventName: string;
      additionalContext: string;
    };
    expect(hookOutput.hookEventName).toBe("PostToolUse");
    expect(hookOutput.additionalContext).toContain(pending.body);
    expect(hookOutput.additionalContext).toContain(`[steering ${pending.id}]`);
    expect(hookOutput.additionalContext).toContain("accept-steer");
  });

  test("SessionStart delivers pre-start queued rows the same way", async () => {
    const pending = message();
    const output = await handleCodexHookEvent(
      { hook_event_name: "SessionStart" },
      config,
      enabledEnv,
      fakeFetch([pending]),
    );
    expect((output?.hookSpecificOutput as { hookEventName: string }).hookEventName).toBe(
      "SessionStart",
    );
  });

  test("Stop blocks with the envelope so a finishing session still receives it", async () => {
    const pending = message();
    const deliveredCalls: string[] = [];
    const output = await handleCodexHookEvent(
      { hook_event_name: "Stop" },
      config,
      enabledEnv,
      fakeFetch([pending], { deliveredCalls }),
    );

    expect(output?.decision).toBe("block");
    expect(String(output?.reason)).toContain(pending.body);
    // The block marks rows delivered, so a subsequent Stop finds nothing and
    // lets the session end — no block loop.
    expect(deliveredCalls).toEqual([pending.id]);
    const second = await handleCodexHookEvent(
      { hook_event_name: "Stop", stop_hook_active: true },
      config,
      enabledEnv,
      fakeFetch([]),
    );
    expect(second).toBeNull();
  });

  test("one-shot: a failed delivered-POST withholds the message for retry", async () => {
    const pending = message();
    const output = await handleCodexHookEvent(
      { hook_event_name: "PostToolUse" },
      config,
      enabledEnv,
      fakeFetch([pending], { failDeliveredFor: [pending.id] }),
    );
    // Not injected this round — the row is still pending server-side and the
    // next lifecycle event retries, so the agent never sees a half-delivered
    // duplicate.
    expect(output).toBeNull();
  });

  test("non-pending rows and unrelated events are ignored", async () => {
    const rows = [message({ status: "delivered" }), message({ status: "handled" })];
    expect(
      await handleCodexHookEvent(
        { hook_event_name: "PostToolUse" },
        config,
        enabledEnv,
        fakeFetch(rows),
      ),
    ).toBeNull();
    expect(
      await handleCodexHookEvent(
        { hook_event_name: "PreToolUse" },
        config,
        enabledEnv,
        fakeFetch([message()]),
      ),
    ).toBeNull();
  });

  test("no-ops when steering is disabled or config is missing", async () => {
    expect(
      await handleCodexHookEvent(
        { hook_event_name: "PostToolUse" },
        config,
        { STEERING_ENABLED: "false" },
        fakeFetch([message()]),
      ),
    ).toBeNull();
    expect(
      await handleCodexHookEvent(
        { hook_event_name: "PostToolUse" },
        null,
        enabledEnv,
        fakeFetch([message()]),
      ),
    ).toBeNull();
  });

  test("API failure yields silence, never a harness-visible error", async () => {
    const failingFetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(
      await handleCodexHookEvent(
        { hook_event_name: "PostToolUse" },
        config,
        enabledEnv,
        failingFetch,
      ),
    ).toBeNull();
  });

  test("resolveCodexHookConfig requires agent id, key, and url", () => {
    expect(
      resolveCodexHookConfig({
        AGENT_ID: config.agentId,
        AGENT_SWARM_API_KEY: "k",
      }),
    ).toMatchObject({ agentId: config.agentId, apiKey: "k" });
    expect(resolveCodexHookConfig({ AGENT_SWARM_API_KEY: "k" })).toBeNull();
    expect(resolveCodexHookConfig({ AGENT_ID: config.agentId })).toBeNull();
  });
});

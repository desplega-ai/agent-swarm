import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

// The Slack client the executor sees. Tests set it, or set it after a delay to
// model a server whose Slack client is not up yet.
type FakeApp = { client: { chat: { postMessage: (args: unknown) => Promise<{ ts: string }> } } };
let currentApp: FakeApp | null = null;
const posted: unknown[] = [];

mock.module("../slack/app", () => ({
  getSlackApp: () => currentApp,
}));

import type { ExecutorMeta } from "../types";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { _setNotifySlackReadyWaitForTests, NotifyExecutor } from "../workflows/executors/notify";

const SLACK_ENV_KEYS = ["SLACK_DISABLE", "SLACK_MODE", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
const savedEnv: Record<string, string | undefined> = {};

function fakeApp(): FakeApp {
  return {
    client: {
      chat: {
        postMessage: async (args: unknown) => {
          posted.push(args);
          return { ts: "1700000000.000100" };
        },
      },
    },
  };
}

function configureSlack(configured: boolean): void {
  for (const key of SLACK_ENV_KEYS) delete process.env[key];
  if (configured) {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
  }
}

const deps = {
  db: {},
  eventBus: { emit: () => {}, on: () => {}, off: () => {} },
  interpolate: (template: string) => template,
} as unknown as ExecutorDependencies;

const executor = new NotifyExecutor(deps);

function run(signal?: AbortSignal) {
  const meta: ExecutorMeta = {
    runId: "00000000-0000-0000-0000-000000000001",
    stepId: "00000000-0000-0000-0000-000000000002",
    nodeId: "notify",
    workflowId: "00000000-0000-0000-0000-000000000003",
    dryRun: false,
    ...(signal ? { signal } : {}),
  };
  return executor.run({
    config: { channel: "slack", target: "C123", template: "drift alert" },
    context: {},
    meta,
  });
}

beforeAll(() => {
  for (const key of SLACK_ENV_KEYS) savedEnv[key] = process.env[key];
  _setNotifySlackReadyWaitForTests({ timeoutMs: 400, pollMs: 10 });
});

afterEach(() => {
  currentApp = null;
  posted.length = 0;
});

afterAll(() => {
  for (const key of SLACK_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  _setNotifySlackReadyWaitForTests({ timeoutMs: 25_000, pollMs: 250 });
});

describe("NotifyExecutor slack readiness", () => {
  test("Slack not configured: success with sent=false, no wait", async () => {
    configureSlack(false);
    const started = Date.now();
    const result = await run();
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({ sent: false, message: "drift alert" });
    expect(Date.now() - started).toBeLessThan(200);
    expect(posted).toHaveLength(0);
  });

  test("Slack configured and ready: posts", async () => {
    configureSlack(true);
    currentApp = fakeApp();
    const result = await run();
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({ sent: true, messageId: "1700000000.000100" });
    expect(posted).toHaveLength(1);
  });

  test("Slack configured but not ready yet: waits for the client, then posts", async () => {
    configureSlack(true);
    const timer = setTimeout(() => {
      currentApp = fakeApp();
    }, 50);
    try {
      const result = await run();
      expect(result.status).toBe("success");
      expect(result.output).toMatchObject({ sent: true, message: "drift alert" });
      expect(posted).toEqual([
        { channel: "C123", text: "drift alert", unfurl_links: false, unfurl_media: false },
      ]);
    } finally {
      clearTimeout(timer);
    }
  });

  test("Slack configured but never ready: fails instead of reporting success", async () => {
    configureSlack(true);
    const result = await run();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Slack is configured but its client was not ready");
    expect(result.output).toBeUndefined();
    expect(posted).toHaveLength(0);
  });

  test("Slack configured, step deadline aborts the wait: fails early", async () => {
    configureSlack(true);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const result = await run(controller.signal);
    expect(result.status).toBe("failed");
    expect(Date.now() - started).toBeLessThan(300);
    expect(posted).toHaveLength(0);
  });

  test("Slack becomes ready after the deadline aborts but before the next poll: does not post", async () => {
    configureSlack(true);
    // One long poll interval, so the abort and the readiness both land inside
    // the same sleep.
    _setNotifySlackReadyWaitForTests({ pollMs: 150 });
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 20);
    const readyTimer = setTimeout(() => {
      currentApp = fakeApp();
    }, 60);
    try {
      const result = await run(controller.signal);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("Step deadline reached");
      expect(posted).toHaveLength(0);
    } finally {
      clearTimeout(abortTimer);
      clearTimeout(readyTimer);
      _setNotifySlackReadyWaitForTests({ pollMs: 10 });
    }
  });
});

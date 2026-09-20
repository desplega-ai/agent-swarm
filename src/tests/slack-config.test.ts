import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { startSlackMock, stopSlackMock } from "../../scripts/e2e/slack";
import { closeDb, initDb } from "../be/db";
import { getEnabledCapabilities } from "../server";
import { getSlackApp, startSlackApp, stopSlackApp } from "../slack/app";
import { getSlackConfiguration, isSlackConfigured } from "../slack/config";

const SLACK_ENV_KEYS = [
  "NODE_ENV",
  "SLACK_ALLOW_DEV_SOCKET_MODE",
  "CAPABILITIES",
  "SLACK_MODE",
  "SLACK_DISABLE",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_API_URL",
] as const;
const originalEnv = new Map(SLACK_ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of SLACK_ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV = "test";
  process.env.SLACK_DISABLE = "false";
});

afterEach(async () => {
  await stopSlackApp();
  for (const key of SLACK_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Slack transport configuration", () => {
  test("defaults to Socket Mode and requires the existing token pair", () => {
    expect(getSlackConfiguration({})).toEqual({
      disabled: false,
      mode: "socket",
      missingCredentials: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    });
    expect(getEnabledCapabilities()).toContain("slack");
    expect(isSlackConfigured({ SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-test" })).toBe(
      true,
    );
  });

  test("HTTP mode requires bot and signing credentials without an app token", () => {
    const env = {
      SLACK_MODE: "http",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "synthetic-signing-secret",
    };
    expect(getSlackConfiguration(env)).toEqual({
      disabled: false,
      mode: "http",
      missingCredentials: [],
    });
    expect(isSlackConfigured(env)).toBe(true);
  });

  test("disabled and invalid configurations fail closed", () => {
    expect(
      isSlackConfigured({
        SLACK_DISABLE: "true",
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
      }),
    ).toBe(false);
    expect(
      getSlackConfiguration({
        SLACK_MODE: "webhook",
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
      }),
    ).toMatchObject({ mode: null });
  });

  test("HTTP selection remains unavailable and never creates a socket app", async () => {
    process.env.SLACK_MODE = "http";
    expect(getEnabledCapabilities()).not.toContain("slack");
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_SIGNING_SECRET = "synthetic-signing-secret";
    delete process.env.SLACK_APP_TOKEN;

    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await startSlackApp()).toBe(false);
      expect(getSlackApp()).toBeNull();
      expect(error).toHaveBeenCalledWith(
        "[Slack] HTTP mode is configured but unavailable until the HTTP receiver is installed",
      );
    } finally {
      error.mockRestore();
    }
  });
});

test.each([
  "disabled",
  "invalid mode",
  "missing credentials",
  "HTTP unavailable",
  "socket blocked",
])("failed init is retryable without stop: %s", async (reason) => {
  const slack = await startSlackMock(false);
  initDb(":memory:");
  try {
    Object.assign(process.env, slack.mock.env);
    process.env.SLACK_SIGNING_SECRET = "synthetic-signing-secret";
    if (reason === "disabled") process.env.SLACK_DISABLE = "true";
    if (reason === "invalid mode") process.env.SLACK_MODE = "invalid";
    if (reason === "missing credentials") delete process.env.SLACK_APP_TOKEN;
    if (reason === "HTTP unavailable") process.env.SLACK_MODE = "http";
    if (reason === "socket blocked") process.env.NODE_ENV = "development";

    expect(await startSlackApp()).toBe(false);
    expect(getSlackApp()).toBeNull();
    expect(slack.mock.apiCalls("apps.connections.open")).toHaveLength(0);

    Object.assign(process.env, slack.mock.env);
    process.env.SLACK_DISABLE = "false";
    process.env.SLACK_MODE = "socket";
    process.env.NODE_ENV = "test";
    // Deliberately retry without stopSlackApp: failed initialization must not latch.
    expect(await startSlackApp()).toBe(true);
    await slack.mock.waitForConnection(10_000);
    expect(slack.mock.connectionCount).toBe(1);
    expect(slack.mock.apiCalls("apps.connections.open")).toHaveLength(1);
  } finally {
    await stopSlackApp();
    await stopSlackMock(slack, false);
    closeDb();
  }
}, 20_000);

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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

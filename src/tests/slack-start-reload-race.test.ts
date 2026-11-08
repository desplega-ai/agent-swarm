/**
 * The boot-time startSlackApp() runs outside the Slack lifecycle lock, so a
 * config reload can land while it is still awaiting. The reload detaches that
 * app and builds a new one; the overtaken start must never break the new app.
 * Before the fix, the boot start finished Bolt init on the detached app and
 * marked the reload's new app as initialized, so its app.start() threw and
 * POST /api/config/reload answered 500.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startSlackMock, stopSlackMock } from "../../scripts/e2e/slack";
import { closeDb, initDb } from "../be/db";
import { reloadGlobalConfigsAndIntegrations } from "../http/core";
import { getSlackHttpReceiver, startSlackApp, stopSlackApp } from "../slack/app";
import { getSlackConnectionState } from "../slack/connection-state";

const ENV_KEYS = [
  "SLACK_MODE",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_API_URL",
  "SLACK_DISABLE",
  "AGENTMAIL_DISABLE",
  "GITHUB_DISABLE",
  "JIRA_DISABLE",
  "LINEAR_DISABLE",
] as const;
const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeAll(() => {
  initDb(":memory:");
  for (const key of ["AGENTMAIL_DISABLE", "GITHUB_DISABLE", "JIRA_DISABLE", "LINEAR_DISABLE"]) {
    process.env[key] = "true";
  }
});

afterAll(() => {
  closeDb();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("a reload that overtakes the boot-time Slack start in HTTP mode still starts Slack", async () => {
  const slack = await startSlackMock(false);
  try {
    Object.assign(process.env, slack.mock.env);
    process.env.SLACK_MODE = "http";
    process.env.SLACK_SIGNING_SECRET = "synthetic-signing-secret";
    process.env.SLACK_DISABLE = "false";
    // Each offset lands the reload at a different await of the boot start.
    for (const delayMs of [0, 0, 1, 1, 2, 3, 5, 8, 13]) {
      const boot = startSlackApp();
      if (delayMs) await Bun.sleep(delayMs);
      const result = await reloadGlobalConfigsAndIntegrations();
      expect(result.integrationsReinitialized).toContain("slack");
      await boot;
      expect(getSlackHttpReceiver()).not.toBeNull();
      expect(getSlackConnectionState()).toBe("connected");
      await stopSlackApp();
    }
  } finally {
    await stopSlackApp();
    await stopSlackMock(slack, false);
  }
}, 60_000);

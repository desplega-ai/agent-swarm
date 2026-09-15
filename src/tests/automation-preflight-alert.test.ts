import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { notifyAutomationPreflightFailure } from "../automation-preflight-alert";
import type { AutomationPreflightResult } from "../be/automation-preflight";
import * as slack from "../slack/app";
import { registerVolatileSecret } from "../utils/secret-scrubber";

const savedEnv = { ...process.env };
const preflight: AutomationPreflightResult = {
  id: "test-schedule",
  kind: "schedule",
  name: "daily-report",
  state: "needs_setup",
  missing: { params: ["REPORT_NAME", "REPO_URL"], integrations: ["github", "slack"] },
  fixes: [],
  fixUrl: "/schedules/test-schedule?param=REPORT_NAME",
};
const postMessage = mock(async (_message: unknown) => ({ ok: true }));

beforeEach(() => {
  process.env.SLACK_ALERTS_CHANNEL = "C_TEST_ALERTS";
  process.env.APP_URL = "https://dashboard.example.com/";
  postMessage.mockReset();
  postMessage.mockResolvedValue({ ok: true });
  spyOn(slack, "getSlackApp").mockReturnValue({
    client: { chat: { postMessage } },
  } as unknown as NonNullable<ReturnType<typeof slack.getSlackApp>>);
});

afterEach(() => {
  mock.restore();
  process.env = { ...savedEnv };
});

describe("Automation preflight alerts", () => {
  test("skips Slack notification when alerts channel env is unset", async () => {
    delete process.env.SLACK_ALERTS_CHANNEL;
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    await expect(notifyAutomationPreflightFailure(preflight)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "[Automation Preflight] SLACK_ALERTS_CHANNEL not set; skipping alert",
    );
    expect(slack.getSlackApp).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("posts the skipped automation, missing setup, and dashboard fix link", async () => {
    await notifyAutomationPreflightFailure(preflight);

    expect(postMessage).toHaveBeenCalledWith({
      channel: "C_TEST_ALERTS",
      text:
        '⚠️ Automation needs setup\nAutomation: schedule "daily-report"\n' +
        "Missing params: REPORT_NAME, REPO_URL\nMissing integrations: github, slack\n" +
        "Fire SKIPPED. It was not retried or queued.\n" +
        "Fix setup: https://dashboard.example.com/schedules/test-schedule?param=REPORT_NAME",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  test("skips Slack notification when the app is unavailable", async () => {
    spyOn(slack, "getSlackApp").mockReturnValue(null);
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    await expect(notifyAutomationPreflightFailure(preflight)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "[Automation Preflight] Slack not available, cannot send notification",
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("scrubs alert text and logs Slack failures without throwing", async () => {
    const secret = "example-preflight-alert-sensitive-fixture";
    registerVolatileSecret(secret, "PREFLIGHT_TEST_SECRET");
    postMessage.mockRejectedValueOnce(new Error(`Slack failed: ${secret}`));
    const error = spyOn(console, "error").mockImplementation(() => {});

    await expect(
      notifyAutomationPreflightFailure({ ...preflight, name: secret }),
    ).resolves.toBeUndefined();

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain(secret);
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).toContain("Slack failed:");
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
  });
});

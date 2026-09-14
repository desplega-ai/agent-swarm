import type { AutomationPreflightResult } from "./be/automation-preflight";
import { getAppUrl } from "./utils/constants";
import { scrubSecrets } from "./utils/secret-scrubber";

/** Best-effort alert; callers gate this on a newly recorded preflight refusal. */
export async function notifyAutomationPreflightFailure(
  preflight: AutomationPreflightResult,
): Promise<void> {
  const channel = process.env.SLACK_ALERTS_CHANNEL?.trim();
  if (!channel) {
    console.warn("[Automation Preflight] SLACK_ALERTS_CHANNEL not set; skipping alert");
    return;
  }

  try {
    const { getSlackApp } = await import("./slack/app");
    const app = getSlackApp();
    if (!app) {
      console.warn("[Automation Preflight] Slack not available, cannot send notification");
      return;
    }
    await app.client.chat.postMessage({
      channel,
      text: scrubSecrets(
        `⚠️ Automation needs setup\n` +
          `Automation: ${preflight.kind} "${preflight.name}"\n` +
          `Missing params: ${preflight.missing.params.join(", ") || "none"}\n` +
          `Missing integrations: ${preflight.missing.integrations.join(", ") || "none"}\n` +
          `Fire SKIPPED. It was not retried or queued.\n` +
          `Fix setup: ${getAppUrl()}${preflight.fixUrl}`,
      ),
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    console.error(
      "[Automation Preflight] Failed to send Slack notification:",
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
  }
}

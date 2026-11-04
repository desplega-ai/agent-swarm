import type { App } from "@slack/bolt";
import { z } from "zod";
import { isSlackConfigured } from "../../slack/config";
import type { ExecutorMeta } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { BaseExecutor, type ExecutorResult } from "./base";

// ─── Slack readiness wait ───────────────────────────────────

/**
 * How long a Slack notify waits for a configured but not yet initialized
 * client. Kept under the default 30s node watchdog (`DEFAULT_NODE_TIMEOUT_MS`)
 * so the step fails with this executor's error rather than a bare timeout.
 */
const slackReadyWait = { timeoutMs: 25_000, pollMs: 250 };

/** Test seam: shrink the readiness wait. */
export function _setNotifySlackReadyWaitForTests(opts: {
  timeoutMs?: number;
  pollMs?: number;
}): void {
  if (opts.timeoutMs !== undefined) slackReadyWait.timeoutMs = opts.timeoutMs;
  if (opts.pollMs !== undefined) slackReadyWait.pollMs = opts.pollMs;
}

/** Poll for the Slack client until it exists, the wait runs out, or `signal` aborts. */
async function waitForSlackApp(
  getApp: () => App | null,
  signal: AbortSignal | undefined,
): Promise<App | null> {
  const deadline = Date.now() + slackReadyWait.timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    await Bun.sleep(Math.min(slackReadyWait.pollMs, Math.max(0, deadline - Date.now())));
    // The deadline may have fired during the sleep. Posting now would land
    // after the engine marked the step failed, and a retry would post again.
    if (signal?.aborted) return null;
    const app = getApp();
    if (app) return app;
  }
  return null;
}

// ─── Schemas ────────────────────────────────────────────────

export const NotifyConfigSchema = z.object({
  channel: z.enum(["swarm", "slack", "email"]),
  target: z.string().optional(),
  template: z.string(),
});

export const NotifyOutputSchema = z.object({
  sent: z.boolean(),
  messageId: z.string().optional(),
  message: z.string(),
});

// ─── Executor ───────────────────────────────────────────────

export class NotifyExecutor extends BaseExecutor<
  typeof NotifyConfigSchema,
  typeof NotifyOutputSchema
> {
  readonly type = "notify";
  readonly mode = "instant" as const;
  readonly configSchema = NotifyConfigSchema;
  readonly outputSchema = NotifyOutputSchema;

  protected async execute(
    config: z.infer<typeof NotifyConfigSchema>,
    context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof NotifyOutputSchema>>> {
    // Scrub once: the message reaches Slack, the swarm channel, a log line and
    // the step output.
    const message = scrubSecrets(
      this.deps.interpolate(config.template, context as Record<string, unknown>),
    );

    switch (config.channel) {
      case "swarm": {
        if (!config.target) {
          return {
            status: "success",
            output: { sent: false, message },
          };
        }
        try {
          const result = await this.deps.db.postMessage(config.target, null, message);
          return {
            status: "success",
            output: { sent: true, messageId: result.id, message },
          };
        } catch (err) {
          return {
            status: "failed",
            error: `Failed to post swarm message: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      case "slack": {
        const { getSlackApp } = await import("../../slack/app");
        let app = getSlackApp();
        if (!app) {
          // No Slack on this install: nothing to post to, so not a failure.
          if (!isSlackConfigured()) {
            return {
              status: "success",
              output: { sent: false, message },
            };
          }
          // Slack is configured but its client is not up: the server is still
          // booting, shutting down, or reloading integrations. Reporting
          // success here would drop the message and hide it.
          app = await waitForSlackApp(getSlackApp, meta.signal);
          if (meta.signal?.aborted) {
            return {
              status: "failed",
              error: "Step deadline reached while waiting for the Slack client; message not sent",
            };
          }
          if (!app) {
            return {
              status: "failed",
              error: `Slack is configured but its client was not ready within ${slackReadyWait.timeoutMs}ms; message not sent`,
            };
          }
        }
        try {
          const result = await app.client.chat.postMessage({
            channel: config.target || "",
            text: message,
            unfurl_links: false,
            unfurl_media: false,
          });
          return {
            status: "success",
            output: { sent: true, messageId: result.ts || "", message },
          };
        } catch (err) {
          return {
            status: "failed",
            error: `Failed to post Slack message: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      case "email": {
        // Stub — real email integration comes later
        console.log(`[notify] Email stub — target: ${config.target}, message: ${message}`);
        return {
          status: "success",
          output: { sent: false, message },
        };
      }
    }
  }
}

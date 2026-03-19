import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import { BaseExecutor, type ExecutorResult } from "./base";

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
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof NotifyOutputSchema>>> {
    const message = this.deps.interpolate(config.template, context as Record<string, unknown>);

    switch (config.channel) {
      case "swarm": {
        if (!config.target) {
          return {
            status: "success",
            output: { sent: false, message },
          };
        }
        try {
          const result = this.deps.db.postMessage(config.target, null, message);
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
        const app = getSlackApp();
        if (!app) {
          return {
            status: "success",
            output: { sent: false, message },
          };
        }
        try {
          const result = await app.client.chat.postMessage({
            channel: config.target || "",
            text: message,
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

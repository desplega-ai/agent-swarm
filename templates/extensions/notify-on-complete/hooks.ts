import type { SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({
  channelId: z.string().min(1),
  includeFailed: z.boolean().default(true),
  maxOutputChars: z.number().int().min(40).max(2000).default(400),
});

const manifest = {
  name: "notify-on-complete",
  description: "Posts a short summary to a Slack channel when a task completes or fails",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("post.task.completed", async (event, ctx) => {
    const title = event.task.title ?? clip(event.task.task, 80);
    await ctx.swarm.slack_post({
      channelId: ctx.config.channelId,
      message: `:white_check_mark: *${title}* completed (task \`${event.task.id.slice(0, 8)}\`)\n${clip(event.output, ctx.config.maxOutputChars)}`,
    });
    await ctx.state.incr("notified:completed");
  });

  api.on("post.task.failed", async (event, ctx) => {
    if (!ctx.config.includeFailed) return;
    const title = event.task.title ?? clip(event.task.task, 80);
    await ctx.swarm.slack_post({
      channelId: ctx.config.channelId,
      message: `:x: *${title}* failed (task \`${event.task.id.slice(0, 8)}\`)\n${clip(event.failureReason, ctx.config.maxOutputChars)}`,
    });
    await ctx.state.incr("notified:failed");
  });
};

export default extension;

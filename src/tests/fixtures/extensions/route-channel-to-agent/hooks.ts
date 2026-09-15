import { modify, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({ channelId: z.string(), agentId: z.string() });

const manifest = {
  name: "route-channel-to-agent",
  description: "Routes one Slack channel to a configured agent",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.slack.route", (event, ctx) => {
    if (event.channelId !== ctx.config.channelId) return;
    return modify({ target: { kind: "agent", agentId: ctx.config.agentId } });
  });

  api.on("post.slack.message", async (event, ctx) => {
    await ctx.state.set(`slack:${event.channelId}`, event.userId);
  });
};

export default extension;

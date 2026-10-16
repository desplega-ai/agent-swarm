import { modify, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({ adapter: z.string(), channelId: z.string(), agentId: z.string() });

const manifest = {
  name: "route-chat-channel-to-agent",
  description: "Routes one Chat SDK channel to a configured agent",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.chat.route", (event, ctx) => {
    if (event.adapter !== ctx.config.adapter || event.channelId !== ctx.config.channelId) return;
    return modify({ target: { kind: "agent", agentId: ctx.config.agentId } });
  });

  api.on("post.chat.message", async (event, ctx) => {
    if (event.direction !== "inbound" || !event.userId) return;
    await ctx.state.set(`chat:${event.channelId}`, event.userId);
  });
};

export default extension;

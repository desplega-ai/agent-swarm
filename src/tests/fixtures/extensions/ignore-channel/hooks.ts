import type { SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({ channelId: z.string() });

const manifest = {
  name: "ignore-channel",
  description: "Ignores Slack messages in one configured channel",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.slack.route", (event, ctx) => {
    if (event.channelId !== ctx.config.channelId) return;
    return { action: "block", reason: "This channel is ignored" };
  });
};

export default extension;

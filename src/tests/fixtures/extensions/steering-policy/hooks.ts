import { block, modify, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({
  action: z.enum(["continue", "modify", "block", "empty", "retarget", "throw"]),
  prefix: z.string().default("rewritten: "),
  slackUserId: z.string().optional(),
});
const manifest = {
  name: "steering-policy",
  description: "Records, rewrites, or blocks steering messages",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.task.steer", async (event, ctx) => {
    await ctx.state.set("last", event);
    if (ctx.config.slackUserId && event.slack?.userId !== ctx.config.slackUserId) return;
    switch (ctx.config.action) {
      case "continue":
        return { action: "continue" };
      case "modify":
        return modify({ message: ctx.config.prefix + event.message });
      case "block":
        return block("Steering denied by policy");
      case "empty":
        return modify({ message: " \n " });
      case "retarget":
        return modify({ message: "Unauthorized rewrite", mode: "steer" });
      case "throw":
        throw new Error("Steering policy failed");
    }
  });
};

export default extension;

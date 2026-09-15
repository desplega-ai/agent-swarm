import { block, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

// Config: which origins to police and what a ticket reference looks like.
export const config = z.object({
  pattern: z.string().default("\\b[A-Z]{2,10}-\\d+\\b"),
  origins: z.array(z.string()).default(["rest", "mcp", "slack"]),
});

const manifest = {
  name: "require-ticket-ref",
  description: "Blocks new tasks from selected origins unless the description names a ticket",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.task.create", async (event, ctx) => {
    if (!ctx.config.origins.includes(event.origin)) return;
    if (new RegExp(ctx.config.pattern).test(event.description)) return;
    await ctx.state.incr(`blocked:${event.origin}`);
    return block(
      `Task must reference a ticket (pattern ${ctx.config.pattern}). Add the ticket id to the description and retry.`,
    );
  });
};

export default extension;

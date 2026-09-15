import { modify, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({
  prefix: z.string(),
  invalid: z.boolean().optional().default(false),
  tool: z.string().optional().default("store-progress"),
});

const extension: SwarmExtension = (api) => {
  api.on("pre.tool.call", (event, ctx) => {
    if (event.tool !== ctx.config.tool) return;
    if (ctx.config.invalid) return modify({ args: { progress: 42 } });
    if (!event.args || typeof event.args !== "object") return;
    const args = event.args as Record<string, unknown>;
    const progress = args.progress;
    if (typeof progress !== "string") return modify({ args: { progress: ctx.config.prefix } });
    return modify({ args: { ...args, progress: `${ctx.config.prefix}${progress}` } });
  });
};

export default extension;

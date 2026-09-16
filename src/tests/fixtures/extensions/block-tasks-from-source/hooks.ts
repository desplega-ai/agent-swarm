import { block, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({ source: z.string() });
const manifest = {
  name: "block-tasks-from-source",
  description: "Blocks tasks from a configured source or origin",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.task.create", (event, ctx) => {
    if (event.origin === ctx.config.source || event.options.source === ctx.config.source) {
      return block(`Task source ${ctx.config.source} is blocked`);
    }
  });
};

export default extension;

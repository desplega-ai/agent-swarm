import type { SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({});

const manifest = {
  name: "tool-call-probe",
  description:
    "Pass-through pre.tool.call hook that only counts calls. Measures which tool calls an extension gate can see.",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

// Never blocks or modifies. The dispatcher records every run (extension_runs: event,
// action, `tool <name>`, agent), which the evals runner reads back as coverage.
const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.tool.call", async (event, ctx) => {
    await ctx.state.incr(`calls:${event.tool}`);
  });
};

export default extension;

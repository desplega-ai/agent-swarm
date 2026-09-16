import { block, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({
  marker: z.string().min(1).default("Verified:"),
});

const manifest = {
  name: "require-verification-note",
  description: "Refuses task completion unless the output contains a verification line",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

type StoreProgressArgs = { status?: unknown; output?: unknown };

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.tool.call", (event, ctx) => {
    if (event.tool !== "store-progress") return;
    if (!event.args || typeof event.args !== "object") return;
    const { status, output } = event.args as StoreProgressArgs;
    if (status !== "completed") return;
    if (typeof output === "string" && output.includes(ctx.config.marker)) return;
    return block(
      `Completion output must contain a "${ctx.config.marker}" line that says how the result was checked. Add it and call store-progress again.`,
    );
  });
};

export default extension;

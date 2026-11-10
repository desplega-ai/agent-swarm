import { modify, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({
  echoArgs: z.boolean().optional().default(false),
});

type Seen = { event: string; payload: unknown }[];

const extension: SwarmExtension = (api) => {
  // In-process list, so the test reads exactly what the handler received (KV writes scrub again).
  const holder = globalThis as { __nativeToolSeen?: Seen };
  holder.__nativeToolSeen ??= [];
  const seen = holder.__nativeToolSeen;
  api.on("pre.tool.call", async (event, ctx) => {
    seen.push({ event: "pre", payload: event });
    await ctx.state.set("pre", event);
    if (ctx.config.echoArgs) return modify({ args: event.args });
  });
  api.on("post.tool.call", async (event, ctx) => {
    seen.push({ event: "post", payload: event });
    await ctx.state.set("post", event);
  });
};

export default extension;

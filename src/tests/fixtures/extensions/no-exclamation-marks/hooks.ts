import { block, type SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = (api) => {
  api.on("pre.tool.call", (event) => {
    if (event.tool !== "store-progress") return;
    if (!event.args || typeof event.args !== "object") return;
    const progress = (event.args as { progress?: unknown }).progress;
    if (typeof progress === "string" && progress.includes("!")) {
      return block("Progress text must not contain exclamation marks.");
    }
  });

  api.on("post.tool.call", async (event, ctx) => {
    await ctx.state.set("last-post", {
      tool: event.tool,
      args: event.args,
      result: event.result,
      durationMs: event.durationMs,
    });
  });
};

export default extension;

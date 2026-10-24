import type { SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = (api) => {
  api.on("post.task.blocked", async (event, ctx) => {
    await ctx.state.set("last", event);
    await ctx.state.incr("count");
  });
};

export default extension;

import type { SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = (api) => {
  api.on("post.task.created", async (_event, ctx) => {
    await ctx.state.incr("created");
  });
};

export default extension;

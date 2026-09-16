import type { SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", async (_event, ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await ctx.state.incr("after-timeout");
  });
};

export default extension;

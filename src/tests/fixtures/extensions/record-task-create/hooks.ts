import type { SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", async (event, ctx) => {
    await ctx.state.set("last", event);
  });
};

export default extension;

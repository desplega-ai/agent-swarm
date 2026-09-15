import type { SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => ({ action: "continue" }));
};

export default extension;

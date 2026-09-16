import { modify, type SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => modify({ priority: 1 }));
};

export default extension;

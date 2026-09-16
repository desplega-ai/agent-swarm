import { modify, type SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", (event) => modify({ description: `${event.description}b` }));
};

export default extension;

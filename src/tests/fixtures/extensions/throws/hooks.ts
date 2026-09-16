import type { SwarmExtension } from "swarm-extension";

const fail = () => {
  throw new Error("fixture failure");
};

const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", fail);
  api.on("post.task.created", fail);
};

export default extension;

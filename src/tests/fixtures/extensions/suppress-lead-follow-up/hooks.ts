import { block, type SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = (api) => {
  api.on("pre.task.followUp", (event) => {
    if (event.completedTask.source === "slack") {
      return block("Slack tasks report in the original thread");
    }
  });
  api.on("pre.task.create", () => undefined);
};

export default extension;

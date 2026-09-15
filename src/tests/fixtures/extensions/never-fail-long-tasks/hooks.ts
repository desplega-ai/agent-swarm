import { modify, type SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = (api) => {
  api.on("pre.heartbeat.remediate", (event) => {
    if (event.proposedAction === "fail") {
      return modify({ proposedAction: "record" });
    }
  });
};

export default extension;

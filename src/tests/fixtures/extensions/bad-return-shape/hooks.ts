import type { SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = (api) => {
  api.on("pre.slack.route", () => ({
    action: "modify",
    data: { target: { kind: "agent" } },
  }));
};

export default extension;

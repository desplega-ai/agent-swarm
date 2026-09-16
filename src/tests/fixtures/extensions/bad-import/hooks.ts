import fs from "node:fs";
import type { SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = () => {
  void fs;
};

export default extension;

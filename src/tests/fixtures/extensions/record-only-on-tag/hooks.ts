import { block, type ExtensionManifest, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({ tag: z.string() });

type Manifest = ExtensionManifest & { runtime: "api"; config: typeof config };

const extension: SwarmExtension<Manifest> = (api) => {
  api.on("pre.heartbeat.remediate", (event, ctx) => {
    if (event.task.tags.includes(ctx.config.tag)) {
      return block(`Heartbeat remediation blocked for tag ${ctx.config.tag}`);
    }
  });
};

export default extension;

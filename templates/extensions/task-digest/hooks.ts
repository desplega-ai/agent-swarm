import type { SwarmExtension } from "swarm-extension";

const manifest = {
  name: "task-digest",
  description: "Daily digest of tasks completed and failed in the last 24 hours",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
} as const;

// Keep a running count between digests; the scheduled script reads task history
// directly, this counter is only a cheap live signal in the extension state.
const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("post.task.completed", async (_event, ctx) => {
    await ctx.state.incr("completed");
  });
  api.on("post.task.failed", async (_event, ctx) => {
    await ctx.state.incr("failed");
  });
};

export default extension;

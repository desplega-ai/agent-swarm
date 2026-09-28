import { block, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({
  internal: z.array(z.string()).default([]),
  external: z.array(z.string()).default([]),
  exemptTaskTypes: z.array(z.string()).default(["github-review"]),
});

const manifest = {
  name: "github-sender-allowlist",
  description: "Blocks GitHub webhook tasks from senders outside configured allowlists",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

function includesLogin(logins: string[], login: string): boolean {
  return logins.some((allowed) => allowed.toLowerCase() === login.toLowerCase());
}

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.task.create", (event, ctx) => {
    const { options } = event;
    if (options.source !== "github") return;

    const taskType = options.taskType ?? "unknown";
    if (ctx.config.exemptTaskTypes.includes(taskType)) return;

    const login = options.vcsAuthor ?? "";
    if (includesLogin(ctx.config.internal, login)) return;

    const isPullRequest = options.vcsUrl?.includes("/pull/") ?? false;
    const isExternalPullRequestTask =
      (taskType === "github-comment" || taskType === "github-pr") && isPullRequest;
    const isExternalSender = includesLogin(ctx.config.external, login);
    if (isExternalSender && isExternalPullRequestTask) return;

    const rule = isExternalSender
      ? "external senders are allowed only for PR comments and github-pr tasks on pull requests"
      : "sender is not on the internal or external allowlist";
    const reason = `GitHub sender "${login || "unknown"}" is blocked: ${rule}.`;
    ctx.log.warn(reason, { login: login || null, taskType, vcsUrl: options.vcsUrl ?? null });
    return block(reason);
  });
};

export default extension;

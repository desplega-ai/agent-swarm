import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import { BaseExecutor, type ExecutorResult } from "./base";

// ─── Schemas ────────────────────────────────────────────────

export const VcsConfigSchema = z.object({
  action: z.enum(["create-issue", "create-pr", "comment"]),
  provider: z.enum(["github", "gitlab"]),
  repo: z.string(),
  title: z.string().optional(),
  body: z.string().optional(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
  issueNumber: z.number().optional(),
  prNumber: z.number().optional(),
});

export const VcsOutputSchema = z.object({
  url: z.string(),
  id: z.union([z.string(), z.number()]),
});

// ─── Executor ───────────────────────────────────────────────

export class VcsExecutor extends BaseExecutor<typeof VcsConfigSchema, typeof VcsOutputSchema> {
  readonly type = "vcs";
  readonly mode = "instant" as const;
  readonly configSchema = VcsConfigSchema;
  readonly outputSchema = VcsOutputSchema;

  protected async execute(
    config: z.infer<typeof VcsConfigSchema>,
    context: Readonly<Record<string, unknown>>,
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof VcsOutputSchema>>> {
    // Stub implementation — validate config and return mock output.
    // Real GitHub/GitLab integration will be added in a follow-up.
    const title = config.title
      ? this.deps.interpolate(config.title, context as Record<string, unknown>)
      : "";
    const body = config.body
      ? this.deps.interpolate(config.body, context as Record<string, unknown>)
      : "";

    console.log(
      `[vcs] Stub — ${config.action} on ${config.provider}/${config.repo}: title="${title}" body="${body.slice(0, 80)}"`,
    );

    const mockId = `stub-${Date.now()}`;
    const mockUrl = `https://${config.provider}.com/${config.repo}/${config.action}/${mockId}`;

    return {
      status: "success",
      output: { url: mockUrl, id: mockId },
    };
  }
}

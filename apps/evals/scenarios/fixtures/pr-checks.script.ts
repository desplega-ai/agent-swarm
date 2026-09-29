import { z } from "zod";

export const argsSchema = z.object({
  repository: z.string().describe("owner/name of the repository"),
  pullRequest: z.number().int().positive().describe("Pull request number"),
});

/**
 * Deterministic lint/check gate for a pull request. Seeded by the
 * workflow-authoring eval so the swarm-script node has a real catalog option.
 */
export default async function prChecks(args: unknown, _ctx: unknown) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) {
    return { passed: false, findings: [`invalid args: ${parsed.error.message}`] };
  }
  const { repository, pullRequest } = parsed.data;
  const findings: string[] = [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) findings.push("repository must be owner/name");
  return { passed: findings.length === 0, repository, pullRequest, findings };
}

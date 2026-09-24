import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

const NAMESPACE = "ext-self-driving";

export const argsSchema = z.object({
  overThreshold: z.boolean().nullable().optional(),
  cluster: z
    .object({
      id: z.string(),
      fingerprint: z.string(),
      repo: z.string().nullable(),
      title: z.string(),
      count: z.number(),
      proposedAt: z.string().nullable(),
      classification: z.record(z.string(), z.unknown()).nullable(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

/**
 * Describe the task the loop would create for a cluster past threshold.
 * Dry run in every mode: this script never calls task_send, opens a PR, or posts to Slack.
 */
export default async function propose(args: z.input<typeof argsSchema>, ctx: ScriptContext) {
  const cluster = args?.cluster;
  if (!cluster || !args?.overThreshold) {
    return { ok: true, dryRun: true, action: null, reason: "no cluster past threshold" };
  }

  const route = (cluster.classification?.route as string | undefined) ?? "human_review";
  const action = {
    type: "create_task",
    dispatched: false,
    title: `[self-driving] ${cluster.title}`.slice(0, 200),
    repo: cluster.repo,
    clusterId: cluster.id,
    route,
    description: `Cluster ${cluster.id} (${cluster.count} signals, fingerprint "${cluster.fingerprint}"). Route: ${route}.`,
  };

  // Mark the cluster so the sweep stops listing it. Keep the first proposal time.
  if (!cluster.proposedAt) {
    await ctx.swarm.kv_set({
      namespace: NAMESPACE,
      key: `cluster:${cluster.id}`,
      value: { ...cluster, proposedAt: new Date().toISOString() },
    });
  }
  await ctx.swarm.kv_set({ namespace: NAMESPACE, key: `proposal:${cluster.id}`, value: action });

  return { ok: true, dryRun: true, action };
}

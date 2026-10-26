/**
 * linear-delivery-setup: prepare a Linear team for the Linear Delivery Loop.
 *
 * Creates each missing workflow state and the opt-in project label, and writes
 * a starter config to KV when none exists. Idempotent: a second run creates
 * nothing. Dry run is the default and only reports what it would create.
 */
import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

const NAMESPACE = "linear-delivery-loop";

/** Same names and keys as DEFAULT_STATES in linear-delivery-tick. */
export const STATES: Array<{ key: string; name: string; type: string; color: string }> = [
  { key: "backlog", name: "Backlog", type: "backlog", color: "#bec2c8" },
  { key: "todo", name: "Todo", type: "unstarted", color: "#e2e2e2" },
  { key: "inProgress", name: "In Progress", type: "started", color: "#f2c94c" },
  { key: "pendingCi", name: "Pending CI", type: "started", color: "#f2994a" },
  { key: "ownerReview", name: "Ready for owner review", type: "started", color: "#5e6ad2" },
  { key: "externalReview", name: "External review required", type: "started", color: "#9b51e0" },
  { key: "applyingFeedback", name: "Applying feedback", type: "started", color: "#eb5757" },
  { key: "approved", name: "Approved", type: "started", color: "#27ae60" },
  { key: "humanAction", name: "Requires human action", type: "started", color: "#4f4f4f" },
  { key: "done", name: "Done", type: "completed", color: "#5e6ad2" },
  { key: "canceled", name: "Canceled", type: "canceled", color: "#95a2b3" },
  { key: "duplicate", name: "Duplicate", type: "duplicate", color: "#95a2b3" },
];

export const argsSchema = z.object({
  teamKey: z.string().min(1).describe("Linear team key, e.g. ENG"),
  dryRun: z.boolean().optional().describe("Default true. Pass false to create."),
  connection: z
    .string()
    .min(1)
    .optional()
    .describe("Linear GraphQL connection slug (default linear)"),
  projectLabel: z
    .string()
    .min(1)
    .optional()
    .describe("Opt-in project label (default delivery-loop)"),
  states: z.record(z.string(), z.string()).optional().describe("State name overrides by key"),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Starter config written when none exists"),
});

type GraphqlClient = {
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodes(value: unknown, ...path: string[]): Record<string, unknown>[] {
  let cur: unknown = value;
  for (const part of [...path, "nodes"]) cur = isRecord(cur) ? cur[part] : undefined;
  return Array.isArray(cur) ? cur.filter(isRecord) : [];
}

export default async function linearDeliverySetup(
  args: z.input<typeof argsSchema>,
  ctx: ScriptContext,
) {
  const parsed = argsSchema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: `invalid args: ${parsed.error.message}` };
  const a = parsed.data;
  const dryRun = a.dryRun !== false;
  const slug = a.connection ?? "linear";
  const label = a.projectLabel ?? "delivery-loop";
  const linear = (ctx.api as unknown as Record<string, GraphqlClient | undefined>)[slug];
  if (!linear || typeof linear.graphql !== "function") {
    return { ok: false, error: `connection '${slug}' is missing or is not a GraphQL connection` };
  }

  const created: string[] = [];
  const existing: string[] = [];
  const wouldCreate: string[] = [];

  const teams = await linear.graphql(
    `query LdlSetupTeam($team: String!) { teams(filter: { key: { eq: $team } }) { nodes { id states(first: 100) { nodes { id name type } } } } }`,
    { team: a.teamKey },
  );
  const team = nodes(teams, "teams")[0];
  if (!team) return { ok: false, error: `team ${a.teamKey} not found or not visible` };
  const have = new Set(nodes(team, "states").map((s) => String(s.name).toLowerCase()));

  for (const state of STATES) {
    const name = a.states?.[state.key] ?? state.name;
    const item = `state: ${name}`;
    if (have.has(name.toLowerCase())) {
      existing.push(item);
      continue;
    }
    if (dryRun) {
      wouldCreate.push(item);
      continue;
    }
    await linear.graphql(
      `mutation LdlSetupState($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) { success } }`,
      { input: { teamId: team.id, name, type: state.type, color: state.color } },
    );
    created.push(item);
  }

  const labels = await linear.graphql(
    `query LdlSetupLabel($name: String!) { projectLabels(filter: { name: { eq: $name } }) { nodes { id name } } }`,
    { name: label },
  );
  const labelItem = `project label: ${label}`;
  if (nodes(labels, "projectLabels").length > 0) existing.push(labelItem);
  else if (dryRun) wouldCreate.push(labelItem);
  else {
    await linear.graphql(
      `mutation LdlSetupLabelCreate($name: String!) { projectLabelCreate(input: { name: $name }) { success } }`,
      { name: label },
    );
    created.push(labelItem);
  }

  const configItem = `kv: ${NAMESPACE}/config`;
  const stored = await ctx.swarm.kv_get({ namespace: NAMESPACE, key: "config" });
  if (stored.success) existing.push(configItem);
  else if (dryRun) wouldCreate.push(configItem);
  else {
    const starter = a.config ?? {};
    const linearStarter = isRecord(starter.linear) ? starter.linear : {};
    await ctx.swarm.kv_set({
      namespace: NAMESPACE,
      key: "config",
      value: {
        ...starter,
        linear: {
          connection: slug,
          projectLabel: label,
          ...(a.states ? { states: a.states } : {}),
          ...linearStarter,
          teamKey: a.teamKey,
        },
      },
    });
    created.push(configItem);
  }

  return { ok: true, dryRun, teamKey: a.teamKey, created, existing, wouldCreate };
}

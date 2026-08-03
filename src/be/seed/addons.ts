import type { WorkflowDefinition } from "../../types";

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

/** Deterministic JSON representation used by add-on entity content hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

/** A workflow shipped by an add-on. The full definition is what gets content-hashed. */
export interface AddonWorkflowDef {
  name: string; // workflows.name (UNIQUE) — the seed key
  description: string;
  enabled: boolean;
  definition: WorkflowDefinition; // z.infer of WorkflowDefinitionSchema (src/types.ts:~1512-1624);
  // run through validateDefinition() in apply()
}

interface AddonScheduleBase {
  name: string; // scheduled_tasks.name (UNIQUE) — the seed key
  description: string;
  cronExpression: string; // validated with the same cron check create-schedule uses
  timezone: string; // 'UTC' for dream
  enabled: boolean; // INSIDE the content hash (disable must survive re-seed)
  // no modelTier/model — agent defaults
}

/** A schedule shipped by an add-on: workflow-target (references its workflow by NAME — never a
 *  generated id) or task-target (classic taskTemplate schedule). Mirrors the scheduled_tasks
 *  CHECK: workflowId required for 'workflow', taskTemplate required for 'agent-task'. */
export type AddonScheduleDef =
  | (AddonScheduleBase & {
      targetType: "workflow";
      workflowName: string; // resolved → workflowId at apply(); hashed as the name
    })
  | (AddonScheduleBase & {
      targetType: "agent-task";
      taskTemplate: string; // hashed; prompt text goes through the template registry rules
      taskType?: string;
      targetAgentId?: string; // omit ⇒ pool
      tags?: string[];
    });

export interface Addon {
  name: string; // add-on slug, e.g. 'dreaming'
  description: string;
  docsPath: string; // path to the docs page, e.g.
  // "docs-site/content/docs/(documentation)/addons/dreaming.mdx"
  workflows: AddonWorkflowDef[];
  schedules: AddonScheduleDef[]; // workflow-target schedules' workflowName must match a workflows[].name here
  skillNames: string[]; // must exist in BUILT_IN_SKILL_SOURCES — asserted at boot
  scriptNames: string[]; // must exist in SEED_SCRIPTS — asserted at boot
  configKeys: string[]; // configuration-catalog keys; provenance/docs only, not seeded rows
}

export const ADDONS: readonly Addon[] = [
  /* dreaming — content lands in Phase 4 */
];

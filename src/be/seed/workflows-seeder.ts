import alertsTriageConfig from "../../../templates/workflows/alerts-triage/config.json" with {
  type: "text",
};
import alertsTriageContent from "../../../templates/workflows/alerts-triage/content.md" with {
  type: "text",
};
import autopilotConfig from "../../../templates/workflows/autopilot/config.json" with {
  type: "text",
};
import autopilotContent from "../../../templates/workflows/autopilot/content.md" with {
  type: "text",
};
import claudeCodeChangelogWatchConfig from "../../../templates/workflows/claude-code-changelog-watch/config.json" with {
  type: "text",
};
import claudeCodeChangelogWatchContent from "../../../templates/workflows/claude-code-changelog-watch/content.md" with {
  type: "text",
};
import competitorRadarConfig from "../../../templates/workflows/competitor-radar/config.json" with {
  type: "text",
};
import competitorRadarContent from "../../../templates/workflows/competitor-radar/content.md" with {
  type: "text",
};
import docsSiteReleasesConfig from "../../../templates/workflows/docs-site-releases/config.json" with {
  type: "text",
};
import docsSiteReleasesContent from "../../../templates/workflows/docs-site-releases/content.md" with {
  type: "text",
};
import gscTopicMinerConfig from "../../../templates/workflows/gsc-topic-miner/config.json" with {
  type: "text",
};
import gscTopicMinerContent from "../../../templates/workflows/gsc-topic-miner/content.md" with {
  type: "text",
};
import linearDrainLoopConfig from "../../../templates/workflows/linear-drain-loop/config.json" with {
  type: "text",
};
import linearDrainLoopContent from "../../../templates/workflows/linear-drain-loop/content.md" with {
  type: "text",
};
import llmSafeReleaseContextConfig from "../../../templates/workflows/llm-safe-release-context/config.json" with {
  type: "text",
};
import llmSafeReleaseContextContent from "../../../templates/workflows/llm-safe-release-context/content.md" with {
  type: "text",
};
import prReviewStatusSweepConfig from "../../../templates/workflows/pr-review-status-sweep/config.json" with {
  type: "text",
};
import prReviewStatusSweepContent from "../../../templates/workflows/pr-review-status-sweep/content.md" with {
  type: "text",
};
import ralphLoopConfig from "../../../templates/workflows/ralph-loop/config.json" with {
  type: "text",
};
import ralphLoopContent from "../../../templates/workflows/ralph-loop/content.md" with {
  type: "text",
};
import type {
  AutomationIntegrationId,
  CooldownConfig,
  InputValue,
  TriggerConfig,
  Workflow,
  WorkflowDefinition,
} from "../../types";
import { validateDefinition } from "../../workflows/definition";
import { computeContentHash, createWorkflow, listWorkflows, updateWorkflow } from "../db";
import type { Seeder, SeedItem } from "./types";

type AutomationTemplateConfig = {
  name: string;
  description: string;
  placeholders?: string[];
  requires?: AutomationIntegrationId[];
  runAllSeedersCandidate?: boolean;
};

type WorkflowTemplatePayload = {
  nodes: WorkflowDefinition["nodes"];
  onNodeFailure?: WorkflowDefinition["onNodeFailure"];
  enabled?: boolean;
  triggers?: TriggerConfig[];
  cooldown?: CooldownConfig;
  input?: Record<string, InputValue>;
  triggerSchema?: Record<string, unknown>;
};

export type SeedWorkflow = {
  name: string;
  description: string;
  enabled: boolean;
  definition: WorkflowDefinition;
  triggers: TriggerConfig[];
  cooldown?: CooldownConfig;
  input?: Record<string, InputValue>;
  triggerSchema?: Record<string, unknown>;
  params: Record<string, unknown>;
  requiredParams: string[];
  requires: AutomationIntegrationId[];
};

export type WorkflowTemplateSource = { config: string; content: string };
type WorkflowSeedItem = SeedItem & { workflow: SeedWorkflow };

const asText = (value: unknown): string => value as string;

const BUILT_IN_WORKFLOW_SOURCES: readonly WorkflowTemplateSource[] = [
  { config: asText(alertsTriageConfig), content: asText(alertsTriageContent) },
  { config: asText(autopilotConfig), content: asText(autopilotContent) },
  {
    config: asText(claudeCodeChangelogWatchConfig),
    content: asText(claudeCodeChangelogWatchContent),
  },
  { config: asText(competitorRadarConfig), content: asText(competitorRadarContent) },
  { config: asText(docsSiteReleasesConfig), content: asText(docsSiteReleasesContent) },
  { config: asText(gscTopicMinerConfig), content: asText(gscTopicMinerContent) },
  { config: asText(linearDrainLoopConfig), content: asText(linearDrainLoopContent) },
  { config: asText(llmSafeReleaseContextConfig), content: asText(llmSafeReleaseContextContent) },
  { config: asText(prReviewStatusSweepConfig), content: asText(prReviewStatusSweepContent) },
  { config: asText(ralphLoopConfig), content: asText(ralphLoopContent) },
];

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

/** Deterministic JSON representation used by workflow and schedule seed hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function parseWorkflowSource(source: WorkflowTemplateSource): SeedWorkflow | null {
  const config = JSON.parse(source.config) as AutomationTemplateConfig;
  if (!config.runAllSeedersCandidate) return null;

  const match = source.content.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match?.[1]) throw new Error(`Workflow template ${config.name} has no JSON definition`);
  const payload = JSON.parse(match[1]) as WorkflowTemplatePayload;

  return {
    name: config.name,
    description: config.description,
    enabled: payload.enabled !== false,
    definition: {
      nodes: payload.nodes,
      onNodeFailure: payload.onNodeFailure ?? "fail",
    },
    triggers: payload.triggers ?? [],
    cooldown: payload.cooldown,
    input: payload.input,
    triggerSchema: payload.triggerSchema,
    params: {},
    requiredParams: config.placeholders ?? [],
    requires: config.requires ?? [],
  };
}

export function loadSeedWorkflows(
  sources: readonly WorkflowTemplateSource[] = BUILT_IN_WORKFLOW_SOURCES,
): SeedWorkflow[] {
  return sources
    .map(parseWorkflowSource)
    .filter((workflow): workflow is SeedWorkflow => workflow !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function workflowSeedHash(workflow: SeedWorkflow): string {
  return computeContentHash(canonicalJson(workflow));
}

async function findWorkflowByName(name: string): Promise<Workflow | null> {
  return (await listWorkflows()).find((workflow) => workflow.name === name) ?? null;
}

function workflowFromRow(workflow: Workflow): SeedWorkflow {
  return {
    name: workflow.name,
    description: workflow.description ?? "",
    enabled: workflow.enabled,
    definition: workflow.definition,
    triggers: workflow.triggers,
    cooldown: workflow.cooldown,
    input: workflow.input,
    triggerSchema: workflow.triggerSchema,
    params: workflow.params ?? {},
    requiredParams: workflow.requiredParams ?? [],
    requires: workflow.requires ?? [],
  };
}

export function createWorkflowsSeeder(
  sources: readonly WorkflowTemplateSource[] = BUILT_IN_WORKFLOW_SOURCES,
): Seeder<WorkflowSeedItem> {
  const workflows = loadSeedWorkflows(sources);
  return {
    kind: "workflow",

    items(): WorkflowSeedItem[] {
      return workflows.map((workflow) => ({
        key: workflow.name,
        contentHash: workflowSeedHash(workflow),
        workflow,
      }));
    },

    async upstreamHash(item): Promise<string | null> {
      const existing = await findWorkflowByName(item.key);
      return existing ? workflowSeedHash(workflowFromRow(existing)) : null;
    },

    async apply(item): Promise<void> {
      const { workflow } = item;
      const validation = validateDefinition(workflow.definition);
      if (!validation.valid) {
        throw new Error(`Invalid workflow definition: ${validation.errors.join("; ")}`);
      }

      const data = {
        description: workflow.description,
        definition: workflow.definition,
        triggers: workflow.triggers,
        cooldown: workflow.cooldown,
        input: workflow.input,
        triggerSchema: workflow.triggerSchema,
        params: workflow.params,
        requiredParams: workflow.requiredParams,
        requires: workflow.requires,
      };
      const existing = await findWorkflowByName(workflow.name);
      if (!existing) {
        const created = await createWorkflow({ name: workflow.name, ...data });
        if (!workflow.enabled) await updateWorkflow(created.id, { enabled: false });
        return;
      }

      await updateWorkflow(existing.id, { ...data, enabled: workflow.enabled });
    },
  };
}

export const workflowsSeeder = createWorkflowsSeeder();

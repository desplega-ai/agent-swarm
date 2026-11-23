import type { WorkflowRow } from "@desplega/storage";
import type {
  AutomationIntegrationId,
  CooldownConfig,
  InputValue,
  TriggerConfig,
  Workflow,
  WorkflowDefinition,
} from "../../../types";
import { normalizeDateRequired } from "../../date-utils";
import { getStorage } from "../../storage";

export type { WorkflowRow };

export function rowToWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled === 1,
    definition: JSON.parse(row.definition) as WorkflowDefinition,
    triggers: JSON.parse(row.triggers) as TriggerConfig[],
    cooldown: row.cooldown ? (JSON.parse(row.cooldown) as CooldownConfig) : undefined,
    input: row.input ? (JSON.parse(row.input) as Record<string, InputValue>) : undefined,
    triggerSchema: row.triggerSchema
      ? (JSON.parse(row.triggerSchema) as Record<string, unknown>)
      : undefined,
    params: JSON.parse(row.params) as Record<string, unknown>,
    requiredParams: JSON.parse(row.requiredParams) as string[],
    requires: JSON.parse(row.requires) as AutomationIntegrationId[],
    dir: row.dir ?? undefined,
    vcsRepo: row.vcs_repo ?? undefined,
    createdByAgentId: row.createdByAgentId ?? undefined,
    updatedByAgentId: row.updatedByAgentId ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
    lastUpdatedAt: normalizeDateRequired(row.lastUpdatedAt),
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
  };
}

/** Find enabled event subscribers in workflow-list order, returning each workflow once. */
export async function getWorkflowsByEventName(eventName: string): Promise<Workflow[]> {
  const rows = await getStorage().repos.workflows.listEnabledByEventName(eventName);
  return rows.map(rowToWorkflow);
}

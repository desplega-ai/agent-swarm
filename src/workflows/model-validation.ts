/**
 * Authoring-time model check for workflow definitions. `validateDefinition` is
 * synchronous and DB-free; judging a node's `model` against its agent's harness
 * needs the agent row and the catalog, so it runs as this separate async pass
 * from the create/update/patch handlers. The agent-task executor keeps its own
 * check as the run-time guard (it also covers pool nodes and interpolated values).
 */
import { taskProfileError } from "../be/db/model-profiles";
import { explicitModelErrorForAgent } from "../be/model-validation";
import { splitLegacyModelAlias, type WorkflowDefinition } from "../types";

type NodeConfig = Record<string, unknown>;

function asConfig(value: unknown): NodeConfig | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as NodeConfig)
    : null;
}

function isStatic(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !value.includes("{{");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Errors for agent-task nodes (and foreach bodies) that pin a model or a
 * profile their `agentId` cannot run. A static `profile` must exist, must not
 * sit beside `model`/`modelTier`, and must pass the profile check when
 * `agentId` is static too.
 */
export async function workflowModelErrors(
  def: WorkflowDefinition,
  /** The workflow-level `vcsRepo` a node without its own inherits. */
  { vcsRepo }: { vcsRepo?: string | null } = {},
): Promise<string[]> {
  const errors: string[] = [];
  for (const node of def.nodes) {
    const targets: Array<{ config: NodeConfig; path: string }> = [];
    if (node.type === "agent-task") targets.push({ config: node.config, path: "config" });
    if (node.type === "foreach") {
      const body = asConfig(asConfig(node.config.body)?.config);
      if (body) targets.push({ config: body, path: "config.body.config" });
    }
    for (const { config, path } of targets) {
      if (isStatic(config.profile)) {
        const error = await taskProfileError({
          profile: config.profile,
          model: asString(config.model),
          modelTier: asString(config.modelTier),
          agentId: isStatic(config.agentId) ? config.agentId : undefined,
          // A node's own repo wins over the workflow's, as in the executor.
          vcsRepo: config.vcsRepo === undefined ? vcsRepo : asString(config.vcsRepo),
        });
        if (error) errors.push(`Node "${node.id}" ${path}.profile: ${error}`);
      }
      if (!isStatic(config.model) || !isStatic(config.agentId)) continue;
      const modelTier = typeof config.modelTier === "string" ? config.modelTier : undefined;
      const error = await explicitModelErrorForAgent({
        model: splitLegacyModelAlias({ model: config.model, modelTier }).model,
        allowCustomModel: config.allowCustomModel === true,
        agentId: config.agentId,
      });
      if (error) errors.push(`Node "${node.id}" ${path}.model: ${error}`);
    }
  }
  return errors;
}

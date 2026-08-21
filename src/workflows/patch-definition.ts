import { getDbClient, getWorkflow, updateWorkflow } from "../be/db";
import type { Workflow, WorkflowDefinition, WorkflowPatch } from "../types";
import { applyDefinitionPatch, definitionNodeIds, validateDefinition } from "./definition";
import type { ExecutorRegistry } from "./executors/registry";
import { snapshotWorkflow } from "./version";

export type PatchWorkflowDefinitionResult =
  | { ok: true; workflow: Workflow; version: number | null; definition: WorkflowDefinition }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "patch" | "invalid"; errors: string[] };

/**
 * Read a workflow, merge a node patch into its definition, snapshot the
 * pre-patch state and write the merged definition back, all in one
 * transaction.
 *
 * The whole definition lives in a single column and `updateWorkflow` has no
 * version predicate, so two concurrent patches that each read the same base
 * definition both write a full blob and the second one drops the first one's
 * node edit while reporting success. That is reachable through the REST API
 * and, via the scripts SDK, through `Promise.all` over `workflow_patchNode`.
 * The FIFO lock serializes whole transactions, so the second patcher here
 * reads the first patcher's committed definition.
 *
 * `updates` carries the columns that do not derive from the definition (asset
 * key, trigger schema, audit user). Resolve them before calling so their
 * authorization failures stay outside the lock.
 */
export async function patchWorkflowDefinition(options: {
  id: string;
  patch: WorkflowPatch;
  /** Same optional executor registry `validateDefinition` takes. */
  registry?: ExecutorRegistry;
  snapshotAgentId?: string;
  /** HTTP handlers keep updating when the snapshot fails; tools surface it. */
  snapshotOptional?: boolean;
  updates?: Omit<Parameters<typeof updateWorkflow>[1], "definition">;
}): Promise<PatchWorkflowDefinitionResult> {
  const { id, patch, registry, snapshotAgentId, snapshotOptional, updates } = options;
  return await getDbClient().transaction(async (): Promise<PatchWorkflowDefinitionResult> => {
    const existing = await getWorkflow(id);
    if (!existing) return { ok: false, reason: "not_found" };

    const patchResult = applyDefinitionPatch(existing.definition, patch);
    if (patchResult.errors.length > 0) {
      return { ok: false, reason: "patch", errors: patchResult.errors };
    }

    const validation = validateDefinition(patchResult.definition, registry, {
      legacyNodeIds: definitionNodeIds(existing.definition),
    });
    if (!validation.valid) {
      return { ok: false, reason: "invalid", errors: validation.errors };
    }

    let version: number | null = null;
    if (snapshotOptional) {
      try {
        version = (await snapshotWorkflow(id, snapshotAgentId)).version;
      } catch {
        // Snapshot failure should not block the update
      }
    } else {
      version = (await snapshotWorkflow(id, snapshotAgentId)).version;
    }

    const workflow = await updateWorkflow(id, { ...updates, definition: patchResult.definition });
    if (!workflow) return { ok: false, reason: "not_found" };

    return { ok: true, workflow, version, definition: patchResult.definition };
  });
}

import type { Workflow, WorkflowSnapshot } from "../../types";
import { getWorkflow } from "../db";
import { computeContentHash } from "./context-versions";
import { getDbClient } from "./runtime";

// A run is pinned to the definition it started with (migration 283). The
// snapshot lives once per distinct content in `workflow_run_definitions`, keyed
// by its hash; `workflow_runs.definitionHash` points at it. Rows are immutable,
// so a lookup never races an edit.

/**
 * The definition fields a run keeps from its start. `enabled` stays live: it
 * does not stop in-flight runs today, and toggling it must not mint a new row.
 * Row identity and the security principal (`id`, `key`, `createdByAgentId`)
 * are not part of the snapshot and always come from the live row.
 */
export type PinnedWorkflowDefinition = Omit<WorkflowSnapshot, "enabled">;

export const PINNED_WORKFLOW_KEYS = [
  "name",
  "description",
  "definition",
  "triggers",
  "cooldown",
  "input",
  "triggerSchema",
  "params",
  "requiredParams",
  "requires",
  "dir",
  "vcsRepo",
] as const satisfies readonly (keyof PinnedWorkflowDefinition)[];

export function toPinnedDefinition(workflow: PinnedWorkflowDefinition): PinnedWorkflowDefinition {
  const pinned: Record<string, unknown> = {};
  for (const key of PINNED_WORKFLOW_KEYS) pinned[key] = workflow[key];
  return pinned as PinnedWorkflowDefinition;
}

/**
 * The stored snapshot and its hash. Nested key order is kept exactly as the
 * definition wrote it: executors iterate config objects (script `args`, System
 * One `questions` and `choices`) in insertion order, so a resumed run must see
 * the order it started with, and two definitions that differ only in order get
 * two rows. Only the top level is normalized (`PINNED_WORKFLOW_KEYS` order);
 * absent and `undefined` fields serialize the same.
 */
export function hashPinnedDefinition(pinned: PinnedWorkflowDefinition): {
  hash: string;
  snapshot: string;
} {
  const snapshot = JSON.stringify(toPinnedDefinition(pinned));
  return { hash: computeContentHash(snapshot), snapshot };
}

/** Store the workflow's pinned definition (once per content) and return its hash. */
export async function pinWorkflowDefinition(workflow: Workflow): Promise<string> {
  const { hash, snapshot } = hashPinnedDefinition(toPinnedDefinition(workflow));
  await getDbClient().run(
    "INSERT OR IGNORE INTO workflow_run_definitions (hash, snapshot, createdAt) VALUES (?, ?, ?)",
    [hash, snapshot, new Date().toISOString()],
  );
  return hash;
}

/** The pinned definition of a run, or null when the run has none (pre-283 or preflight-failed). */
export async function getPinnedRunDefinition(
  runId: string,
): Promise<PinnedWorkflowDefinition | null> {
  const row = await getDbClient().get<{ snapshot: string }>(
    `SELECT d.snapshot FROM workflow_runs r
       JOIN workflow_run_definitions d ON d.hash = r.definitionHash
      WHERE r.id = ?`,
    [runId],
  );
  // Not schema-validated, like `rowToWorkflow`: a later tightening of the
  // definition schema must not break runs pinned under the old one.
  return row ? (JSON.parse(row.snapshot) as PinnedWorkflowDefinition) : null;
}

/**
 * The live row with every pinned field taken from the snapshot. Each key is
 * assigned explicitly, `undefined` included, so a field the edit added (a `dir`
 * the run started without) cannot leak into the run.
 */
export function mergePinnedDefinition(live: Workflow, pinned: PinnedWorkflowDefinition): Workflow {
  const merged: Record<string, unknown> = { ...live };
  for (const key of PINNED_WORKFLOW_KEYS) merged[key] = pinned[key];
  return merged as Workflow;
}

/**
 * The workflow a run executes: the definition it started with (migration 283)
 * on top of the live row. Live fields (`enabled`, `key`, `createdByAgentId`,
 * row metadata) come from the row. A run with no pin (created before 283, or
 * a preflight failure) gets the live row unchanged. Null when the workflow is
 * gone. Use this, not `getWorkflow`, for every read made on behalf of a run.
 */
export async function getRunWorkflow(run: {
  id: string;
  workflowId: string;
}): Promise<Workflow | null> {
  const live = await getWorkflow(run.workflowId);
  if (!live) return null;
  const pinned = await getPinnedRunDefinition(run.id);
  return pinned ? mergePinnedDefinition(live, pinned) : live;
}

/**
 * Remove only the supplied snapshots that no run references. Collect the
 * hashes before deleting runs, then call this within the same transaction.
 */
export async function deleteOrphanedRunDefinitions(hashes: readonly string[]): Promise<void> {
  // Snapshots can be large. Bound each statement's rows and bind parameters,
  // and seek by hash instead of scanning unrelated definitions.
  const batchSize = 100;
  for (let offset = 0; offset < hashes.length; offset += batchSize) {
    const batch = hashes.slice(offset, offset + batchSize);
    await getDbClient().run(
      `DELETE FROM workflow_run_definitions
        WHERE hash IN (${batch.map(() => "?").join(", ")})
          AND NOT EXISTS (
            SELECT 1 FROM workflow_runs r WHERE r.definitionHash = workflow_run_definitions.hash
          )`,
      batch,
    );
  }
}

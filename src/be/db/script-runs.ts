import type { ScriptRunStatus } from "../../types";
import { openSealedJson } from "../sealed-json";
import { getStorage } from "../storage";

/**
 * The exact args a run executes with, or `undefined` when the run has no row.
 * Only the supervisor may call this: everything else reads the redacted view
 * on `ScriptRun.args`.
 */
export async function getScriptRunExecutionArgs(id: string): Promise<unknown> {
  const row = await getStorage().repos.scripts.getScriptRunArgs(id);
  return row ? openSealedJson(row.args) : undefined;
}

/**
 * A run and its descendants over `parentScriptRunId`, root first (no rows when
 * it does not exist). `truncated` is true when the tree goes past either bound.
 */
export async function listScriptRunTree(
  rootId: string,
  bounds: { maxRows: number; maxDepth: number },
) {
  return await getStorage().repos.scripts.listScriptRunTree(rootId, bounds);
}

/** A durable run's follow-up re-delegation guard decision (see migration 266). */
export type ScriptRunFollowUpGuard = "passed" | "same-work" | "loop-cap";

export async function getScriptRunFollowUpGuard(
  runId: string,
): Promise<ScriptRunFollowUpGuard | null> {
  const row = await getStorage().repos.scripts.getScriptRunFollowUpGuard(runId);
  return (row?.followUpGuard as ScriptRunFollowUpGuard | null | undefined) ?? null;
}

export async function setScriptRunFollowUpGuard(
  runId: string,
  decision: ScriptRunFollowUpGuard,
): Promise<void> {
  await getStorage().repos.scripts.setScriptRunFollowUpGuard(runId, decision);
}

/** Filters shared by the script-runs list and count queries. */
export type ScriptRunFilter = {
  status?: ScriptRunStatus;
  agentId?: string;
  scriptName?: string;
  /** Object calls on this durable script (`script_runs.objectScriptId`). */
  objectScriptId?: string;
  /** Exact object id; pair it with `objectScriptId`. */
  objectId?: string;
};

import type { ScriptRunStatus } from "../../types";
import { openSealedJson } from "../sealed-json";
import { getDbClient } from "./runtime";

/**
 * The exact args a run executes with, or `undefined` when the run has no row.
 * Only the supervisor may call this: everything else reads the redacted view
 * on `ScriptRun.args`.
 */
export async function getScriptRunExecutionArgs(id: string): Promise<unknown> {
  const row = await getDbClient().get<{ args: string }>(
    "SELECT args FROM script_runs WHERE id = ?",
    [id],
  );
  return row ? openSealedJson(row.args) : undefined;
}

/** A durable run's follow-up re-delegation guard decision (see migration 266). */
export type ScriptRunFollowUpGuard = "passed" | "same-work" | "loop-cap";

export async function getScriptRunFollowUpGuard(
  runId: string,
): Promise<ScriptRunFollowUpGuard | null> {
  const row = await getDbClient().get<{ followUpGuard: ScriptRunFollowUpGuard | null }>(
    "SELECT followUpGuard FROM script_runs WHERE id = ?",
    [runId],
  );
  return row?.followUpGuard ?? null;
}

export async function setScriptRunFollowUpGuard(
  runId: string,
  decision: ScriptRunFollowUpGuard,
): Promise<void> {
  await getDbClient().run("UPDATE script_runs SET followUpGuard = ? WHERE id = ?", [
    decision,
    runId,
  ]);
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

export function scriptRunFilterSql(opts?: ScriptRunFilter): {
  conditions: string[];
  params: string[];
} {
  const conditions: string[] = [];
  const params: string[] = [];
  const columns = [
    ["status", opts?.status],
    ["agentId", opts?.agentId],
    ["scriptName", opts?.scriptName],
    ["objectScriptId", opts?.objectScriptId],
    ["objectId", opts?.objectId],
  ] as const;
  for (const [column, value] of columns) {
    if (!value) continue;
    conditions.push(`${column} = ?`);
    params.push(value);
  }
  return { conditions, params };
}

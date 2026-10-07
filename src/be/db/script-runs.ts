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

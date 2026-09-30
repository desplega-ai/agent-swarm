/**
 * Worker-side harness guard, run right before a provider CLI starts. The server
 * already refuses cross-harness models at create and at claim; this is the last
 * line for what the server cannot see: the agent-scope `MODEL_OVERRIDE` fallback
 * (a worker whose harness changed while the override still names the old family),
 * and a task model from an API that predates the claim-time backstop.
 *
 * Worker-safe: no `src/be` imports; judges against the runtime catalog.
 */
import { harnessModelMismatch } from "@desplega/model-catalog";
import { runtimeHarnessSections } from "./runtime-model-catalog";

export type SpawnModelDecision =
  | { kind: "ok"; model: string; warning?: string }
  | { kind: "mismatch"; reason: string };

/** Same literal as the server's claim-time reason (`harnessMismatchReason`). */
export function spawnHarnessMismatchReason(model: string, harness: string): string {
  return `[model-harness-mismatch] Model "${model}" does not run on the ${harness} harness of this worker. The task pinned a model from another harness family. Re-create the task with modelTier or with a ${harness} model.`;
}

export function guardSpawnModel(input: {
  taskModel: string;
  configModel: string;
  harness: string;
  role: string;
}): SpawnModelDecision {
  const { taskModel, configModel, harness, role } = input;
  const sections = runtimeHarnessSections();
  if (taskModel) {
    return harnessModelMismatch(taskModel, harness, sections)
      ? { kind: "mismatch", reason: spawnHarnessMismatchReason(taskModel, harness) }
      : { kind: "ok", model: taskModel };
  }
  if (configModel && harnessModelMismatch(configModel, harness, sections)) {
    return {
      kind: "ok",
      model: "",
      warning: `[${role}] MODEL_OVERRIDE ${configModel} does not run on the ${harness} harness; using the adapter default`,
    };
  }
  return { kind: "ok", model: configModel };
}

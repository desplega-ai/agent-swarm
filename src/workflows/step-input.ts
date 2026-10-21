import type { WorkflowDefinition, WorkflowNode, WorkflowRun } from "../types";
import {
  buildNodeInterpolationCtx,
  interpolateNodeConfig,
  rehydrateCompletedStepOutputs,
} from "./engine";
import type { ExecutorRegistry } from "./executors/registry";

/** A node's execution input rebuilt outside the live walk that first ran it. */
export interface NodeExecutionInput {
  /** The run context, hydrated with `run.id` and every completed step output. */
  ctx: Record<string, unknown>;
  /** The node's declared-inputs interpolation context (`meta.inputCtx`). */
  inputCtx: Record<string, unknown>;
  /** The node config interpolated against `inputCtx`. */
  config: Record<string, unknown>;
  unresolved: string[];
  scriptBodyUnresolved?: string[];
  strictUnresolved?: string[];
}

/**
 * Rebuild a node's interpolated config and input context from persisted run
 * state, the way the live walk built them. The retry poller and the foreach
 * driver run executors outside walkGraph and go through here.
 *
 * The persisted run context can lag behind completed step checkpoints, and a
 * step can fail before ANY checkpoint persisted the walkGraph-hydrated
 * context, so `run.id` may be absent: both are restored before resolving the
 * node's declared inputs. Interpolating against the raw run context instead
 * resolves every `{{alias}}` to "" (it has no `inputs` aliases).
 *
 * Pass `ctx` to reuse a live walk's already hydrated context as-is.
 */
export async function rebuildNodeExecutionInput(
  def: WorkflowDefinition,
  run: Pick<WorkflowRun, "id" | "context">,
  node: WorkflowNode,
  registry: ExecutorRegistry,
  options: { ctx?: Record<string, unknown> } = {},
): Promise<NodeExecutionInput> {
  const ctx = options.ctx ?? ((run.context ?? {}) as Record<string, unknown>);
  if (!("run" in ctx)) ctx.run = { id: run.id };
  if (!options.ctx) await rehydrateCompletedStepOutputs(def, run.id, ctx, registry);

  const inputCtx = buildNodeInterpolationCtx(node, ctx);
  const { value, unresolved, scriptBodyUnresolved, strictUnresolved } = interpolateNodeConfig(
    node,
    inputCtx,
  );
  return {
    ctx,
    inputCtx,
    config: value as Record<string, unknown>,
    unresolved,
    scriptBodyUnresolved,
    strictUnresolved,
  };
}

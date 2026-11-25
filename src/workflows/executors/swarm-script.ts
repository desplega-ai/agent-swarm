import { z } from "zod";
import {
  getScriptApiConnectionDescriptors,
  getScriptMcpConnectionDescriptors,
} from "../../be/script-connections";
import { buildScriptCredentialBindingsWithFailures } from "../../be/script-credential-broker";
import {
  getScript,
  getScriptById,
  getScriptVersion,
  restoreScratchScriptLastUsedIfUnchanged,
  touchScratchScriptLastUsed,
} from "../../be/scripts/db";
import { runScriptWithRunCredential } from "../../be/scripts/run-credential";
import { resolveScriptExecutorName } from "../../scripts-runtime/executors/registry";
import {
  DEFAULT_SCRIPT_RESOURCES,
  MAX_SCRIPT_WALL_CLOCK_MS,
  MIN_SCRIPT_WALL_CLOCK_MS,
} from "../../scripts-runtime/executors/types";
import type { RunScriptOutput } from "../../scripts-runtime/loader";
import type { ExecutorMeta } from "../../types";
import { createValueScrubber } from "../../utils/secret-scrubber";
import { findInterpolationTokens } from "../../utils/template";
import { resolveWorkflowRunPrincipal } from "../run-principal";
import { parkStepJob, shouldParkScriptNode } from "../step-jobs";
import type { AsyncExecutorResult } from "./base";
import { BaseExecutor, type ExecutorResult } from "./base";

export const SWARM_SCRIPT_DEFAULT_TIMEOUT_MS = DEFAULT_SCRIPT_RESOURCES.wallClockMs;
export const SWARM_SCRIPT_MIN_TIMEOUT_MS = MIN_SCRIPT_WALL_CLOCK_MS;
export const SWARM_SCRIPT_MAX_TIMEOUT_MS = MAX_SCRIPT_WALL_CLOCK_MS;

export const SwarmScriptConfigSchema = z.object({
  scriptName: z.string().min(1),
  scope: z.enum(["global", "agent"]).optional(),
  pinHash: z.string().min(1).optional(),
  args: z.record(z.string(), z.unknown()).default({}),
  fsMode: z.enum(["none", "workspace-rw"]).default("none"),
  timeoutMs: z
    .number()
    .int()
    .min(SWARM_SCRIPT_MIN_TIMEOUT_MS)
    .max(SWARM_SCRIPT_MAX_TIMEOUT_MS)
    .default(SWARM_SCRIPT_DEFAULT_TIMEOUT_MS),
});

export const SwarmScriptOutputSchema = z.object({
  result: z.unknown().optional(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() }),
  durationMs: z.number(),
  exitCode: z.number(),
  scriptName: z.string(),
  contentHash: z.string(),
  version: z.number(),
});

type SwarmScriptConfig = z.infer<typeof SwarmScriptConfigSchema>;
type SwarmScriptOutput = z.infer<typeof SwarmScriptOutputSchema>;

const WORKFLOW_INTERPOLATION_ROOTS = new Set(["trigger", "input", "workflow", "swarm", "run"]);

function findWorkflowSourceTokens(
  source: string,
  inputCtx: Readonly<Record<string, unknown>> | undefined,
): string[] {
  const roots = new Set([...WORKFLOW_INTERPOLATION_ROOTS, ...Object.keys(inputCtx ?? {})]);
  return findInterpolationTokens(source).filter((token) => {
    const root = token.split(".")[0];
    return root !== undefined && roots.has(root);
  });
}

export class SwarmScriptExecutor extends BaseExecutor<
  typeof SwarmScriptConfigSchema,
  typeof SwarmScriptOutputSchema
> {
  readonly type = "swarm-script";
  readonly mode = "instant" as const;
  readonly configSchema = SwarmScriptConfigSchema;
  readonly outputSchema = SwarmScriptOutputSchema;

  protected async execute(
    config: SwarmScriptConfig,
    _context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<SwarmScriptOutput> | AsyncExecutorResult<SwarmScriptOutput>> {
    if (shouldParkScriptNode()) return parkStepJob("step-script", meta, _context);
    if (config.fsMode === "workspace-rw") {
      return {
        status: "failed",
        error: "swarm-script: fsMode 'workspace-rw' is v2 only; use 'none' or omit",
      };
    }

    const workflow = await this.deps.db.getRunWorkflow({
      id: meta.runId,
      workflowId: meta.workflowId,
    });
    // Never `trigger.agentId`: trigger data is caller-supplied, so reading the
    // principal from it let any agent run a creator-less workflow's scripts as
    // the lead. The run row carries the server-stamped starting agent.
    const principal = await resolveWorkflowRunPrincipal(workflow, meta.runId);
    if (!principal.ok) return { status: "failed", error: `swarm-script: ${principal.error}` };
    const agentId = principal.agentId;
    const resolved = await resolveScriptSource(config, agentId);

    if (!resolved.ok) {
      return { status: "failed", error: resolved.error };
    }

    // Catalog source is never workflow-interpolated. Only reject tokens whose
    // root is a source available to this node (builtins or declared aliases);
    // other mustache syntax is literal script data.
    const sourceTokens = findWorkflowSourceTokens(resolved.source, meta.inputCtx);
    if (sourceTokens.length > 0) {
      const renderedTokens = [...new Set(sourceTokens)].map((token) => `{{${token}}}`).join(", ");
      return {
        status: "failed",
        error:
          `swarm-script body interpolation failed for node "${meta.nodeId}": unresolved token(s): ${renderedTokens}. ` +
          "Named script source is not workflow-interpolated; pass dynamic values through config.args and read them from args.",
      };
    }

    // Touch before executing so an already-stale scratch script isn't reaped
    // by the retention sweep while this run is still in flight.
    const runStartTouch = resolved.script.isScratch
      ? await touchScratchScriptLastUsed(resolved.script.id)
      : null;

    const credentials = principal.userId
      ? undefined
      : await buildScriptCredentialBindingsWithFailures({
          agentId: agentId ?? undefined,
        });
    const output = await runScriptWithRunCredential(
      {
        source: resolved.source,
        args: config.args,
        fsMode: "none",
        executor: resolved.script.executor,
        agentId: agentId ?? "workflow",
        egressSecrets: credentials?.egressSecrets,
        failedBindings: credentials?.failedBindings,
        userConfig: credentials?.userConfig,
        agentFs: credentials?.agentFs,
        apiConnections: principal.userId
          ? undefined
          : await getScriptApiConnectionDescriptors({ agentId: agentId ?? undefined }),
        mcpConnections: principal.userId
          ? undefined
          : await getScriptMcpConnectionDescriptors({ agentId: agentId ?? undefined }),
        timeoutMs: config.timeoutMs,
        // The step watchdog aborts this when the node budget runs out, which
        // kills the script process: a step reported as timed out must not go
        // on to perform the script's side effects.
        signal: meta.signal,
      },
      // Rows the script creates through its token point back at this step.
      { sourceStepId: meta.stepId },
      principal.userId
        ? { kind: "user", userId: principal.userId }
        : principal.operator
          ? { kind: "operator" }
          : undefined,
    );
    return finishSwarmScriptOutput(output, resolved, runStartTouch);
  }
}

type ResolvedScript = {
  script: Pick<
    NonNullable<Awaited<ReturnType<typeof getScript>>>,
    "id" | "name" | "updatedAt" | "isScratch"
  >;
  contentHash: string;
  version: number;
};
async function finishSwarmScriptOutput(
  output: RunScriptOutput,
  resolved: ResolvedScript,
  runStartTouch: string | null,
): Promise<ExecutorResult<SwarmScriptOutput>> {
  const failed = output.exitCode !== 0 || !!output.error || !!output.runtimeError;
  if (!failed) await touchScratchScriptLastUsed(resolved.script.id);
  else if (resolved.script.isScratch && runStartTouch)
    await restoreScratchScriptLastUsedIfUnchanged(
      resolved.script.id,
      resolved.script.updatedAt,
      runStartTouch,
    );
  const workflowOutput = {
    result: output.result,
    stdout: output.stdout,
    stderr: output.stderr,
    truncated: output.truncated,
    durationMs: output.durationMs,
    exitCode: output.exitCode,
    scriptName: resolved.script.name,
    contentHash: resolved.contentHash,
    version: resolved.version,
  };
  return failed
    ? {
        status: "failed",
        error:
          output.stderr ||
          `swarm-script: script exited with code ${output.exitCode}${output.error ? ` (${output.error})` : ""}`,
        output: workflowOutput,
      }
    : { status: "success", output: workflowOutput, nextPort: "success" };
}

async function resolveScriptSource(
  config: SwarmScriptConfig,
  agentId: string | undefined,
): Promise<
  | {
      ok: true;
      script: NonNullable<Awaited<ReturnType<typeof getScript>>>;
      source: string;
      contentHash: string;
      version: number;
    }
  | { ok: false; error: string }
> {
  if (config.scope === "agent" && !agentId) {
    return {
      ok: false,
      error:
        "swarm-script: agent-scoped scripts require the workflow to have createdByAgentId or the run to be started by an agent",
    };
  }

  const script =
    config.scope === "global"
      ? await getScript({ name: config.scriptName, scope: "global" })
      : config.scope === "agent"
        ? await getScript({ name: config.scriptName, scope: "agent", scopeId: agentId })
        : agentId
          ? ((await getScript({ name: config.scriptName, scope: "agent", scopeId: agentId })) ??
            (await getScript({ name: config.scriptName, scope: "global" })))
          : await getScript({ name: config.scriptName, scope: "global" });

  if (!script) {
    const scopeHint = config.scope ? ` in ${config.scope} scope` : "";
    return {
      ok: false,
      error: `swarm-script: script '${config.scriptName}' not found${scopeHint}`,
    };
  }

  if (!config.pinHash) {
    return {
      ok: true,
      script,
      source: script.source,
      contentHash: script.contentHash,
      version: script.version,
    };
  }

  const version = await getScriptVersion({ scriptId: script.id, contentHash: config.pinHash });
  if (!version) {
    return {
      ok: false,
      error: `swarm-script: pinHash '${config.pinHash}' not found for script '${config.scriptName}'`,
    };
  }

  return {
    ok: true,
    script,
    source: version.source,
    contentHash: version.contentHash,
    version: version.version,
  };
}

type ScriptReference = {
  scriptId: string;
  scriptName: string;
  contentHash: string;
  version: number;
  executor: "native" | "quickjs";
  scratch?: { prior: string; touch: string };
};

export async function prepareSwarmScriptStepJob(
  input: import("../step-job-kinds").StepJobBuildInput,
) {
  const { getWorkflowRunStep, getRunWorkflow } = await import("../../be/db");
  const { getStorage } = await import("../../be/storage");
  const config = SwarmScriptConfigSchema.parse(input.config);
  const workflow = await getRunWorkflow({ id: input.job.runId, workflowId: input.meta.workflowId });
  const principal = await resolveWorkflowRunPrincipal(workflow, input.job.runId);
  if (!principal.ok) throw new Error(principal.error);
  const reference = await getStorage().transaction(async () => {
    const step = await getWorkflowRunStep(input.job.stepId);
    if (!step || step.retryCount !== input.job.attempt)
      throw new Error("Workflow job lost its step attempt");
    const saved = (step.input ?? {}) as Record<string, unknown>;
    const refs = (saved._stepJobReferences ?? {}) as Record<string, ScriptReference>;
    const key = String(input.job.attempt);
    if (refs[key]) return refs[key];
    const resolved = await resolveScriptSource(config, principal.agentId);
    if (!resolved.ok) throw new Error(resolved.error);
    const ref: ScriptReference = {
      scriptId: resolved.script.id,
      scriptName: resolved.script.name,
      contentHash: resolved.contentHash,
      version: resolved.version,
      executor: resolveScriptExecutorName(resolved.script.executor),
    };
    await getStorage().repos.workflows.updateStepColumns(step.id, {
      input: JSON.stringify({ ...saved, _stepJobReferences: { ...refs, [key]: ref } }),
    });
    return ref;
  });
  return { ...input, config: { ...input.config, _scriptReference: reference } };
}

/** Rebuild credentials and source on the API, never from the job row. */
export async function buildSwarmScriptStepJob(
  input: import("../step-job-kinds").StepJobBuildInput,
): Promise<import("../step-job-kinds").PreparedStepJob> {
  const { getRunWorkflow } = await import("../../be/db");
  const { acquireScriptApiCredential } = await import("../../be/scripts/run-credential");
  const { getStorage } = await import("../../be/storage");
  const { prepareScriptJob, finishScriptJob } = await import("../../scripts-runtime/loader");
  const config = SwarmScriptConfigSchema.parse(input.config);
  const workflow = await getRunWorkflow({ id: input.job.runId, workflowId: input.meta.workflowId });
  const principal = await resolveWorkflowRunPrincipal(workflow, input.job.runId);
  if (!principal.ok) throw new Error(principal.error);
  input = await prepareSwarmScriptStepJob(input);
  const reference = input.config._scriptReference as ScriptReference;
  const script = await getScriptById(reference.scriptId);
  const version = await getScriptVersion({
    scriptId: reference.scriptId,
    version: reference.version,
  });
  if (!script || !version || version.contentHash !== reference.contentHash)
    throw new Error("Dispatched script version is unavailable");
  const resolved = {
    script: { ...script, name: reference.scriptName, executor: reference.executor },
    source: version.source,
    contentHash: reference.contentHash,
    version: reference.version,
  };
  if (findWorkflowSourceTokens(resolved.source, input.meta.inputCtx).length)
    throw new Error("Named script source contains unresolved workflow tokens");
  const agentId = principal.userId ? "" : (principal.agentId ?? "workflow");
  const credentials = principal.userId
    ? undefined
    : await buildScriptCredentialBindingsWithFailures({ agentId: principal.agentId });
  const credential = await acquireScriptApiCredential(
    agentId,
    { sourceStepId: input.job.stepId },
    principal.userId
      ? { kind: "user", userId: principal.userId }
      : principal.operator
        ? { kind: "operator" }
        : undefined,
  );
  try {
    if (resolved.script.isScratch) {
      await getStorage().transaction(async () => {
        const { getWorkflowRunStep } = await import("../../be/db");
        const step = await getWorkflowRunStep(input.job.stepId);
        const held = await getStorage().repos.workflowStepJobs.get(input.job.id);
        if (!step || held?.ownerId !== input.job.ownerId || held?.status !== "running")
          throw new Error("Workflow job lost its claim before preparation");
        const touch = await touchScratchScriptLastUsed(script.id);
        if (touch) {
          reference.scratch = { prior: script.updatedAt, touch };
          const saved = (step.input ?? {}) as Record<string, unknown>;
          const refs = (saved._stepJobReferences ?? {}) as Record<string, ScriptReference>;
          await getStorage().repos.workflows.updateStepColumns(step.id, {
            input: JSON.stringify({
              ...saved,
              _stepJobReferences: { ...refs, [String(input.job.attempt)]: reference },
            }),
          });
        }
      });
    }
    const prepared = await prepareScriptJob({
      source: resolved.source,
      args: config.args,
      fsMode: config.fsMode,
      executor: resolved.script.executor,
      agentId,
      apiKey: credential.apiKey,
      dbDialect: getStorage().capabilities.dbQueryDialect,
      egressSecrets: credentials?.egressSecrets ?? [],
      failedBindings: credentials?.failedBindings ?? [],
      userConfig: credentials?.userConfig ?? {},
      agentFs: credentials?.agentFs,
      apiConnections: principal.userId
        ? []
        : await getScriptApiConnectionDescriptors({ agentId: principal.agentId }),
      mcpConnections: principal.userId
        ? []
        : await getScriptMcpConnectionDescriptors({ agentId: principal.agentId }),
      timeoutMs: config.timeoutMs,
    });
    if (!("job" in prepared))
      throw new Error(prepared.stderr || prepared.error || "Script preparation failed");
    prepared.job.id = input.job.id;
    prepared.job.kind = "step-script";

    return {
      job: prepared.job,
      async release() {
        await credential.release();
        if (reference.scratch)
          await restoreScratchScriptLastUsedIfUnchanged(
            reference.scriptId,
            reference.scratch.prior,
            reference.scratch.touch,
          );
      },
      async finish(raw) {
        return finishSwarmScriptOutput(
          finishScriptJob(raw, prepared.scrubber),
          {
            ...resolved,
            script: {
              ...resolved.script,
              updatedAt: reference.scratch?.prior ?? resolved.script.updatedAt,
            },
          },
          reference.scratch?.touch ?? null,
        );
      },
    };
  } catch (error) {
    await credential.release();
    if (reference.scratch)
      await restoreScratchScriptLastUsedIfUnchanged(
        reference.scriptId,
        reference.scratch.prior,
        reference.scratch.touch,
      );
    throw error;
  }
}

/** Restore attribution without reading mutable source or minting another execution credential. */
export async function restoreSwarmScriptStepJob(
  input: import("../step-job-kinds").StepJobBuildInput,
) {
  const { getWorkflowRunStep } = await import("../../be/db");
  const { finishScriptJob } = await import("../../scripts-runtime/loader");
  const step = await getWorkflowRunStep(input.job.stepId);
  const saved = step?.input as { _stepJobReferences?: Record<string, ScriptReference> } | undefined;
  const ref = saved?._stepJobReferences?.[String(input.job.attempt)];
  if (!ref) throw new Error("Workflow job has no dispatched script reference");
  const resolved: ResolvedScript = {
    script: {
      id: ref.scriptId,
      name: ref.scriptName,
      updatedAt: ref.scratch?.prior ?? "",
      isScratch: !!ref.scratch,
    },
    contentHash: ref.contentHash,
    version: ref.version,
  };
  return {
    async finish(raw: import("../../scripts-runtime/executors/types").ExecutorOutput) {
      return finishSwarmScriptOutput(
        finishScriptJob(raw, createValueScrubber([])),
        resolved,
        ref.scratch?.touch ?? null,
      );
    },
    async release() {
      if (ref.scratch)
        await restoreScratchScriptLastUsedIfUnchanged(
          ref.scriptId,
          ref.scratch.prior,
          ref.scratch.touch,
        );
    },
  };
}

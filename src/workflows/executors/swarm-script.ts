import { z } from "zod";
import {
  getScriptApiConnectionDescriptors,
  getScriptMcpConnectionDescriptors,
} from "../../be/script-connections";
import { buildScriptCredentialBindingsWithFailures } from "../../be/script-credential-broker";
import {
  getScript,
  getScriptVersion,
  restoreScratchScriptLastUsedIfUnchanged,
  touchScratchScriptLastUsed,
} from "../../be/scripts/db";
import {
  DEFAULT_SCRIPT_RESOURCES,
  MAX_SCRIPT_WALL_CLOCK_MS,
  MIN_SCRIPT_WALL_CLOCK_MS,
} from "../../scripts-runtime/executors/types";
import { runScript } from "../../scripts-runtime/loader";
import type { ExecutorMeta } from "../../types";
import { findInterpolationTokens } from "../../utils/template";
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
    context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<SwarmScriptOutput>> {
    if (config.fsMode === "workspace-rw") {
      return {
        status: "failed",
        error: "swarm-script: fsMode 'workspace-rw' is v2 only; use 'none' or omit",
      };
    }

    const workflow = await this.deps.db.getWorkflow(meta.workflowId);
    const agentId = workflow?.createdByAgentId ?? agentIdFromContext(context);
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

    const credentials = await buildScriptCredentialBindingsWithFailures({
      agentId: agentId ?? undefined,
    });
    const output = await runScript({
      source: resolved.source,
      args: config.args,
      fsMode: "none",
      agentId: agentId ?? "workflow",
      egressSecrets: credentials.egressSecrets,
      failedBindings: credentials.failedBindings,
      apiConnections: getScriptApiConnectionDescriptors({ agentId: agentId ?? undefined }),
      mcpConnections: getScriptMcpConnectionDescriptors({ agentId: agentId ?? undefined }),
      timeoutMs: config.timeoutMs,
    });
    if (output.exitCode === 0 && !output.error && !output.runtimeError) {
      await touchScratchScriptLastUsed(resolved.script.id);
    } else if (resolved.script.isScratch && runStartTouch) {
      // Failed run — restore the pre-run timestamp so it doesn't buy the
      // script another retention window, unless a concurrent run already
      // touched it since.
      await restoreScratchScriptLastUsedIfUnchanged(
        resolved.script.id,
        resolved.script.updatedAt,
        runStartTouch,
      );
    }

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

    if (output.exitCode !== 0 || output.error) {
      return {
        status: "failed",
        error:
          output.stderr ||
          `swarm-script: script exited with code ${output.exitCode}${
            output.error ? ` (${output.error})` : ""
          }`,
        output: workflowOutput,
      };
    }

    return {
      status: "success",
      output: workflowOutput,
      nextPort: "success",
    };
  }
}

function agentIdFromContext(context: Readonly<Record<string, unknown>>): string | undefined {
  const trigger = context.trigger;
  if (trigger && typeof trigger === "object") {
    const value = (trigger as Record<string, unknown>).agentId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
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
        "swarm-script: agent-scoped scripts require the workflow to have createdByAgentId or trigger.agentId",
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

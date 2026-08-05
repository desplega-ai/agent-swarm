import { z } from "zod";
import {
  getScriptApiConnectionDescriptors,
  getScriptMcpConnectionDescriptors,
} from "../../be/script-connections";
import { buildScriptCredentialBindingsWithFailures } from "../../be/script-credential-broker";
import { getScript, getScriptVersion } from "../../be/scripts/db";
import { ADDONS, canonicalJson } from "../../be/seed/addons";
import { getSeedScriptContentHash } from "../../be/seed-scripts";
import {
  DEFAULT_SCRIPT_RESOURCES,
  MAX_SCRIPT_WALL_CLOCK_MS,
  MIN_SCRIPT_WALL_CLOCK_MS,
} from "../../scripts-runtime/executors/types";
import { runScript } from "../../scripts-runtime/loader";
import type { ExecutorMeta, Workflow } from "../../types";
import { BaseExecutor, type ExecutorDependencies, type ExecutorResult } from "./base";

export const SWARM_SCRIPT_DEFAULT_TIMEOUT_MS = DEFAULT_SCRIPT_RESOURCES.wallClockMs;
export const SWARM_SCRIPT_MIN_TIMEOUT_MS = MIN_SCRIPT_WALL_CLOCK_MS;
export const SWARM_SCRIPT_MAX_TIMEOUT_MS = MAX_SCRIPT_WALL_CLOCK_MS;

export const SwarmScriptConfigSchema = z.object({
  scriptName: z.string().min(1),
  scope: z.enum(["global", "agent"]).optional(),
  pinHash: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
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

    const workflow = this.deps.db.getWorkflow(meta.workflowId);
    const identity = resolveExecutionIdentity(config, workflow, meta, context, this.deps.db);
    if (!identity.ok) return { status: "failed", error: identity.error };
    const agentId = identity.agentId;
    const resolved = resolveScriptSource(config, agentId, identity.trustedScriptHash);

    if (!resolved.ok) {
      return { status: "failed", error: resolved.error };
    }

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

/**
 * Honor an explicit execution identity only after every trust layer agrees:
 * shipped add-on name, canonical definition equality, the run's pinned hash,
 * the actual definition being walked, a declared swarm-script node, exact
 * seeded script content, and a currently live Lead. The seed-catalog imports
 * are an intentional layering inversion:
 * shipped definitions and script sources are the runtime trust roots, so the
 * executor must compare against that exact data.
 */
export function resolveExecutionIdentity(
  config: SwarmScriptConfig,
  workflow: Workflow | null,
  meta: ExecutorMeta,
  context: Readonly<Record<string, unknown>>,
  db: ExecutorDependencies["db"],
):
  | { ok: true; agentId: string | undefined; trustedScriptHash?: string }
  | { ok: false; error: string } {
  if (!config.agentId) {
    return {
      ok: true,
      agentId: workflow?.createdByAgentId ?? agentIdFromContext(context),
    };
  }

  if (
    !workflow ||
    !isTrustedAddonIdentityNode(
      workflow,
      meta.nodeId,
      config.scriptName,
      meta.workflowDefinitionHash,
      meta.workflowRunDefinitionHash,
      db,
    )
  ) {
    return {
      ok: false,
      error:
        "swarm-script: agentId overrides are restricted to declared nodes in an unmodified shipped add-on workflow",
    };
  }

  // Validate the requested agent ITSELF as a live Lead. getLeadAgent() returns the
  // first non-offline lead, which with multiple Lead rows can be an unusable
  // `waiting_for_credentials` one — equality with that lookup would reject the
  // live Lead the trusted gather actually selected.
  const liveLeads = db
    .getAllAgents()
    .filter((agent) => agent.isLead && ["idle", "busy"].includes(agent.status));
  const requestedAgent =
    config.agentId === "$lead"
      ? liveLeads[0]
      : liveLeads.find((agent) => agent.id === config.agentId);
  if (!requestedAgent) {
    return {
      ok: false,
      error: "swarm-script: add-on identity override must resolve to a live Lead agent",
    };
  }
  const trustedScriptHash = getSeedScriptContentHash(config.scriptName);
  if (!trustedScriptHash) {
    return {
      ok: false,
      error: `swarm-script: trusted add-on script '${config.scriptName}' is absent from the seeded catalog`,
    };
  }
  return { ok: true, agentId: requestedAgent.id, trustedScriptHash };
}

/** Verify that this exact script node belongs to the unchanged definition the engine executed. */
export function isTrustedAddonIdentityNode(
  workflow: Workflow,
  nodeId: string,
  scriptName: string,
  executedDefinitionHash: string | undefined,
  runDefinitionHash: string | undefined,
  db: ExecutorDependencies["db"],
): boolean {
  // Match on definition identity ONLY — canonical JSON + both executed hashes. The
  // workflow NAME is mutable display metadata: a renamed-but-unmodified seeded
  // workflow keeps its schedule and its workflowId-based activity exclusion, so it
  // must keep trusted execution too instead of failing only at identity steps.
  const shipped = ADDONS.flatMap((addon) => addon.workflows).find((candidate) => {
    const shippedCanonical = canonicalJson(candidate.definition);
    const shippedHash = db.computeContentHash(shippedCanonical);
    return (
      shippedCanonical === canonicalJson(workflow.definition) &&
      executedDefinitionHash === shippedHash &&
      runDefinitionHash === shippedHash
    );
  });
  if (!shipped) return false;
  const node = shipped.definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.type !== "swarm-script") return false;
  const nodeConfig = node.config as Record<string, unknown>;
  return nodeConfig.scriptName === scriptName && typeof nodeConfig.agentId === "string";
}

function agentIdFromContext(context: Readonly<Record<string, unknown>>): string | undefined {
  const trigger = context.trigger;
  if (trigger && typeof trigger === "object") {
    const value = (trigger as Record<string, unknown>).agentId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function resolveScriptSource(
  config: SwarmScriptConfig,
  agentId: string | undefined,
  trustedScriptHash?: string,
):
  | {
      ok: true;
      script: NonNullable<ReturnType<typeof getScript>>;
      source: string;
      contentHash: string;
      version: number;
    }
  | { ok: false; error: string } {
  if (config.scope === "agent" && !agentId) {
    return {
      ok: false,
      error:
        "swarm-script: agent-scoped scripts require the workflow to have createdByAgentId or trigger.agentId",
    };
  }

  const script =
    config.scope === "global"
      ? getScript({ name: config.scriptName, scope: "global" })
      : config.scope === "agent"
        ? getScript({ name: config.scriptName, scope: "agent", scopeId: agentId })
        : agentId
          ? (getScript({ name: config.scriptName, scope: "agent", scopeId: agentId }) ??
            getScript({ name: config.scriptName, scope: "global" }))
          : getScript({ name: config.scriptName, scope: "global" });

  if (!script) {
    const scopeHint = config.scope ? ` in ${config.scope} scope` : "";
    return {
      ok: false,
      error: `swarm-script: script '${config.scriptName}' not found${scopeHint}`,
    };
  }

  const pinHash = trustedScriptHash ?? config.pinHash;
  if (!pinHash) {
    return {
      ok: true,
      script,
      source: script.source,
      contentHash: script.contentHash,
      version: script.version,
    };
  }

  const version = getScriptVersion({ scriptId: script.id, contentHash: pinHash });
  if (!version) {
    return {
      ok: false,
      error: trustedScriptHash
        ? `swarm-script: shipped content hash '${pinHash}' not found for trusted add-on script '${config.scriptName}'`
        : `swarm-script: pinHash '${pinHash}' not found for script '${config.scriptName}'`,
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

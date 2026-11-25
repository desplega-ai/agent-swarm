import { getApiKey } from "../utils/api-key";
import { getMcpBaseUrl, getScriptApiBaseUrl } from "../utils/constants";
import { type EgressPolicy, parseEgressAllowlist } from "../utils/egress-guard";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { createValueScrubber, scrubObject, scrubSecrets } from "../utils/secret-scrubber";
import type { ScriptApiConnectionDescriptor, ScriptMcpConnectionDescriptor } from "./api-types";
import type { FailedCredentialBinding } from "./credential-broker";
import { dispatchScriptJob } from "./dispatch/dispatcher";
import type { InlineScriptJob } from "./dispatch/types";
import { buildEgressSecrets } from "./egress-secrets";
import { isExecutorAllowedByDeployment, resolveScriptExecutorName } from "./executors/registry";
import {
  DEFAULT_SCRIPT_RESOURCES,
  type DurableInvocation,
  type EgressSecretEntry,
  type ExecutorOutput,
  type ScriptAgentFsDescriptor,
  type ScriptCaller,
  type ScriptExecutorName,
  type ScriptFsMode,
  type ScriptResourcePolicy,
  type SwarmConfigPayload,
} from "./executors/types";
import { HOST_VALIDATED_ARGS } from "./host-validated-args";
import { validateScriptImports } from "./import-allowlist";
import type { ScriptDbDialect } from "./script-db";

export type RunScriptInput = {
  source: string;
  durable?: DurableInvocation;
  caller?: ScriptCaller;
  args?: unknown;
  /**
   * Unforgeable host-only capability symbol set only when the host has already
   * validated `args` against the script's `argsJsonSchema` (e.g. `POST /api/x/script/{endpointId}`).
   * Keyed by a `Symbol` so request-shaped JSON inputs forwarded into `RunScriptInput`
   * can never opt out of `argsSchema` validation.
   */
  [HOST_VALIDATED_ARGS]?: boolean;
  fsMode?: ScriptFsMode;
  /**
   * Optional per-script executor override ("native" | "quickjs"). When null or
   * undefined, `getScriptExecutor` falls back to `SCRIPT_EXECUTOR ?? "native"`.
   */
  executor?: ScriptExecutorName | null;
  agentId: string;
  /**
   * Bearer for the run's `ctx.swarm` SDK calls. Api-side callers pass a
   * per-run token bound to the executing agent (`runScriptWithRunCredential`
   * in `src/be/scripts/run-credential.ts`, which also revokes it). Omitted, the
   * run presents the swarm API key.
   */
  apiKey?: string;
  /** Per-boot runtime identity of the invoking worker; system context, never script input. */
  runtimeInstanceId?: string;
  /**
   * Task the run acts for, sent as `X-Audit-Source-Task-Id` on its `ctx.swarm`
   * calls so their writes get the same audit person. The api re-checks ownership.
   */
  sourceTaskId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  mcpBaseUrl?: string;
  resources?: Partial<ScriptResourcePolicy>;
  userConfig?: Record<string, { value: string; isSecret: boolean }>;
  egressSecrets?: EgressSecretEntry[];
  failedBindings?: FailedCredentialBinding[];
  apiConnections?: ScriptApiConnectionDescriptor[];
  mcpConnections?: ScriptMcpConnectionDescriptor[];
  agentFs?: ScriptAgentFsDescriptor;
  /**
   * SQL dialect of the swarm database, read by the api-side caller from the
   * storage capability. It becomes `ctx.db.dialect`.
   */
  dbDialect?: ScriptDbDialect;
};

export type RunScriptOutput = Omit<ExecutorOutput, "result" | "stdout" | "stderr"> & {
  result: unknown | undefined;
  stdout: string;
  stderr: string;
};

export type { ScriptRuntimeError, ScriptStackFrame } from "./executors/types";

/**
 * Egress policy for script runs, read per run like `SCRIPT_EXECUTOR`. Only
 * the quickjs executor enforces it; native ignores it.
 */
export function scriptEgressPolicy(env: NodeJS.ProcessEnv = process.env): EgressPolicy {
  return {
    allowPrivate: isEnvFlagEnabled("SCRIPT_EGRESS_ALLOW_PRIVATE", false, env),
    allowlist: parseEgressAllowlist(env.SCRIPT_EGRESS_ALLOWLIST),
  };
}

async function buildConfigPayload(input: RunScriptInput): Promise<SwarmConfigPayload> {
  const apiKey = input.apiKey ?? getApiKey();
  if (!apiKey) throw new Error("Swarm API key is required to run scripts");

  return {
    system: {
      apiKey: { value: apiKey, isSecret: true },
      agentId: { value: input.agentId, isSecret: false },
      // Script code reads mcpBaseUrl (and may fetch it, which the quickjs egress
      // guard allows only for a public host). The SDK clients use sdkBaseUrl.
      mcpBaseUrl: { value: input.mcpBaseUrl ?? getMcpBaseUrl(), isSecret: false },
      sdkBaseUrl: { value: input.mcpBaseUrl ?? getScriptApiBaseUrl(), isSecret: false },
      ...(input.runtimeInstanceId
        ? { runtimeInstanceId: { value: input.runtimeInstanceId, isSecret: false as const } }
        : {}),
      ...(input.sourceTaskId
        ? { auditSourceTaskId: { value: input.sourceTaskId, isSecret: false as const } }
        : {}),
    },
    user: input.userConfig ?? {},
    durable: input.durable,
    caller: input.caller,
    egressSecrets: input.egressSecrets ?? (await buildEgressSecrets()),
    failedBindings: input.failedBindings ?? [],
    apiConnections: input.apiConnections ?? [],
    mcpConnections: input.mcpConnections ?? [],
    ...(input.agentFs ? { agentFs: input.agentFs } : {}),
    ...(input.dbDialect ? { db: { dialect: input.dbDialect } } : {}),
  };
}

export async function prepareScriptJob(
  input: RunScriptInput,
): Promise<
  ExecutorOutput | { job: InlineScriptJob; scrubber: ReturnType<typeof createValueScrubber> }
> {
  if (input.fsMode === "workspace-rw") {
    return {
      result: undefined,
      stdout: "",
      stderr: "workspace-rw not supported in scripts-runtime v1",
      truncated: { stdout: false, stderr: false },
      durationMs: 0,
      exitCode: 1,
      error: "executor_error",
    };
  }

  if (!isExecutorAllowedByDeployment(input.executor)) {
    return {
      result: undefined,
      stdout: "",
      stderr: 'Executor "native" is not permitted when deployment SCRIPT_EXECUTOR="quickjs"',
      truncated: { stdout: false, stderr: false },
      durationMs: 0,
      exitCode: 1,
      error: "executor_error",
    };
  }

  // The global scrubber skips values under its length floor, so this run's own
  // secret config is redacted here at any length before the global pass. Built
  // before the import check: its diagnostic quotes source, which can hold a value.
  const runSecrets = createValueScrubber(
    Object.entries(input.userConfig ?? {})
      .filter(([, entry]) => entry.isSecret)
      .map(([key, entry]) => ({ value: entry.value, name: `config:${key}` })),
  );

  const imports = validateScriptImports(input.source);
  if (!imports.ok) {
    return {
      result: undefined,
      stdout: "",
      stderr: scrubSecrets(runSecrets.text(imports.diagnostic)),
      truncated: { stdout: false, stderr: false },
      durationMs: 0,
      exitCode: 1,
      error: "import_violation",
    };
  }

  const resources = {
    ...DEFAULT_SCRIPT_RESOURCES,
    ...input.resources,
    ...(input.timeoutMs ? { wallClockMs: input.timeoutMs } : {}),
  };

  const configPayload = await buildConfigPayload(input);
  const executorInput: InlineScriptJob["input"] = {
    source: input.source,
    args: input.args ?? null,
    ...(input[HOST_VALIDATED_ARGS] === true ? { hostValidatedArgs: true } : {}),
    configPayload,
    resources,
    fsMode: input.fsMode ?? "none",
    network: scriptEgressPolicy(),
  };

  const executor = resolveScriptExecutorName(input.executor);
  return {
    job: { id: crypto.randomUUID(), kind: "inline", executor, input: executorInput },
    scrubber: runSecrets,
  };
}

export function finishScriptJob(
  output: ExecutorOutput,
  runSecrets: ReturnType<typeof createValueScrubber>,
): RunScriptOutput {
  return {
    ...output,
    result: scrubObject(runSecrets.object(output.result)),
    stdout: scrubSecrets(runSecrets.text(output.stdout)),
    stderr: scrubSecrets(runSecrets.text(output.stderr)),
    ...(output.runtimeError
      ? { runtimeError: scrubObject(runSecrets.object(output.runtimeError)) }
      : {}),
  };
}

export async function runScript(input: RunScriptInput): Promise<RunScriptOutput> {
  const prepared = await prepareScriptJob(input);
  if (!("job" in prepared)) return prepared;
  const output = await dispatchScriptJob(prepared.job, { signal: input.signal });
  return finishScriptJob(output, prepared.scrubber);
}

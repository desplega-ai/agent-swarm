import { getApiKey } from "../utils/api-key";
import { scrubObject, scrubSecrets } from "../utils/secret-scrubber";
import type { ScriptApiConnectionDescriptor, ScriptMcpConnectionDescriptor } from "./api-types";
import type { FailedCredentialBinding } from "./credential-broker";
import { buildEgressSecrets } from "./egress-secrets";
import { getScriptExecutor } from "./executors/registry";
import {
  DEFAULT_SCRIPT_RESOURCES,
  type EgressSecretEntry,
  type ExecutorOutput,
  type ScriptFsMode,
  type ScriptResourcePolicy,
  type SwarmConfigPayload,
} from "./executors/types";
import { validateScriptImports } from "./import-allowlist";

/**
 * `capacity_exceeded` (see `ScriptExecutorError`) means the sandboxed process
 * aborted because a host-wide, shared RLIMIT_NPROC budget was momentarily
 * exhausted — not because the script failed. Retry transparently here, once,
 * for every caller (HTTP script runs, workflow script/swarm-script nodes,
 * scheduled scripts), independent of whatever concurrency limiter or retry
 * policy an individual caller does or doesn't configure. Short and bounded:
 * this is a blip mitigation, not a substitute for the caller's own retry
 * policy if the underlying contention is sustained.
 */
const CAPACITY_EXCEEDED_RETRY_DELAYS_MS = [200, 750];

export type RunScriptInput = {
  source: string;
  args?: unknown;
  fsMode?: ScriptFsMode;
  agentId: string;
  /** Per-boot runtime identity of the invoking worker; system context, never script input. */
  runtimeInstanceId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  mcpBaseUrl?: string;
  resources?: Partial<ScriptResourcePolicy>;
  userConfig?: Record<string, { value: string; isSecret: boolean }>;
  egressSecrets?: EgressSecretEntry[];
  failedBindings?: FailedCredentialBinding[];
  apiConnections?: ScriptApiConnectionDescriptor[];
  mcpConnections?: ScriptMcpConnectionDescriptor[];
};

export type RunScriptOutput = Omit<ExecutorOutput, "result" | "stdout" | "stderr"> & {
  result: unknown | undefined;
  stdout: string;
  stderr: string;
};

export type { ScriptRuntimeError, ScriptStackFrame } from "./executors/types";

async function buildConfigPayload(input: RunScriptInput): Promise<SwarmConfigPayload> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Swarm API key is required to run scripts");

  return {
    system: {
      apiKey: { value: apiKey, isSecret: true },
      agentId: { value: input.agentId, isSecret: false },
      mcpBaseUrl: {
        value: input.mcpBaseUrl ?? process.env.MCP_BASE_URL ?? "http://localhost:3013",
        isSecret: false,
      },
      ...(input.runtimeInstanceId
        ? { runtimeInstanceId: { value: input.runtimeInstanceId, isSecret: false as const } }
        : {}),
    },
    user: input.userConfig ?? {},
    egressSecrets: input.egressSecrets ?? (await buildEgressSecrets()),
    failedBindings: input.failedBindings ?? [],
    apiConnections: input.apiConnections ?? [],
    mcpConnections: input.mcpConnections ?? [],
  };
}

export async function runScript(input: RunScriptInput): Promise<RunScriptOutput> {
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

  const imports = validateScriptImports(input.source);
  if (!imports.ok) {
    return {
      result: undefined,
      stdout: "",
      stderr: imports.diagnostic,
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
  const executorInput = {
    source: input.source,
    args: input.args ?? null,
    configPayload,
    resources,
    fsMode: input.fsMode ?? "none",
    network: "open" as const,
    signal: input.signal,
  };

  let output = await getScriptExecutor().run(executorInput);
  for (const delayMs of CAPACITY_EXCEEDED_RETRY_DELAYS_MS) {
    if (output.error !== "capacity_exceeded" || input.signal?.aborted) break;
    await Bun.sleep(delayMs);
    output = await getScriptExecutor().run(executorInput);
  }

  return {
    ...output,
    result: scrubObject(output.result),
    stdout: scrubSecrets(output.stdout),
    stderr: scrubSecrets(output.stderr),
    ...(output.runtimeError ? { runtimeError: scrubObject(output.runtimeError) } : {}),
  };
}

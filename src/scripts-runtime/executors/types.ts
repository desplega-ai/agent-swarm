import type { ScriptApiConnectionDescriptor, ScriptMcpConnectionDescriptor } from "../api-types";
import type { FailedCredentialBinding, ResolvedCredentialBinding } from "../credential-broker";

export type ScriptFsMode = "none" | "workspace-rw";

export type EgressSecretEntry = ResolvedCredentialBinding;

export type SwarmConfigPayload = {
  system: {
    apiKey: { value: string; isSecret: true };
    agentId: { value: string; isSecret: false };
    mcpBaseUrl: { value: string; isSecret: false };
  };
  user: Record<string, { value: string; isSecret: boolean }>;
  egressSecrets?: EgressSecretEntry[];
  failedBindings?: FailedCredentialBinding[];
  apiConnections?: ScriptApiConnectionDescriptor[];
  mcpConnections?: ScriptMcpConnectionDescriptor[];
};

export type ScriptResourcePolicy = {
  memoryMb: number;
  cpuTimeSec: number;
  wallClockMs: number;
  maxProcs: number;
  maxFdCount: number;
  maxFileBytes: number;
  maxStdoutBytes: number;
};

export type ExecutorInput = {
  source: string;
  args: unknown;
  configPayload: SwarmConfigPayload;
  resources: ScriptResourcePolicy;
  fsMode: ScriptFsMode;
  network: "open" | { allowlist: string[] };
  signal?: AbortSignal;
};

export type ScriptExecutorError =
  | "timeout"
  | "oom"
  | "killed"
  | "import_violation"
  | "eval_error"
  | "executor_error";

export type ScriptStackFrame = {
  file: string;
  line: number;
  column: number;
  raw: string;
};

export type ScriptRuntimeError = {
  name: string;
  message: string;
  stack: string;
  userFrames: ScriptStackFrame[];
  userScriptLine?: number;
  userScriptColumn?: number;
};

export type ExecutorOutput = {
  result: unknown | undefined;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  durationMs: number;
  exitCode: number;
  error?: ScriptExecutorError;
  runtimeError?: ScriptRuntimeError;
};

export interface ScriptExecutor {
  readonly name: string;
  run(input: ExecutorInput): Promise<ExecutorOutput>;
}

export const MIN_SCRIPT_WALL_CLOCK_MS = 1_000;
// Above 2m, steer authors toward durable journaled steps before they reach the
// 5m hard cap and keep a blocking workflow node open for several minutes.
export const SCRIPT_LONG_TIMEOUT_HINT_MS = 120_000;
export const MAX_SCRIPT_WALL_CLOCK_MS = 300_000;

export const DEFAULT_SCRIPT_RESOURCES: ScriptResourcePolicy = {
  memoryMb: 512,
  // Keep CPU time lower than the wall-clock ceiling so waiting/network scripts
  // can run for 5m without allowing a hot loop to consume 5m of CPU.
  cpuTimeSec: 60,
  wallClockMs: 30_000,
  maxProcs: 32,
  maxFdCount: 64,
  maxFileBytes: 64_000_000,
  maxStdoutBytes: 1_048_576,
};

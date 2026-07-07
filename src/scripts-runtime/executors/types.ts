import type { ScriptApiConnectionDescriptor, ScriptMcpConnectionDescriptor } from "../api-types";
import type { ResolvedCredentialBinding } from "../credential-broker";

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

export const DEFAULT_SCRIPT_RESOURCES: ScriptResourcePolicy = {
  memoryMb: 512,
  cpuTimeSec: 60,
  wallClockMs: 30_000,
  maxProcs: 32,
  maxFdCount: 64,
  maxFileBytes: 64_000_000,
  maxStdoutBytes: 1_048_576,
};

/** Data for session cost tracking. Shared across all provider adapters. */
export interface CostData {
  sessionId: string;
  taskId?: string;
  agentId: string;
  totalCostUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs: number;
  numTurns: number;
  model: string;
  isError: boolean;
}

/** Normalized event emitted by any provider adapter. */
export type ProviderEvent =
  | { type: "session_init"; sessionId: string }
  | { type: "message"; role: "assistant" | "user"; content: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown }
  | { type: "result"; cost: CostData; output?: string; isError: boolean; errorCategory?: string }
  | { type: "error"; message: string; category?: string }
  | { type: "raw_log"; content: string }
  | { type: "raw_stderr"; content: string }
  | { type: "custom"; name: string; data: unknown }
  | {
      type: "context_usage";
      contextUsedTokens: number;
      contextTotalTokens: number;
      contextPercent: number;
      outputTokens: number;
    }
  | {
      type: "compaction";
      preCompactTokens: number;
      compactTrigger: "auto" | "manual";
      contextTotalTokens: number;
    };

/** Configuration passed to a provider adapter to create a session. */
export interface ProviderSessionConfig {
  prompt: string;
  systemPrompt: string;
  model: string;
  role: string;
  agentId: string;
  taskId: string;
  apiUrl: string;
  apiKey: string;
  cwd: string;
  resumeSessionId?: string;
  iteration?: number;
  logFile: string;
  /** Extra CLI args — used by Claude adapter, ignored by others. */
  additionalArgs?: string[];
  /** Resolved environment variables to pass to the spawned process. */
  env?: Record<string, string>;
}

/** A running provider session. */
export interface ProviderSession {
  readonly sessionId: string | undefined;
  onEvent(listener: (event: ProviderEvent) => void): void;
  waitForCompletion(): Promise<ProviderResult>;
  abort(): Promise<void>;
}

/** Result returned when a provider session completes. */
export interface ProviderResult {
  exitCode: number;
  sessionId?: string;
  cost?: CostData;
  output?: string;
  isError: boolean;
  errorCategory?: string;
  /** Human-readable failure reason built from error tracking. */
  failureReason?: string;
}

/** Main contract for a harness provider adapter. */
export interface ProviderAdapter {
  readonly name: string;
  createSession(config: ProviderSessionConfig): Promise<ProviderSession>;
  canResume(sessionId: string): Promise<boolean>;
  formatCommand(commandName: string): string;
}

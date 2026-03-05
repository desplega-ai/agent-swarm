import type { SessionErrorTracker } from "../../utils/error-tracker.ts";

export type HarnessProvider = "claude" | "pi";

export interface ProviderResultUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type ProviderRuntimeEvent =
  | {
      type: "session_init";
      sessionId: string;
      provider: HarnessProvider;
    }
  | {
      type: "stream_line";
      line: string;
      provider: HarnessProvider;
    }
  | {
      type: "result";
      provider: HarnessProvider;
      totalCostUsd?: number;
      usage?: ProviderResultUsage;
      durationMs?: number;
      numTurns?: number;
      isError?: boolean;
      raw?: Record<string, unknown>;
    }
  | {
      type: "stderr";
      content: string;
      provider: HarnessProvider;
    }
  | {
      type: "provider_error";
      error: string;
      provider: HarnessProvider;
    }
  | {
      type: "process_exit";
      exitCode: number;
      provider: HarnessProvider;
    };

export interface ProviderStartContext {
  prompt: string;
  logFile: string;
  role: string;
  model: string;
  env: Record<string, string | undefined>;
  systemPrompt?: string;
  additionalArgs?: string[];
  apiUrl?: string;
  apiKey?: string;
  agentId?: string;
  sessionId?: string;
  iteration?: number;
  taskId?: string;
  taskFilePath?: string;
  resumeSessionId?: string;
  onEvent: (event: ProviderRuntimeEvent) => Promise<void>;
}

export interface ProviderRunResult {
  exitCode: number;
  errorTracker: SessionErrorTracker;
}

export interface ProviderRunHandle {
  taskId: string;
  provider: HarnessProvider;
  process?: ReturnType<typeof Bun.spawn>;
  promise: Promise<ProviderRunResult>;
  cancel: () => Promise<void>;
}

export interface ProviderResumeContext {
  sessionId?: string;
  additionalArgs: string[];
}

export interface ProviderSessionTask {
  claudeSessionId?: string;
  runtimeMetadata?: {
    provider?: HarnessProvider;
    sessionId?: string;
    sessionPath?: string;
  };
}

export interface ProviderAdapter {
  readonly provider: HarnessProvider;
  startRun(context: ProviderStartContext): Promise<ProviderRunHandle>;
  cancel(runHandle: ProviderRunHandle): Promise<void>;
  buildResumeContext(
    task: ProviderSessionTask,
    parentTask?: ProviderSessionTask,
  ): ProviderResumeContext;
}

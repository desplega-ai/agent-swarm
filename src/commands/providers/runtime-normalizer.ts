import type { ProviderResultUsage, ProviderRuntimeEvent } from "./types.ts";

export interface NormalizedCostData {
  totalCostUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
}

export interface ProviderPersistenceCallbacks {
  onSessionInit: (sessionId: string) => Promise<void>;
  onStreamLine: (line: string) => Promise<void>;
  onCostData: (cost: NormalizedCostData) => Promise<void>;
  onStderr?: (stderr: string) => Promise<void>;
  onProviderError?: (error: string) => Promise<void>;
}

export function normalizeUsage(usage?: ProviderResultUsage): Required<ProviderResultUsage> {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
  };
}

export function createProviderEventProcessor(callbacks: ProviderPersistenceCallbacks) {
  return async (event: ProviderRuntimeEvent): Promise<void> => {
    switch (event.type) {
      case "session_init":
        await callbacks.onSessionInit(event.sessionId);
        return;

      case "stream_line":
        await callbacks.onStreamLine(event.line);
        return;

      case "result": {
        if (event.totalCostUsd === undefined) return;
        const usage = normalizeUsage(event.usage);
        await callbacks.onCostData({
          totalCostUsd: event.totalCostUsd,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          durationMs: event.durationMs ?? 0,
          numTurns: event.numTurns ?? 1,
          isError: event.isError ?? false,
        });
        return;
      }

      case "stderr":
        if (callbacks.onStderr) {
          await callbacks.onStderr(event.content);
        }
        return;

      case "provider_error":
        if (callbacks.onProviderError) {
          await callbacks.onProviderError(event.error);
        }
        return;

      case "process_exit":
        return;

      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  };
}

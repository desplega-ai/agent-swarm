import {
  CONTEXT_FORMULA,
  clampContextPercent,
  computeContextUsedUnified,
  getContextWindowSize,
} from "../utils/context-window";
import { scrubSecrets } from "../utils/secret-scrubber";
import type { CostData, ProviderEvent } from "./types";

type ClaudeMessageState = {
  taskId: string;
  agentId: string;
  model: string;
  contextWindowSize: number;
  harnessVariant?: string;
  harnessVariantMeta?: Record<string, unknown>;
  transport: "cli" | "sdk";
};

type ClaudeContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  content?: unknown;
};

type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  thinking_input_tokens?: number;
  cache_creation?: Record<string, unknown>;
};

export type ClaudeProtocolMessage = {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  compact_metadata?: { pre_tokens?: number; trigger?: "auto" | "manual" | "auto-inferred" };
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  modelUsage?: Record<string, unknown>;
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  parent_tool_use_id?: string | null;
  message?: { content?: ClaudeContentBlock[]; usage?: ClaudeUsage };
};

export type NormalizedClaudeMessage = {
  events: ProviderEvent[];
  transcriptEntries: string[];
  sessionId?: string;
  model?: string;
  contextWindowSize?: number;
  cost?: CostData;
  assistantText?: string;
  isResult: boolean;
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tokenCount(value: unknown): number | undefined {
  const valueAsNumber = finiteNumber(value);
  return valueAsNumber !== undefined && valueAsNumber >= 0 ? valueAsNumber : undefined;
}

function costFromResult(
  json: ClaudeProtocolMessage,
  state: ClaudeMessageState,
): CostData | undefined {
  if (json.type !== "result" || json.total_cost_usd === undefined) return undefined;
  const usage = json.usage;
  const cacheCreation = usage?.cache_creation;
  const mappedModels =
    json.modelUsage && typeof json.modelUsage === "object" && !Array.isArray(json.modelUsage)
      ? Object.entries(json.modelUsage as Record<string, unknown>).map(([model, entry]) => {
          const modelUsage =
            entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
          if (!modelUsage) return null;
          const inputTokens = tokenCount(modelUsage.inputTokens);
          const outputTokens = tokenCount(modelUsage.outputTokens);
          const cacheReadTokens = tokenCount(modelUsage.cacheReadInputTokens);
          const cacheWriteTokens = tokenCount(modelUsage.cacheCreationInputTokens);
          if (
            inputTokens === undefined ||
            outputTokens === undefined ||
            cacheReadTokens === undefined ||
            cacheWriteTokens === undefined
          ) {
            return null;
          }
          const webSearchRequests = tokenCount(modelUsage.webSearchRequests);
          const harnessCostUsd = finiteNumber(modelUsage.costUSD);
          return {
            model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            ...(webSearchRequests === undefined ? {} : { webSearchRequests }),
            ...(harnessCostUsd === undefined ? {} : { harnessCostUsd }),
          };
        })
      : undefined;
  const models =
    mappedModels && mappedModels.length > 0 && mappedModels.every((entry) => entry !== null)
      ? (mappedModels as NonNullable<CostData["models"]>)
      : undefined;

  return {
    sessionId: "",
    taskId: state.taskId,
    agentId: state.agentId,
    totalCostUsd: json.total_cost_usd || 0,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheWrite5mTokens: finiteNumber(cacheCreation?.ephemeral_5m_input_tokens),
    cacheWrite1hTokens: finiteNumber(cacheCreation?.ephemeral_1h_input_tokens),
    thinkingTokens: usage?.thinking_input_tokens ?? 0,
    models,
    durationMs: json.duration_ms || 0,
    numTurns: json.num_turns ?? null,
    model: state.model,
    isError: json.is_error || json.subtype !== "success",
    provider: "claude",
  };
}

export function normalizeClaudeMessage(
  json: ClaudeProtocolMessage,
  state: ClaudeMessageState,
): NormalizedClaudeMessage {
  const events: ProviderEvent[] = [];
  const transcriptEntries: string[] = [];
  let sessionId: string | undefined;
  let model: string | undefined;
  let contextWindowSize: number | undefined;
  let assistantText: string | undefined;

  if (json.type === "system" && json.subtype === "init" && json.session_id) {
    sessionId = json.session_id;
    model = typeof json.model === "string" ? json.model : undefined;
    if (model) contextWindowSize = getContextWindowSize(model);
    events.push({
      type: "session_init",
      sessionId: json.session_id,
      provider: "claude",
      providerMeta: { transport: state.transport },
      ...(state.harnessVariant ? { harnessVariant: state.harnessVariant } : {}),
      ...(state.harnessVariantMeta ? { harnessVariantMeta: state.harnessVariantMeta } : {}),
    });
  }

  if (json.type === "system" && json.subtype === "compact_boundary" && json.compact_metadata) {
    events.push({
      type: "compaction",
      preCompactTokens: json.compact_metadata.pre_tokens ?? 0,
      compactTrigger: json.compact_metadata.trigger ?? "auto",
      contextTotalTokens: state.contextWindowSize,
    });
  }

  const cost = costFromResult(json, state);
  if (cost) {
    events.push({
      type: "result",
      cost,
      isError: cost.isError,
      ...(cost.isError ? { errorCategory: json.subtype ?? "execution_error" } : {}),
    });
    const firstModel = Object.values(json.modelUsage ?? {})[0] as
      | { contextWindow?: unknown }
      | undefined;
    contextWindowSize = tokenCount(firstModel?.contextWindow) ?? contextWindowSize;
  }

  if (json.type === "assistant" && json.message) {
    const blocks = Array.isArray(json.message.content) ? json.message.content : [];
    const text = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    events.push({ type: "message", role: "assistant", content: text });
    if (text && !json.parent_tool_use_id) {
      assistantText = text;
      transcriptEntries.push(`Assistant: ${scrubSecrets(text)}`);
    }
    for (const block of blocks) {
      if (block?.type !== "tool_use" || !block.name) continue;
      transcriptEntries.push(
        `Tool[${block.name}] started: ${scrubSecrets(JSON.stringify(block.input ?? {}))}`,
      );
      events.push({
        type: "tool_start",
        toolCallId: block.id || "",
        toolName: block.name,
        args: block.input || {},
      });
    }
    if (json.message.usage) {
      const usage = json.message.usage;
      const contextUsed = computeContextUsedUnified({
        inputTokens: usage.input_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreateTokens: usage.cache_creation_input_tokens,
        outputTokens: usage.output_tokens,
      });
      events.push({
        type: "context_usage",
        contextUsedTokens: contextUsed,
        contextTotalTokens: state.contextWindowSize,
        contextPercent: clampContextPercent(contextUsed, state.contextWindowSize) ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        contextFormula: CONTEXT_FORMULA,
      });
    }
  }

  if (json.type === "user" && Array.isArray(json.message?.content)) {
    for (const block of json.message.content) {
      if (block?.type !== "tool_result") continue;
      const content =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      transcriptEntries.push(`Tool result: ${scrubSecrets(content)}`);
    }
  }

  return {
    events,
    transcriptEntries,
    sessionId,
    model,
    contextWindowSize,
    cost,
    assistantText,
    isResult: json.type === "result",
  };
}

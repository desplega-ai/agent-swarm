import type {
  ContentBlock,
  SessionNotification,
  SessionUpdate,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { clampContextPercent } from "../utils/context-window";
import type { ProviderEvent } from "./types";

export interface AcpUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningOutputTokens?: number;
  thinkingTokens?: number;
  totalCostUsd?: number;
}

function contentToText(content: ContentBlock): string {
  if (content.type === "text") return content.text;
  return JSON.stringify(content);
}

function toolName(update: { kind?: string | null; title?: string | null }): string {
  return update.title ?? update.kind ?? "tool";
}

function toolResult(update: ToolCallUpdate): unknown {
  return {
    status: update.status,
    content: update.content,
    rawOutput: update.rawOutput,
    locations: update.locations,
  };
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function extractAcpUsageMetrics(update: unknown): AcpUsageMetrics {
  if (!update || typeof update !== "object") return {};
  const record = update as Record<string, unknown>;
  const metrics: AcpUsageMetrics = {};
  const metaMetrics = extractAcpUsageMetrics(record._meta);
  Object.assign(metrics, metaMetrics);

  if (record.usage && typeof record.usage === "object") {
    const usage = record.usage as Record<string, unknown>;
    const inputTokens = finiteNumber(usage.inputTokens);
    const outputTokens = finiteNumber(usage.outputTokens);
    const cacheReadTokens = finiteNumber(usage.cachedReadTokens);
    const cacheWriteTokens = finiteNumber(usage.cachedWriteTokens);
    const reasoningOutputTokens = finiteNumber(usage.thoughtTokens);
    if (inputTokens !== undefined) metrics.inputTokens = inputTokens;
    if (outputTokens !== undefined) metrics.outputTokens = outputTokens;
    if (cacheReadTokens !== undefined) metrics.cacheReadTokens = cacheReadTokens;
    if (cacheWriteTokens !== undefined) metrics.cacheWriteTokens = cacheWriteTokens;
    if (reasoningOutputTokens !== undefined) metrics.reasoningOutputTokens = reasoningOutputTokens;
  }

  if (record.cost && typeof record.cost === "object") {
    const cost = record.cost as Record<string, unknown>;
    if (cost.currency === "USD") {
      const amount = finiteNumber(cost.amount);
      if (amount !== undefined) metrics.totalCostUsd = amount;
    }
  }

  const inputTokens = firstNumber(record, [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
  ]);
  const outputTokens = firstNumber(record, [
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
  ]);
  const cacheReadTokens = firstNumber(record, [
    "cacheReadTokens",
    "cache_read_tokens",
    "cachedInputTokens",
    "cached_input_tokens",
  ]);
  const cacheWriteTokens = firstNumber(record, [
    "cacheWriteTokens",
    "cache_write_tokens",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
  ]);
  const reasoningOutputTokens = firstNumber(record, [
    "reasoningOutputTokens",
    "reasoning_output_tokens",
  ]);
  const thinkingTokens = firstNumber(record, ["thinkingTokens", "thinking_tokens"]);
  const totalCostUsd = firstNumber(record, [
    "totalCostUsd",
    "total_cost_usd",
    "costUsd",
    "cost_usd",
  ]);

  if (inputTokens !== undefined) metrics.inputTokens = inputTokens;
  if (outputTokens !== undefined) metrics.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) metrics.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) metrics.cacheWriteTokens = cacheWriteTokens;
  if (reasoningOutputTokens !== undefined) metrics.reasoningOutputTokens = reasoningOutputTokens;
  if (thinkingTokens !== undefined) metrics.thinkingTokens = thinkingTokens;
  if (totalCostUsd !== undefined) metrics.totalCostUsd = totalCostUsd;
  return metrics;
}

function usageUpdateEvents(update: SessionUpdate): ProviderEvent[] {
  const record = update as Record<string, unknown>;
  const used = finiteNumber(record.used);
  const size = finiteNumber(record.size);
  const metrics = extractAcpUsageMetrics(update);
  const events: ProviderEvent[] = [
    {
      type: "custom",
      name: "acp_usage_update",
      data: { update, metrics },
    },
  ];

  if (used === undefined) return events;

  events.unshift({
    type: "context_usage",
    contextUsedTokens: used,
    contextTotalTokens: size ?? null,
    contextPercent: clampContextPercent(used, size ?? null),
    outputTokens: metrics.outputTokens ?? null,
    contextFormula: "harness-reported",
  });
  return events;
}

export function translateAcpSessionUpdate(update: SessionUpdate): ProviderEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return [{ type: "message", role: "assistant", content: contentToText(update.content) }];
    case "user_message_chunk":
      return [{ type: "message", role: "user", content: contentToText(update.content) }];
    case "agent_thought_chunk":
      return [
        {
          type: "custom",
          name: "acp_agent_thought_chunk",
          data: { content: update.content, messageId: update.messageId ?? null },
        },
      ];
    case "tool_call":
      return [
        {
          type: "tool_start",
          toolCallId: update.toolCallId,
          toolName: toolName(update),
          args: update.rawInput ?? update.content ?? null,
        },
      ];
    case "tool_call_update": {
      if (update.status === "completed" || update.status === "failed") {
        return [
          {
            type: "tool_end",
            toolCallId: update.toolCallId,
            toolName: toolName(update),
            result: toolResult(update),
          },
        ];
      }
      return [
        {
          type: "progress",
          message: `ACP tool ${update.toolCallId}${update.status ? ` ${update.status}` : " updated"}`,
        },
        {
          type: "custom",
          name: "acp_tool_call_update",
          data: update,
        },
      ];
    }
    case "current_mode_update":
      return [{ type: "custom", name: "acp_current_mode_update", data: update }];
    case "plan":
      return [{ type: "custom", name: "acp_plan", data: update }];
    case "available_commands_update":
      return [{ type: "custom", name: "acp_available_commands_update", data: update }];
    case "config_option_update":
      return [{ type: "custom", name: "acp_config_option_update", data: update }];
    case "session_info_update":
      return [{ type: "custom", name: "acp_session_info_update", data: update }];
    case "usage_update":
      return usageUpdateEvents(update);
  }
}

export function translateAcpSessionNotification(
  notification: SessionNotification,
): ProviderEvent[] {
  return translateAcpSessionUpdate(notification.update);
}

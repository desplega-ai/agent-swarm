import type {
  ContentBlock,
  SessionNotification,
  SessionUpdate,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { ProviderEvent } from "./types";

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
      return [
        {
          type: "context_usage",
          contextUsedTokens: update.used,
          contextTotalTokens: update.size,
          contextPercent: update.size > 0 ? update.used / update.size : null,
          outputTokens: null,
          contextFormula: "harness-reported",
        },
      ];
  }
}

export function translateAcpSessionNotification(
  notification: SessionNotification,
): ProviderEvent[] {
  return translateAcpSessionUpdate(notification.update);
}

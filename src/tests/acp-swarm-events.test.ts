import { describe, expect, test } from "bun:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { translateAcpSessionNotification } from "../providers/acp-swarm-events";

function notification(update: SessionNotification["update"]): SessionNotification {
  return { sessionId: "session-1", update };
}

describe("translateAcpSessionNotification", () => {
  test("maps agent message chunks to assistant messages", () => {
    const events = translateAcpSessionNotification(
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      }),
    );
    expect(events).toEqual([{ type: "message", role: "assistant", content: "hello" }]);
  });

  test("maps thought chunks to custom events", () => {
    const events = translateAcpSessionNotification(
      notification({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
        messageId: "msg-1",
      }),
    );
    expect(events).toEqual([
      {
        type: "custom",
        name: "acp_agent_thought_chunk",
        data: { content: { type: "text", text: "thinking" }, messageId: "msg-1" },
      },
    ]);
  });

  test("maps tool starts and terminal updates", () => {
    expect(
      translateAcpSessionNotification(
        notification({
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Read file",
          kind: "read",
          rawInput: { path: "README.md" },
        }),
      ),
    ).toEqual([
      {
        type: "tool_start",
        toolCallId: "tool-1",
        toolName: "Read file",
        args: { path: "README.md" },
      },
    ]);

    expect(
      translateAcpSessionNotification(
        notification({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          title: "Read file",
          status: "completed",
          rawOutput: "ok",
        }),
      ),
    ).toEqual([
      {
        type: "tool_end",
        toolCallId: "tool-1",
        toolName: "Read file",
        result: {
          status: "completed",
          content: undefined,
          rawOutput: "ok",
          locations: undefined,
        },
      },
    ]);
  });

  test("maps mode, plan, usage, and in-progress tool updates", () => {
    expect(
      translateAcpSessionNotification(
        notification({ sessionUpdate: "current_mode_update", currentModeId: "code" }),
      )[0],
    ).toEqual({
      type: "custom",
      name: "acp_current_mode_update",
      data: { sessionUpdate: "current_mode_update", currentModeId: "code" },
    });

    expect(
      translateAcpSessionNotification(
        notification({
          sessionUpdate: "plan",
          entries: [{ content: "Ship it", priority: "high", status: "in_progress" }],
        }),
      )[0],
    ).toEqual({
      type: "custom",
      name: "acp_plan",
      data: {
        sessionUpdate: "plan",
        entries: [{ content: "Ship it", priority: "high", status: "in_progress" }],
      },
    });

    const usageEvents = translateAcpSessionNotification(
      notification({
        sessionUpdate: "usage_update",
        used: 20,
        size: 100,
        cost: { amount: 0.02, currency: "USD" },
        _meta: {
          inputTokens: 12,
          output_tokens: 8,
        },
      } as SessionNotification["update"]),
    );
    expect(usageEvents[0]).toEqual({
      type: "context_usage",
      contextUsedTokens: 20,
      contextTotalTokens: 100,
      contextPercent: 20,
      outputTokens: 8,
      contextFormula: "harness-reported",
    });
    expect(usageEvents[1]).toEqual({
      type: "custom",
      name: "acp_usage_update",
      data: {
        update: {
          sessionUpdate: "usage_update",
          used: 20,
          size: 100,
          cost: { amount: 0.02, currency: "USD" },
          _meta: {
            inputTokens: 12,
            output_tokens: 8,
          },
        },
        metrics: {
          inputTokens: 12,
          outputTokens: 8,
          totalCostUsd: 0.02,
        },
      },
    });

    expect(
      translateAcpSessionNotification(
        notification({ sessionUpdate: "usage_update", size: 100 } as SessionNotification["update"]),
      ).map((event) => event.type),
    ).toEqual(["custom"]);

    expect(
      translateAcpSessionNotification(
        notification({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-2",
          status: "in_progress",
        }),
      ).map((event) => event.type),
    ).toEqual(["progress", "custom"]);
  });
});

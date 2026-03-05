import type { ProviderRuntimeEvent } from "./types.ts";

export type HookEventName = "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop";

export interface HookInvocation {
  hookEventName: HookEventName;
  payload: Record<string, unknown>;
}

export function mapProviderEventToHookLifecycle(event: ProviderRuntimeEvent): HookEventName[] {
  switch (event.type) {
    case "session_init":
      return ["SessionStart"];
    case "stream_line":
      return [];
    case "result":
      return [];
    case "stderr":
      return [];
    case "provider_error":
      return [];
    case "process_exit":
      return ["Stop"];
    default: {
      const _never: never = event;
      return _never;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickToolName(event: Record<string, unknown>): string | undefined {
  const direct = event.toolName ?? event.tool_name ?? event.name;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }

  const tool = asRecord(event.tool);
  const nested = tool?.name;
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

function pickToolInput(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates = [event.toolInput, event.tool_input, event.input, event.args];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (record) return record;
  }

  const tool = asRecord(event.tool);
  return asRecord(tool?.input);
}

function pickToolResponse(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates = [event.toolResponse, event.tool_response, event.output, event.result];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (record) return record;
  }

  const tool = asRecord(event.tool);
  return asRecord(tool?.output);
}

export function mapPiSdkEventToHookInvocations(rawEvent: unknown): HookInvocation[] {
  const event = asRecord(rawEvent);
  if (!event) return [];

  const type = typeof event.type === "string" ? event.type : "";
  if (!type) return [];

  if (type === "agent_start" || type === "session_start") {
    return [{ hookEventName: "SessionStart", payload: {} }];
  }

  if (type === "agent_end" || type === "session_end") {
    return [{ hookEventName: "Stop", payload: {} }];
  }

  if (type === "tool_execution_start" || type === "before_tool_call") {
    const tool_name = pickToolName(event);
    const tool_input = pickToolInput(event);
    return [
      {
        hookEventName: "PreToolUse",
        payload: {
          ...(tool_name ? { tool_name } : {}),
          ...(tool_input ? { tool_input } : {}),
        },
      },
    ];
  }

  if (type === "tool_execution_end" || type === "after_tool_call") {
    const tool_name = pickToolName(event);
    const tool_response = pickToolResponse(event);
    return [
      {
        hookEventName: "PostToolUse",
        payload: {
          ...(tool_name ? { tool_name } : {}),
          ...(tool_response ? { tool_response } : {}),
        },
      },
    ];
  }

  return [];
}

export function extractHookBlockDecision(output: string): { blocked: boolean; reason?: string } {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { decision?: string; reason?: string };
      if (parsed.decision === "block") {
        return { blocked: true, reason: parsed.reason || "Hook blocked tool execution" };
      }
    } catch {
      // Ignore non-JSON lines in hook output.
    }
  }

  return { blocked: false };
}

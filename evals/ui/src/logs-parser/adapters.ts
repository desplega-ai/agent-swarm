import { asString, isRecord, makeItem, resultBlockText } from "./helpers.ts";
import type { DecodedRecord, LogRole, NormalizedItem } from "./types.ts";

export function normalizeAnthropic(ordered: DecodedRecord[]): NormalizedItem[] {
  const items: NormalizedItem[] = [];

  for (const d of ordered) {
    const ev = d.event;
    if (isParseError(ev)) {
      items.push(makeItem(d, "parse_error", { role: "system", raw: ev.raw }));
      continue;
    }
    if (!isRecord(ev)) {
      items.push(makeItem(d, "unknown", { role: "system", raw: ev }));
      continue;
    }

    if (isRecord(ev.provider_meta)) {
      items.push(makeItem(d, "lifecycle", { role: "system", meta: ev }));
      continue;
    }

    const message = isRecord(ev.message) ? ev.message : undefined;
    const rawContent = message?.content;
    const role = roleFromAnthropicEvent(ev, message);

    if (typeof rawContent === "string") {
      items.push(makeItem(d, "text", { role, text: rawContent }));
      continue;
    }

    if (!Array.isArray(rawContent) || rawContent.length === 0) {
      const type = asString(ev.type);
      const kind =
        type === "result" ? "result" : knownLifecycleType(type) ? "lifecycle" : "unknown";
      items.push(
        makeItem(d, kind, { role: "system", meta: ev, raw: kind === "unknown" ? ev : undefined }),
      );
      continue;
    }

    for (const block of rawContent) {
      if (!isRecord(block)) {
        items.push(makeItem(d, "unknown", { role: "system", raw: block }));
        continue;
      }

      switch (block.type) {
        case "text": {
          items.push(makeItem(d, "text", { role, text: String(block.text ?? "") }));
          break;
        }
        case "thinking": {
          items.push(
            makeItem(d, "reasoning", {
              role,
              text: String(block.thinking ?? block.text ?? ""),
            }),
          );
          break;
        }
        case "tool_use": {
          items.push(
            makeItem(d, "tool_call", {
              role,
              tool: {
                id: String(block.id ?? ""),
                name: String(block.name ?? "unknown"),
                input: block.input,
              },
            }),
          );
          break;
        }
        case "tool_result": {
          items.push(
            makeItem(d, "tool_result", {
              role: "user",
              result: {
                id: String(block.tool_use_id ?? ""),
                payload: block.content,
                isError: block.is_error === true,
              },
              meta: isRecord(block.details) ? { details: block.details } : undefined,
            }),
          );
          break;
        }
        default: {
          items.push(makeItem(d, "unknown", { role: "system", raw: block }));
          break;
        }
      }
    }
  }

  return items;
}

export function normalizeCodex(ordered: DecodedRecord[]): NormalizedItem[] {
  const items: NormalizedItem[] = [];

  for (const d of ordered) {
    const ev = d.event;
    if (isParseError(ev)) {
      items.push(makeItem(d, "parse_error", { role: "system", raw: ev.raw }));
      continue;
    }
    if (!isRecord(ev)) {
      items.push(makeItem(d, "unknown", { role: "system", raw: ev }));
      continue;
    }

    const item = isRecord(ev.item) ? ev.item : undefined;
    switch (ev.type) {
      case "item.started": {
        if (item && (item.type === "command_execution" || item.type === "mcp_tool_call")) {
          items.push(
            makeItem(d, "tool_call", {
              role: "assistant",
              tool: {
                id: String(item.id ?? ""),
                name: codexToolName(item),
                input: codexCallInput(item),
              },
            }),
          );
        } else {
          // progress markers (agent_message/reasoning starts) — keep them visible as meta
          items.push(makeItem(d, "lifecycle", { role: "system", meta: ev }));
        }
        break;
      }
      case "item.completed": {
        if (!item) {
          items.push(makeItem(d, "lifecycle", { role: "system", meta: ev }));
          break;
        }
        switch (item.type) {
          case "command_execution":
          case "mcp_tool_call": {
            items.push(
              makeItem(d, "tool_result", {
                role: "user",
                result: {
                  id: String(item.id ?? ""),
                  payload: item.result ?? item.aggregated_output ?? "",
                  isError: typeof item.exit_code === "number" && item.exit_code !== 0,
                },
              }),
            );
            break;
          }
          case "agent_message": {
            if (typeof item.text === "string") {
              items.push(makeItem(d, "text", { role: "assistant", text: item.text }));
            } else {
              items.push(makeItem(d, "lifecycle", { role: "system", meta: ev }));
            }
            break;
          }
          case "reasoning": {
            const text = typeof item.text === "string" ? item.text : asString(item.summary);
            if (text) items.push(makeItem(d, "reasoning", { role: "assistant", text }));
            else items.push(makeItem(d, "lifecycle", { role: "system", meta: ev }));
            break;
          }
          case "file_change": {
            items.push(makeItem(d, "file_change", { role: "system", diff: item.changes ?? item }));
            break;
          }
          case "web_search":
          case "todo_list": {
            items.push(
              makeItem(d, "tool_call", {
                role: "assistant",
                tool: { id: String(item.id ?? ""), name: String(item.type), input: item },
              }),
            );
            break;
          }
          default: {
            items.push(makeItem(d, "unknown", { role: "system", raw: ev }));
            break;
          }
        }
        break;
      }
      case "turn.completed": {
        items.push(makeItem(d, "lifecycle", { role: "system", meta: ev }));
        break;
      }
      case "thread.started":
      case "turn.started":
      case "turn.failed": {
        items.push(makeItem(d, "lifecycle", { role: "system", meta: ev }));
        break;
      }
      default: {
        items.push(makeItem(d, "unknown", { role: "system", raw: ev }));
        break;
      }
    }
  }

  return items;
}

export function normalizeClaudeManaged(ordered: DecodedRecord[]): NormalizedItem[] {
  const items: NormalizedItem[] = [];

  for (const d of ordered) {
    const ev = d.event;
    if (isParseError(ev)) {
      items.push(makeItem(d, "parse_error", { role: "system", raw: ev.raw }));
      continue;
    }
    if (!isRecord(ev)) {
      items.push(makeItem(d, "unknown", { role: "system", raw: ev }));
      continue;
    }

    switch (ev.type) {
      case "agent.message": {
        const text = resultBlockText(ev.content);
        if (text) items.push(makeItem(d, "text", { role: "assistant", text }));
        else items.push(makeItem(d, "lifecycle", { role: "system", meta: ev }));
        break;
      }
      case "user.message": {
        const text = resultBlockText(ev.content);
        if (text) items.push(makeItem(d, "text", { role: "user", text }));
        else items.push(makeItem(d, "lifecycle", { role: "system", meta: ev }));
        break;
      }
      case "agent.tool_use": {
        items.push(
          makeItem(d, "tool_call", {
            role: "assistant",
            tool: {
              id: String(ev.id ?? ""),
              name: String(ev.name ?? "tool"),
              input: ev.input,
            },
          }),
        );
        break;
      }
      case "agent.mcp_tool_use": {
        const server = String(ev.mcp_server_name ?? "mcp");
        const name = String(ev.name ?? "unknown");
        items.push(
          makeItem(d, "tool_call", {
            role: "assistant",
            tool: {
              id: String(ev.id ?? ""),
              name: `${server}.${name}`,
              input: ev.input,
            },
          }),
        );
        break;
      }
      case "agent.tool_result": {
        items.push(
          makeItem(d, "tool_result", {
            role: "user",
            result: {
              id: String(ev.tool_use_id ?? ""),
              payload: ev.content ?? "",
              isError: ev.is_error === true,
            },
          }),
        );
        break;
      }
      case "agent.mcp_tool_result": {
        items.push(
          makeItem(d, "tool_result", {
            role: "user",
            result: {
              id: String(ev.mcp_tool_use_id ?? ""),
              payload: ev.content ?? "",
              isError: ev.is_error === true,
            },
          }),
        );
        break;
      }
      default: {
        items.push(makeItem(d, "lifecycle", { role: "system", meta: ev }));
        break;
      }
    }
  }

  return items;
}

export function normalizeOpencode(ordered: DecodedRecord[]): NormalizedItem[] {
  const partType = new Map<string, string>();
  const items: NormalizedItem[] = [];

  for (const d of ordered) {
    const ev = d.event;
    if (!isRecord(ev)) continue;
    const props = isRecord(ev.properties) ? ev.properties : undefined;
    const part = props && isRecord(props.part) ? props.part : undefined;
    if (ev.type === "message.part.updated" && part?.id) {
      partType.set(String(part.id), String(part.type ?? "text"));
    }
  }

  const acc = new Map<string, { chunks: string[]; first: DecodedRecord; recIds: string[] }>();
  const orderedOutput: Array<
    | { kind: "part"; partId: string }
    | { kind: "event"; d: DecodedRecord; event: Record<string, unknown> }
  > = [];

  for (const d of ordered) {
    const ev = d.event;
    if (isParseError(ev)) {
      orderedOutput.push({ kind: "event", d, event: { type: "parse_error", raw: ev.raw } });
      continue;
    }
    if (!isRecord(ev)) {
      orderedOutput.push({ kind: "event", d, event: { type: "unknown", raw: ev } });
      continue;
    }

    if (ev.type === "message.part.delta") {
      const props = isRecord(ev.properties) ? ev.properties : undefined;
      const partId = props?.partID ?? props?.partId;
      if (!partId) {
        orderedOutput.push({ kind: "event", d, event: { type: "unknown", raw: ev } });
        continue;
      }
      const id = String(partId);
      const stream = acc.get(id);
      if (!stream) {
        acc.set(id, { chunks: [String(props?.delta ?? "")], first: d, recIds: [] });
        orderedOutput.push({ kind: "part", partId: id });
      } else {
        stream.chunks.push(String(props?.delta ?? ""));
        stream.recIds.push(d.rec.id);
      }
      continue;
    }

    // consumed for part typing in the pre-pass; still surfaced as an internal event
    orderedOutput.push({ kind: "event", d, event: ev });
  }

  for (const output of orderedOutput) {
    if (output.kind === "part") {
      const stream = acc.get(output.partId);
      if (!stream) continue;
      const type = partType.get(output.partId);
      items.push(
        makeItem(stream.first, type === "reasoning" ? "reasoning" : "text", {
          role: "assistant",
          text: stream.chunks.join(""),
          meta: { partID: output.partId, rawCount: stream.chunks.length },
          coveredRecIds: stream.recIds,
        }),
      );
      continue;
    }

    emitOpencodeEvent(items, output.d, output.event);
  }

  return items;
}

function emitOpencodeEvent(
  items: NormalizedItem[],
  d: DecodedRecord,
  event: Record<string, unknown>,
) {
  switch (event.type) {
    case "parse_error": {
      items.push(makeItem(d, "parse_error", { role: "system", raw: event.raw }));
      break;
    }
    case "tool_start": {
      items.push(
        makeItem(d, "tool_call", {
          role: "assistant",
          tool: {
            id: String(event.toolCallId ?? ""),
            name: String(event.toolName ?? "tool"),
            input: event.args,
          },
        }),
      );
      break;
    }
    case "tool_end": {
      items.push(
        makeItem(d, "tool_result", {
          role: "user",
          result: {
            id: String(event.toolCallId ?? ""),
            payload: event.result,
            isError: event.isError === true,
          },
        }),
      );
      break;
    }
    case "result": {
      items.push(makeItem(d, "result", { role: "system", meta: event }));
      break;
    }
    case "context_usage": {
      items.push(makeItem(d, "lifecycle", { role: "system", meta: event }));
      break;
    }
    case "session_init": {
      items.push(makeItem(d, "lifecycle", { role: "system", meta: event }));
      break;
    }
    case "server.heartbeat":
    case "server.connected": {
      items.push(makeItem(d, "lifecycle", { role: "system", meta: event }));
      break;
    }
    case "file.edited":
    case "session.diff": {
      items.push(makeItem(d, "file_change", { role: "system", diff: event.properties ?? event }));
      break;
    }
    case "session.error": {
      const props = isRecord(event.properties) ? event.properties : undefined;
      const error = props && isRecord(props.error) ? props.error : undefined;
      const data = error && isRecord(error.data) ? error.data : undefined;
      const msg = data?.message ?? error?.name ?? "session error";
      items.push(makeItem(d, "text", { role: "system", text: `opencode error: ${msg}` }));
      break;
    }
    default: {
      const type = asString(event.type) ?? "";
      if (
        type === "message.updated" ||
        type.startsWith("message.part.") ||
        type.startsWith("session.") ||
        type.startsWith("file.watcher.") ||
        type.startsWith("server.")
      ) {
        items.push(makeItem(d, "lifecycle", { role: "system", meta: event }));
      } else {
        items.push(makeItem(d, "unknown", { role: "system", raw: event }));
      }
      break;
    }
  }
}

function codexToolName(item: Record<string, unknown>): string {
  if (item.type === "command_execution") return "bash";
  if (item.type === "mcp_tool_call") return `${item.server ?? "mcp"}.${item.tool ?? "unknown"}`;
  return String(item.type ?? "tool");
}

function codexCallInput(item: Record<string, unknown>): unknown {
  if (item.type === "command_execution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : (item.command ?? "");
    return { command };
  }
  if (item.type === "mcp_tool_call") return item.arguments;
  return item;
}

function roleFromAnthropicEvent(
  ev: Record<string, unknown>,
  message?: Record<string, unknown>,
): LogRole {
  if (ev.type === "assistant" || message?.role === "assistant") return "assistant";
  if (ev.type === "system" || ev.type === "rate_limit_event") return "system";
  return "user";
}

function knownLifecycleType(type: string | undefined): boolean {
  return (
    type === "system" || type === "rate_limit_event" || type === "user" || type === "assistant"
  );
}

function isParseError(value: unknown): value is { _parseError: true; raw: string } {
  return isRecord(value) && value._parseError === true;
}

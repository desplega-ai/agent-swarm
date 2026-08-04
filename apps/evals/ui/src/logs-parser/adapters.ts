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

    if (emitStderr(items, d, ev)) continue;

    if (ev.type === "tool_progress") {
      items.push(makeItem(d, "lifecycle", { role: "system", meta: ev }));
      continue;
    }

    if (isRecord(ev.provider_meta)) {
      items.push(makeItem(d, "lifecycle", { role: "system", meta: ev }));
      continue;
    }

    const message = isRecord(ev.message) ? ev.message : undefined;
    const rawContent =
      message?.content ??
      ev.content ??
      message?.parts ??
      ev.parts ??
      (isRecord(ev.part) ? [ev.part] : undefined);
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
                input: toolInputFromBlock(block),
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
  const toolCallById = new Map<string, NormalizedItem>();

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

    if (emitStderr(items, d, ev)) continue;

    const item = isRecord(ev.item) ? ev.item : undefined;
    switch (ev.type) {
      case "item.started": {
        if (!item) {
          items.push(makeItem(d, "unknown", { role: "system", raw: ev }));
          break;
        }
        switch (item.type) {
          case "command_execution":
          case "mcp_tool_call":
          case "collab_tool_call":
          case "web_search":
          case "todo_list": {
            upsertCodexToolCall(items, toolCallById, d, item);
            break;
          }
          case "file_change":
            // The completed event carries the actual diff; a pending file-change
            // row has no useful content and would only duplicate that result.
            break;
          case "agent_message":
          case "reasoning":
            // These starts contain no text. Their completed event is the single
            // readable transcript row, so intentionally omit the empty marker.
            break;
          default:
            items.push(makeItem(d, "unknown", { role: "system", raw: ev }));
        }
        break;
      }
      case "item.updated": {
        if (item?.type === "todo_list") {
          // Codex emits repeated snapshots for the same todo item. Update the
          // existing call in place so the transcript shows one current list.
          upsertCodexToolCall(items, toolCallById, d, item);
        } else {
          items.push(makeItem(d, "unknown", { role: "system", raw: ev }));
        }
        break;
      }
      case "item.completed": {
        if (!item) {
          items.push(makeItem(d, "unknown", { role: "system", raw: ev }));
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
          case "collab_tool_call": {
            items.push(
              makeItem(d, "tool_result", {
                role: "user",
                result: {
                  id: String(item.id ?? ""),
                  payload: codexCollabDetails(item),
                  isError: item.status === "failed",
                },
              }),
            );
            break;
          }
          case "error": {
            const message = asString(item.message) ?? "Codex error";
            items.push(
              makeItem(d, "result", {
                role: "system",
                meta: { ...item, type: "codex_error", output: message, isError: true },
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
          case "todo_list": {
            upsertCodexToolCall(items, toolCallById, d, item);
            items.push(
              makeItem(d, "tool_result", {
                role: "user",
                result: { id: String(item.id ?? ""), payload: item },
              }),
            );
            break;
          }
          case "web_search": {
            items.push(
              makeItem(d, "tool_result", {
                role: "user",
                result: { id: String(item.id ?? ""), payload: item },
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

    if (emitStderr(items, d, ev)) continue;

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
  const streamedPartIds = new Set<string>();
  const partUpdateRecIds = new Map<string, string[]>();
  const toolPartByCallId = new Map<
    string,
    { toolName: string; input: unknown; isError?: boolean; recIds: string[] }
  >();
  const items: NormalizedItem[] = [];

  for (const d of ordered) {
    const ev = d.event;
    if (!isRecord(ev)) continue;
    const props = isRecord(ev.properties) ? ev.properties : undefined;
    const part = props && isRecord(props.part) ? props.part : undefined;
    if (ev.type === "message.part.delta") {
      const partId = props?.partID ?? props?.partId;
      if (partId) streamedPartIds.add(String(partId));
    }
    if (ev.type === "message.part.updated" && part?.id) {
      const partId = String(part.id);
      partType.set(partId, String(part.type ?? "text"));
      partUpdateRecIds.set(partId, [...(partUpdateRecIds.get(partId) ?? []), d.rec.id]);
    }
    if (ev.type === "message.part.updated" && part?.type === "tool") {
      const callId = opencodeToolCallId(part);
      const toolName = typeof part.tool === "string" ? part.tool : "tool";
      const state = isRecord(part.state) ? part.state : undefined;
      if (callId) {
        const prev = toolPartByCallId.get(callId);
        const input = opencodeRichInput(state) ?? prev?.input;
        const status = typeof state?.status === "string" ? state.status : undefined;
        const isError =
          status === "error" || state?.error != null
            ? true
            : status === "completed"
              ? false
              : prev?.isError;
        toolPartByCallId.set(callId, {
          toolName,
          input,
          isError,
          recIds: [...(prev?.recIds ?? []), d.rec.id],
        });
      }
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
        orderedOutput.push({ kind: "event", d, event: ev });
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

    if (ev.type === "message.part.updated") {
      const props = isRecord(ev.properties) ? ev.properties : undefined;
      const part = props && isRecord(props.part) ? props.part : undefined;
      const partId = part?.id ? String(part.id) : undefined;
      if (partId && (streamedPartIds.has(partId) || part?.type === "tool")) continue;
    }

    // Part updates used for streamed text typing/tool enrichment are covered by
    // their aggregate item. Other part updates remain low-key lifecycle rows.
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
          coveredRecIds: [
            ...new Set([...stream.recIds, ...(partUpdateRecIds.get(output.partId) ?? [])]),
          ],
        }),
      );
      continue;
    }

    emitOpencodeEvent(items, output.d, output.event, toolPartByCallId);
  }

  return items;
}

function emitOpencodeEvent(
  items: NormalizedItem[],
  d: DecodedRecord,
  event: Record<string, unknown>,
  toolPartByCallId: Map<
    string,
    { toolName: string; input: unknown; isError?: boolean; recIds: string[] }
  >,
) {
  switch (event.type) {
    case "parse_error": {
      items.push(makeItem(d, "parse_error", { role: "system", raw: event.raw }));
      break;
    }
    case "stderr":
    case "raw_stderr": {
      emitStderr(items, d, event);
      break;
    }
    case "tool_start": {
      const callId = String(event.toolCallId ?? "");
      const rich = toolPartByCallId.get(callId);
      items.push(
        makeItem(d, "tool_call", {
          role: "assistant",
          tool: {
            id: callId,
            name: rich?.toolName ?? String(event.toolName ?? "tool"),
            input: hasPresentInput(rich?.input) ? rich?.input : event.args,
          },
          coveredRecIds: rich?.recIds,
        }),
      );
      break;
    }
    case "tool_end": {
      const callId = String(event.toolCallId ?? "");
      const rich = toolPartByCallId.get(callId);
      items.push(
        makeItem(d, "tool_result", {
          role: "user",
          result: {
            id: callId,
            payload: event.result,
            isError: rich?.isError ?? event.isError === true,
          },
          coveredRecIds: rich?.recIds,
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
        type === "message.part.updated" ||
        type === "plugin.added" ||
        type === "catalog.updated" ||
        type === "reference.updated" ||
        type === "integration.updated" ||
        type === "todo.updated" ||
        type.startsWith("session.") ||
        type.startsWith("file.watcher.")
      ) {
        items.push(makeItem(d, "lifecycle", { role: "system", meta: event }));
      } else if (type.startsWith("server.")) {
        break;
      } else {
        items.push(makeItem(d, "unknown", { role: "system", raw: event }));
      }
      break;
    }
  }
}

function toolInputFromBlock(block: Record<string, unknown>): unknown {
  return block.input ?? block.arguments ?? block.args ?? block.parameters;
}

function hasPresentInput(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input === "string") return input.trim().length > 0;
  if (Array.isArray(input)) return input.length > 0;
  if (isRecord(input)) return Object.keys(input).length > 0;
  return true;
}

function opencodeToolCallId(part: Record<string, unknown>): string | null {
  const callId = part.callID ?? part.callId ?? part.toolCallId ?? part.id;
  return typeof callId === "string" && callId.length > 0 ? callId : null;
}

function opencodeRichInput(state: Record<string, unknown> | undefined): unknown {
  if (!state) return undefined;
  const input = state.input ?? state.args ?? state.arguments ?? state.parameters;
  return hasPresentInput(input) ? input : undefined;
}

function codexToolName(item: Record<string, unknown>): string {
  if (item.type === "command_execution") return "bash";
  if (item.type === "mcp_tool_call") return `${item.server ?? "mcp"}.${item.tool ?? "unknown"}`;
  if (item.type === "collab_tool_call") return String(item.tool ?? "collaboration");
  return String(item.type ?? "tool");
}

function codexCallInput(item: Record<string, unknown>): unknown {
  if (item.type === "command_execution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : (item.command ?? "");
    return { command };
  }
  if (item.type === "mcp_tool_call") return item.arguments;
  if (item.type === "collab_tool_call") return codexCollabDetails(item);
  return item;
}

function codexCollabDetails(item: Record<string, unknown>): Record<string, unknown> {
  return {
    prompt: item.prompt ?? null,
    receiver_thread_ids: item.receiver_thread_ids ?? [],
    agents_states: item.agents_states ?? {},
    status: item.status,
  };
}

function upsertCodexToolCall(
  items: NormalizedItem[],
  toolCallById: Map<string, NormalizedItem>,
  d: DecodedRecord,
  item: Record<string, unknown>,
) {
  const id = String(item.id ?? "");
  const existing = id ? toolCallById.get(id) : undefined;
  if (existing?.tool) {
    existing.tool.name = codexToolName(item);
    existing.tool.input = codexCallInput(item);
    return;
  }

  const normalized = makeItem(d, "tool_call", {
    role: "assistant",
    tool: { id, name: codexToolName(item), input: codexCallInput(item) },
  });
  items.push(normalized);
  if (id) toolCallById.set(id, normalized);
}

function emitStderr(
  items: NormalizedItem[],
  d: DecodedRecord,
  event: Record<string, unknown>,
): boolean {
  if (event.type !== "stderr" && event.type !== "raw_stderr") return false;
  const content = asString(event.content) ?? asString(event.message) ?? "";
  items.push(makeItem(d, "text", { role: "system", text: `[stderr] ${content}`.trimEnd() }));
  return true;
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

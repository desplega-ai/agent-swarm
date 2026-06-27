import {
  normalizeAnthropic,
  normalizeClaudeManaged,
  normalizeCodex,
  normalizeOpencode,
} from "./adapters.ts";
import {
  decodeRecords,
  isRecord,
  orderDecodedRecords,
  pairItems,
  resultPayloadText,
} from "./helpers.ts";
import type {
  ContentBlock,
  NormalizedItem,
  ParsedMessage,
  ProviderMetaBlock,
  SessionLogRecord,
  TranscriptParseResult,
} from "./types.ts";

export { pairItems, resultPayloadText, unwrapResult } from "./helpers.ts";
export type {
  ContentBlock,
  NormalizedItem,
  PairingSummary,
  ParsedMessage,
  ProviderMetaBlock,
  SessionLogRecord,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  TranscriptParseResult,
} from "./types.ts";

type Adapter = (ordered: ReturnType<typeof orderDecodedRecords>) => NormalizedItem[];

const ADAPTERS: Record<string, Adapter> = {
  claude: normalizeAnthropic,
  "claude-managed": normalizeClaudeManaged,
  pi: normalizeAnthropic,
  codex: normalizeCodex,
  opencode: normalizeOpencode,
};

export function normalizeSessionLogs(logs: SessionLogRecord[]): TranscriptParseResult {
  const decoded = decodeRecords(logs);
  const ordered = orderDecodedRecords(decoded);
  const gate = {
    total: decoded.length,
    ok: decoded.filter((d) => !d.parseError).length,
    bad: decoded.filter((d) => d.parseError).length,
    passed: decoded.every((d) => !d.parseError),
  };
  const cli = chooseCli(ordered);
  const adapter = ADAPTERS[cli] ?? sniffAdapter(ordered) ?? normalizeAnthropic;
  const items = adapter(ordered);
  return { gate, ordered, items, pairing: pairItems(items) };
}

export function parseSessionLogs(logs: SessionLogRecord[]): ParsedMessage[] {
  return itemsToParsedMessages(normalizeSessionLogs(logs).items);
}

export function itemsToParsedMessages(items: NormalizedItem[]): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const item of items) {
    const block = itemToBlock(item);
    if (!block) continue;
    const role = item.role ?? (item.kind === "lifecycle" ? "system" : "assistant");
    const last = messages[messages.length - 1];
    if (last && last.id === item.recId && last.role === role) {
      last.content.push(block);
      continue;
    }
    messages.push({
      id: item.recId,
      role,
      content: [block],
      iteration: item.iteration,
      timestamp: item.createdAt,
    });
  }

  return messages;
}

function itemToBlock(item: NormalizedItem): ContentBlock | null {
  switch (item.kind) {
    case "text": {
      return { type: "text", text: item.text ?? "" };
    }
    case "reasoning": {
      return { type: "thinking", thinking: item.text ?? "" };
    }
    case "tool_call": {
      if (!item.tool) return null;
      return {
        type: "tool_use",
        id: item.tool.id,
        name: item.tool.name,
        input: item.tool.input,
      };
    }
    case "tool_result": {
      if (!item.result) return null;
      return {
        type: "tool_result",
        tool_use_id: item.result.id,
        content: resultPayloadText(item.result.payload),
        isError: item.result.isError,
      };
    }
    case "file_change": {
      return metaBlock(item, "file_change", { diff: item.diff });
    }
    case "result": {
      return metaBlock(item, "result", asDataRecord(item.meta));
    }
    case "lifecycle": {
      return lifecycleBlock(item);
    }
    case "parse_error": {
      return metaBlock(item, "parse_error", { raw: item.raw });
    }
    case "unknown": {
      return metaBlock(item, "unknown", { raw: item.raw });
    }
  }
}

function lifecycleBlock(item: NormalizedItem): ProviderMetaBlock {
  const providerBlock = providerMetaBlock(item);
  if (providerBlock) return providerBlock;

  const data = asDataRecord(item.meta);
  if (data.type === "rate_limit_event") {
    return metaBlock(item, "internal", { internalType: "rate_limit", ...data });
  }
  if (
    data.type === "system" &&
    typeof data.subtype === "string" &&
    data.subtype.startsWith("hook_")
  ) {
    return metaBlock(item, "internal", { internalType: "hook", ...data });
  }
  if (data.type === "system" && data.subtype === "thinking_tokens") {
    return metaBlock(item, "helper", { helperType: "thinking_tokens", ...data });
  }
  if (data.type === "context_usage") {
    return metaBlock(item, "helper", { helperType: "context_usage", ...data });
  }
  if (data.type === "turn.completed") {
    return metaBlock(item, "helper", { helperType: "turn_usage", ...data });
  }
  if (
    data.type === "thread.started" ||
    data.type === "turn.started" ||
    data.type === "turn.failed" ||
    data.type === "session_init" ||
    data.type === "item.started" ||
    (typeof data.type === "string" &&
      (data.type.startsWith("session.") ||
        data.type.startsWith("file.watcher.") ||
        data.type.startsWith("server.") ||
        data.type.startsWith("message.part.") ||
        data.type === "message.updated"))
  ) {
    return metaBlock(item, "internal", { internalType: "runtime", ...data });
  }
  return metaBlock(item, "lifecycle", data);
}

function providerMetaBlock(item: NormalizedItem): ProviderMetaBlock | null {
  if (!isRecord(item.meta) || !isRecord(item.meta.provider_meta)) return null;
  const { kind, provider, ...data } = item.meta.provider_meta;
  if (kind !== "status" && kind !== "structured_output") return null;
  return {
    type: "provider_meta",
    kind,
    provider: typeof provider === "string" ? provider : item.cli,
    data,
  };
}

function metaBlock(
  item: NormalizedItem,
  kind: ProviderMetaBlock["kind"],
  data: Record<string, unknown>,
): ProviderMetaBlock {
  return {
    type: "provider_meta",
    kind,
    provider: item.cli,
    data,
  };
}

function asDataRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  return { value };
}

function chooseCli(ordered: ReturnType<typeof orderDecodedRecords>): string {
  const counts = new Map<string, number>();
  for (const d of ordered) counts.set(d.rec.cli, (counts.get(d.rec.cli) ?? 0) + 1);
  let best = ordered[0]?.rec.cli ?? "claude";
  let bestCount = -1;
  for (const [cli, count] of counts) {
    if (count > bestCount) {
      best = cli;
      bestCount = count;
    }
  }
  return best;
}

function sniffAdapter(ordered: ReturnType<typeof orderDecodedRecords>): Adapter | undefined {
  for (const d of ordered) {
    const event = d.event;
    if (!isRecord(event)) continue;
    if (typeof event.type === "string" && event.type.startsWith("agent.")) {
      return normalizeClaudeManaged;
    }
    if (event.type === "message.part.delta") return normalizeOpencode;
    if (event.type === "item.started" || event.type === "item.completed") return normalizeCodex;
    if (isRecord(event.message) && Array.isArray(event.message.content)) return normalizeAnthropic;
  }
  return undefined;
}

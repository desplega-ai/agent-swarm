import type {
  DecodedRecord,
  NormalizedItem,
  NormalizedKind,
  PairingSummary,
  SessionLogRecord,
  UnwrappedResult,
} from "./types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseJson(value: string): unknown {
  return JSON.parse(value);
}

export function tryParseJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

export function decodeRecords(logs: SessionLogRecord[]): DecodedRecord[] {
  return logs.map((rec, fileIndex) => {
    const parsed = tryParseJson(rec.content);
    return {
      rec,
      fileIndex,
      event: parsed.ok ? parsed.value : { _parseError: true, raw: rec.content },
      parseError: parsed.ok ? undefined : "Invalid JSON content",
      t: Date.parse(rec.createdAt),
    };
  });
}

// Evals adaptation: old artifacts lack createdAt (t = NaN) and lineNumber resets per
// iteration, so missing timestamps must fall through to (iteration, lineNumber).
export function orderDecodedRecords(decoded: DecodedRecord[]): DecodedRecord[] {
  return [...decoded].sort((a, b) => {
    const t = safeTime(a.t) - safeTime(b.t);
    if (t !== 0) return t;
    const iter = a.rec.iteration - b.rec.iteration;
    if (iter !== 0) return iter;
    const line = a.rec.lineNumber - b.rec.lineNumber;
    if (line !== 0) return line;
    return a.fileIndex - b.fileIndex;
  });
}

function safeTime(value: number): number {
  return Number.isFinite(value) ? value : 0; // missing createdAt → fall through to (iteration, lineNumber)
}

export function makeItem(
  d: DecodedRecord,
  kind: NormalizedKind,
  props: Omit<
    Partial<NormalizedItem>,
    "recId" | "fileIndex" | "iteration" | "lineNumber" | "createdAt" | "t" | "cli" | "kind"
  > = {},
): NormalizedItem {
  return {
    recId: d.rec.id,
    fileIndex: d.fileIndex,
    iteration: d.rec.iteration,
    lineNumber: d.rec.lineNumber,
    createdAt: d.rec.createdAt,
    t: d.t,
    cli: d.rec.cli,
    kind,
    ...props,
  };
}

export function resultBlockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (isRecord(c)) {
          if (c.type === "text") return String(c.text ?? "");
          if (c.type === "image") return "[image]";
        }
        return stringifyForDisplay(c);
      })
      .join("\n");
  }
  if (content == null) return "";
  return stringifyForDisplay(content);
}

export function stringifyForDisplay(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function unwrapResult(payload: unknown): UnwrappedResult {
  if (payload !== null && typeof payload === "object") return { json: payload };
  const s = typeof payload === "string" ? payload : stringifyForDisplay(payload);
  const t = s.trim();
  if (!t) return { prose: "" };

  if (looksLikeJson(t)) {
    const parsed = tryParseJson(t);
    if (parsed.ok) return { json: parsed.value };
  }

  const embeddedIndex = firstEmbeddedJsonIndex(s);
  if (embeddedIndex > 0) {
    const candidate = s.slice(embeddedIndex).trim();
    if (looksLikeJson(candidate)) {
      const parsed = tryParseJson(candidate);
      if (parsed.ok) return { prose: s.slice(0, embeddedIndex).trim(), json: parsed.value };
    }
  }

  return { prose: s };
}

function looksLikeJson(value: string): boolean {
  return (
    (value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))
  );
}

function firstEmbeddedJsonIndex(value: string): number {
  const obj = value.indexOf("\n{");
  const arr = value.indexOf("\n[");
  if (obj === -1) return arr;
  if (arr === -1) return obj;
  return Math.min(obj, arr);
}

export function resultPayloadText(payload: unknown): string {
  const unwrapped = unwrapResult(payload);
  const extracted = unwrapped.json !== undefined ? contentTextFromJson(unwrapped.json) : undefined;
  if (extracted !== undefined) {
    return unwrapped.prose ? `${unwrapped.prose}\n\n${extracted}` : extracted;
  }
  if (unwrapped.prose && unwrapped.json !== undefined) {
    return `${unwrapped.prose}\n\n${stringifyForDisplay(unwrapped.json)}`;
  }
  if (unwrapped.json !== undefined) return stringifyForDisplay(unwrapped.json);
  return unwrapped.prose ?? "";
}

function contentTextFromJson(value: unknown): string | undefined {
  const obj = isRecord(value) ? value : undefined;
  if (!obj || !Array.isArray(obj.content)) return undefined;
  const parts = obj.content
    .map((part) => {
      if (typeof part === "string") return resultPayloadText(part);
      if (!isRecord(part)) return stringifyForDisplay(part);
      if (part.type === "text") return resultPayloadText(String(part.text ?? ""));
      if (part.type === "image") return "[image]";
      return stringifyForDisplay(part);
    })
    .filter((part) => part.length > 0);
  return parts.join("\n");
}

export function pairItems(items: NormalizedItem[]): PairingSummary {
  const callById = new Map<string, NormalizedItem>();
  const resultById = new Map<string, NormalizedItem>();

  for (const item of items) {
    if (item.kind === "tool_call" && item.tool?.id) callById.set(item.tool.id, item);
    if (item.kind === "tool_result" && item.result?.id) resultById.set(item.result.id, item);
  }

  let paired = 0;
  const orphanCalls: string[] = [];
  const orphanResults: string[] = [];

  for (const id of callById.keys()) {
    if (resultById.has(id)) paired++;
    else orphanCalls.push(id);
  }
  for (const id of resultById.keys()) {
    if (!callById.has(id)) orphanResults.push(id);
  }

  return { paired, orphanCalls, orphanResults, resultById };
}

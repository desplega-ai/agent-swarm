import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Brain, Check, ChevronRight, Copy, Scissors, Search } from "lucide-react";
import {
  type CSSProperties,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

import type { ContextSnapshot, SessionLog } from "@/api/types";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatTokens } from "@/lib/format-tokens";
import { cn, normalizeNewlines } from "@/lib/utils";

// --- Parsed message types ---

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  isError?: boolean;
}

interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

interface ProviderMetaBlock {
  type: "provider_meta";
  kind: "status" | "structured_output";
  provider: string;
  data: Record<string, unknown>;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | ProviderMetaBlock;

interface ParsedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  model?: string;
  iteration: number;
  timestamp: string;
}

// --- Parsing ---

/** Flatten an Anthropic tool_result `content` (string | array of blocks) to text. */
function resultBlockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          if (c.type === "text") return String(c.text ?? "");
          if (c.type === "image") return "[image]";
        }
        return JSON.stringify(c);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

/**
 * Parse a codex SDK event row into a ParsedMessage. Codex uses a different
 * event shape than Claude — each row is one of:
 *   - { type: "thread.started", thread_id }                 → skip (no content)
 *   - { type: "turn.started" } / "turn.completed" / "turn.failed" → skip
 *   - { type: "item.started"|"item.completed"|"item.updated", item: {...} }
 *
 * Items further branch on `item.type`: "agent_message" → assistant text,
 * "command_execution" → tool_use(bash), "mcp_tool_call" → tool_use(<tool>),
 * "reasoning" → thinking block, "file_change"/"web_search"/"todo_list" →
 * tool_use with the SDK item type as the name.
 *
 * We only emit on the *completed* item (skip started/updated to avoid
 * duplicates) so the dashboard sees one ParsedMessage per logical event.
 */
function parseCodexLog(log: SessionLog): ParsedMessage | null {
  let evt: {
    type?: string;
    item?: {
      id?: string;
      type?: string;
      text?: string;
      command?: string | string[];
      aggregated_output?: string;
      exit_code?: number | null;
      server?: string;
      tool?: string;
      arguments?: unknown;
      result?: unknown;
      summary?: string;
      items?: unknown;
    };
  } | null = null;
  try {
    evt = JSON.parse(log.content);
  } catch {
    return null;
  }

  // Only render `item.completed` events to avoid duplicates from item.started/updated.
  if (evt?.type !== "item.completed" || !evt.item) return null;

  const item = evt.item;
  const blocks: ContentBlock[] = [];
  const role: "assistant" | "user" | "system" = "assistant";

  switch (item.type) {
    case "agent_message": {
      if (item.text) blocks.push({ type: "text", text: item.text });
      break;
    }
    case "reasoning": {
      const text = item.text ?? item.summary ?? "";
      if (text) blocks.push({ type: "thinking", thinking: text });
      break;
    }
    case "command_execution": {
      const cmdStr = Array.isArray(item.command) ? item.command.join(" ") : (item.command ?? "");
      blocks.push({
        type: "tool_use",
        id: item.id ?? "",
        name: "bash",
        input: { command: cmdStr },
      });
      if (item.aggregated_output) {
        blocks.push({
          type: "tool_result",
          tool_use_id: item.id ?? "",
          content: item.aggregated_output,
          isError: typeof item.exit_code === "number" && item.exit_code !== 0,
        });
      }
      break;
    }
    case "mcp_tool_call": {
      blocks.push({
        type: "tool_use",
        id: item.id ?? "",
        name: `${item.server ?? "mcp"}.${item.tool ?? "unknown"}`,
        input: item.arguments,
      });
      if (item.result !== undefined) {
        const text = typeof item.result === "string" ? item.result : JSON.stringify(item.result);
        blocks.push({
          type: "tool_result",
          tool_use_id: item.id ?? "",
          content: text,
        });
      }
      break;
    }
    case "file_change":
    case "web_search":
    case "todo_list": {
      blocks.push({
        type: "tool_use",
        id: item.id ?? "",
        name: item.type,
        input: item,
      });
      break;
    }
    default:
      return null;
  }

  if (blocks.length === 0) return null;

  return {
    id: log.id,
    role,
    content: blocks,
    iteration: log.iteration,
    timestamp: log.createdAt,
  };
}

/**
 * Parse a single opencode event row into a ParsedMessage.
 *
 * opencode's protocol streams the same logical message many times: a text part
 * grows delta-by-delta via `message.part.updated`, a tool call cycles through
 * pending → running → completed. To avoid 50 "partial" frames per message we
 * dedupe in the caller via `latestByPart` and only render when the log row
 * we're handed IS the latest entry for that part.id.
 *
 * Events we render:
 *   - message.part.updated (text)        → assistant/user text
 *   - message.part.updated (reasoning)   → thinking
 *   - message.part.updated (tool, completed) → tool_use [+ tool_result if output]
 *   - session.error                      → system error message
 * Everything else (deltas, heartbeats, status, file watcher) returns null.
 */
function parseOpencodeLog(
  log: SessionLog,
  latestByPart: Map<string, SessionLog>,
): ParsedMessage | null {
  let evt: {
    type?: string;
    properties?: {
      sessionID?: string;
      part?: {
        id?: string;
        type?: string;
        text?: string;
        messageID?: string;
        tool?: string;
        callID?: string;
        state?: {
          status?: string;
          input?: unknown;
          output?: string;
        };
      };
      info?: {
        role?: string;
        time?: { created?: number };
      };
      error?: { name?: string; data?: { message?: string } };
    };
  } | null = null;
  try {
    evt = JSON.parse(log.content);
  } catch {
    return null;
  }

  if (evt?.type === "session.error") {
    const msg =
      evt.properties?.error?.data?.message ?? evt.properties?.error?.name ?? "session error";
    return {
      id: log.id,
      role: "system",
      content: [{ type: "text", text: `opencode error: ${msg}` }],
      iteration: log.iteration,
      timestamp: log.createdAt,
    };
  }

  if (evt?.type !== "message.part.updated") return null;
  const part = evt.properties?.part;
  if (!part?.id) return null;

  // Dedup: only render when this row is the latest update for the part.
  if (latestByPart.get(part.id)?.id !== log.id) return null;

  const blocks: ContentBlock[] = [];

  switch (part.type) {
    case "text": {
      if (part.text) blocks.push({ type: "text", text: part.text });
      break;
    }
    case "reasoning": {
      if (part.text) blocks.push({ type: "thinking", thinking: part.text });
      break;
    }
    case "tool": {
      if (part.state?.status !== "completed") return null;
      blocks.push({
        type: "tool_use",
        id: part.callID ?? part.id,
        name: part.tool ?? "tool",
        input: part.state.input,
      });
      if (part.state.output !== undefined) {
        const text =
          typeof part.state.output === "string"
            ? part.state.output
            : JSON.stringify(part.state.output);
        blocks.push({
          type: "tool_result",
          tool_use_id: part.callID ?? part.id,
          content: text,
        });
      }
      break;
    }
    default:
      return null;
  }

  if (blocks.length === 0) return null;

  // Best-effort role inference: text and tool parts are assistant-emitted unless
  // we explicitly know the message was the user prompt.
  return {
    id: log.id,
    role: "assistant",
    content: blocks,
    iteration: log.iteration,
    timestamp: log.createdAt,
  };
}

function parseSessionLogs(logs: SessionLog[]): ParsedMessage[] {
  // Sort chronologically: by timestamp first, then lineNumber as tiebreaker
  // lineNumber represents parallel messages within the same turn (e.g. parallel tool calls)
  const sorted = [...logs].sort((a, b) => {
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();
    if (timeA !== timeB) return timeA - timeB;
    return a.lineNumber - b.lineNumber;
  });

  // opencode emits one event per part-update during streaming; collapse to the
  // last update per partId before rendering so we don't show intermediate frames.
  const opencodeLatestByPart = new Map<string, SessionLog>();
  for (const log of sorted) {
    if (log.cli !== "opencode") continue;
    let evt: { type?: string; properties?: { part?: { id?: string } } } | null = null;
    try {
      evt = JSON.parse(log.content);
    } catch {
      continue;
    }
    if (evt?.type !== "message.part.updated") continue;
    const partId = evt.properties?.part?.id;
    if (partId) opencodeLatestByPart.set(partId, log);
  }

  const messages: ParsedMessage[] = [];

  for (const log of sorted) {
    if (log.cli === "codex") {
      const codexMsg = parseCodexLog(log);
      if (codexMsg) messages.push(codexMsg);
      continue;
    }

    if (log.cli === "opencode") {
      const ocMsg = parseOpencodeLog(log, opencodeLatestByPart);
      if (ocMsg) messages.push(ocMsg);
      continue;
    }

    let parsed: {
      type?: string;
      message?: { role?: string; content?: unknown; model?: string; id?: string };
      provider_meta?: { provider: string; kind: string; [key: string]: unknown };
    } | null = null;
    try {
      parsed = JSON.parse(log.content);
    } catch {
      // Non-JSON line — treat as system/raw text
      messages.push({
        id: log.id,
        role: "system",
        content: [{ type: "text", text: log.content }],
        iteration: log.iteration,
        timestamp: log.createdAt,
      });
      continue;
    }

    // Provider meta events (status transitions, structured output)
    if (parsed?.provider_meta) {
      const { kind, provider, ...data } = parsed.provider_meta;
      messages.push({
        id: log.id,
        role: "system",
        content: [
          {
            type: "provider_meta",
            kind: kind as "status" | "structured_output",
            provider,
            data,
          },
        ],
        iteration: log.iteration,
        timestamp: log.createdAt,
      });
      continue;
    }

    if (!parsed?.message?.content) continue;

    const rawContent = parsed.message.content;
    const blocks: ContentBlock[] = [];

    if (typeof rawContent === "string") {
      blocks.push({ type: "text", text: rawContent });
    } else if (Array.isArray(rawContent)) {
      for (const block of rawContent) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking" && block.thinking) {
          blocks.push({ type: "thinking", thinking: block.thinking });
        } else if (block.type === "tool_use") {
          blocks.push({
            type: "tool_use",
            id: block.id ?? "",
            name: block.name ?? "unknown",
            input: block.input,
          });
        } else if (block.type === "tool_result") {
          blocks.push({
            type: "tool_result",
            tool_use_id: block.tool_use_id ?? "",
            content: resultBlockText(block.content),
            isError: block.is_error === true,
          });
        }
      }
    }

    if (blocks.length === 0) continue;

    const role =
      parsed.type === "assistant" || parsed.message.role === "assistant" ? "assistant" : "user";

    messages.push({
      id: log.id,
      role,
      content: blocks,
      model: parsed.message.model,
      iteration: log.iteration,
      timestamp: log.createdAt,
    });
  }

  return messages;
}

// --- Stream model ---

type ToolKind = "mcp" | "bash" | "file" | "web" | "task" | "other";

interface ToolEntry {
  id: string;
  kind: ToolKind;
  name: string;
  server: string;
  title: string;
  detail: string;
  input: string;
  preview: string;
  body: string;
  ok: boolean;
  hasResult: boolean;
  durMs: number;
}

type StreamRow =
  | { type: "compaction"; id: string; snapshot: ContextSnapshot }
  | {
      type: "agent";
      id: string;
      role: "assistant" | "user" | "system";
      time: string;
      iso: string;
      md: string;
      isNew: boolean;
    }
  | { type: "thinking"; id: string; time: string; iso: string; text: string; isNew: boolean }
  | {
      type: "meta";
      id: string;
      time: string;
      iso: string;
      block: ProviderMetaBlock;
      isNew: boolean;
    }
  | {
      type: "toolgroup";
      id: string;
      time: string;
      iso: string;
      tools: ToolEntry[];
      names: string[];
      durMs: number;
      defaultOpen: boolean;
      isNew: boolean;
    };

const FILE_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LS",
]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n).trimEnd()} …` : s;
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function fmtFull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** Human-friendly elapsed duration. 0/invalid → "" (renders nothing). */
function formatDur(ms: number): string {
  if (!ms || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) {
    const s = ms / 1000;
    return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  }
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s ? ` ${s}s` : ""}`;
}

function shortDetail(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (!keys.length) return "";
  const k = keys[0];
  let v = obj[k];
  if (typeof v === "object") v = JSON.stringify(v);
  return truncate(`${k}: ${String(v).replace(/\s+/g, " ")}`, 60);
}

function classifyTool(
  name: string,
  input: unknown,
): {
  kind: ToolKind;
  name: string;
  server: string;
  title: string;
  detail: string;
} {
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (name.startsWith("mcp__")) {
    const p = name.split("__");
    const server = p[1] ?? "";
    const tool = p.slice(2).join("__");
    return {
      kind: "mcp",
      name: tool,
      server,
      title: `${server}.${tool}`,
      detail: shortDetail(inp),
    };
  }
  if (name === "Bash") {
    return {
      kind: "bash",
      name: "bash",
      server: "",
      title: "bash",
      detail: String(inp.command ?? "").split("\n")[0],
    };
  }
  if (FILE_TOOLS.has(name)) {
    return {
      kind: "file",
      name,
      server: "",
      title: name,
      detail: String(inp.file_path ?? inp.path ?? inp.pattern ?? ""),
    };
  }
  if (WEB_TOOLS.has(name)) {
    return {
      kind: "web",
      name,
      server: "",
      title: name,
      detail: String(inp.url ?? inp.query ?? ""),
    };
  }
  if (name === "Task") {
    return {
      kind: "task",
      name: "Task",
      server: "",
      title: "Task",
      detail: String(inp.description ?? ""),
    };
  }
  return {
    kind: "other",
    name: name || "tool",
    server: "",
    title: name || "tool",
    detail: shortDetail(inp),
  };
}

function prettyInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") {
    const s = input.trim();
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try {
        return JSON.stringify(JSON.parse(s), null, 2);
      } catch {
        // not JSON, fall through
      }
    }
    return input;
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function previewOf(body: string): string {
  const s = (body || "").trim();
  if (!s) return "ok";
  if (s.startsWith("{") && s.endsWith("}")) {
    try {
      return `{ ${Object.keys(JSON.parse(s)).length} keys }`;
    } catch {
      // fall through
    }
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      return `[ ${(JSON.parse(s) as unknown[]).length} items ]`;
    } catch {
      // fall through
    }
  }
  const lines = s.split("\n").filter(Boolean);
  if (lines.length > 1) return `${lines.length} lines`;
  return truncate(s.replace(/\s+/g, " "), 52) || "ok";
}

/** Normalize Unicode bullets at line-start to markdown lists, then paragraph-fix. */
function tidyMarkdown(text: string): string {
  return normalizeNewlines(text.replace(/^([ \t]*)[•·▪]\s+/gm, "$1- "));
}

function buildStream(
  messages: ParsedMessage[],
  snapshots: ContextSnapshot[],
  newIds: Set<string>,
): StreamRow[] {
  // Index every tool_result by the id of the call it answers (+ its timestamp).
  const resultById = new Map<string, { content: string; isError: boolean; at: number }>();
  for (const m of messages) {
    const at = new Date(m.timestamp).getTime();
    for (const b of m.content) {
      if (b.type === "tool_result" && b.tool_use_id) {
        resultById.set(b.tool_use_id, { content: b.content, isError: b.isError === true, at });
      }
    }
  }

  type TL =
    | { kind: "msg"; m: ParsedMessage; t: number }
    | { kind: "snap"; s: ContextSnapshot; t: number };
  const tl: TL[] = messages.map((m) => ({ kind: "msg", m, t: new Date(m.timestamp).getTime() }));
  for (const s of snapshots) {
    if (s.eventType === "compaction")
      tl.push({ kind: "snap", s, t: new Date(s.createdAt).getTime() });
  }
  tl.sort((a, b) => a.t - b.t);

  const rows: StreamRow[] = [];
  type Group = Extract<StreamRow, { type: "toolgroup" }> & { _start: number; _end: number };
  let curGroup: Group | null = null;
  const closeGroup = () => {
    if (curGroup) {
      curGroup.durMs = Math.max(0, curGroup._end - curGroup._start);
      curGroup = null;
    }
  };

  for (const item of tl) {
    if (item.kind === "snap") {
      closeGroup();
      rows.push({ type: "compaction", id: `compact-${item.s.id}`, snapshot: item.s });
      continue;
    }

    const m = item.m;
    const time = fmtClock(m.timestamp);
    m.content.forEach((b, i) => {
      const blockId = `${m.id}-${i}`;
      if (b.type === "tool_result") return; // folded into its tool_use group

      if (b.type === "tool_use") {
        const c = classifyTool(b.name, b.input);
        const res = b.id ? resultById.get(b.id) : undefined;
        const body = res ? res.content : "";
        const durMs = res ? Math.max(0, res.at - item.t) : 0;
        const entry: ToolEntry = {
          id: `${blockId}:${b.id || "noid"}`,
          kind: c.kind,
          name: c.name,
          server: c.server,
          title: c.title,
          detail: c.detail,
          input: prettyInput(b.input),
          preview: res ? previewOf(body) : "running…",
          body,
          ok: res ? !res.isError : true,
          hasResult: !!res,
          durMs,
        };
        if (!curGroup) {
          curGroup = {
            type: "toolgroup",
            id: `g-${blockId}`,
            time, // start time (first tool); not overwritten
            iso: m.timestamp,
            tools: [],
            names: [],
            durMs: 0,
            defaultOpen: false,
            isNew: newIds.has(m.id),
            _start: item.t,
            _end: item.t,
          };
          rows.push(curGroup);
        }
        curGroup.tools.push(entry);
        curGroup._end = Math.max(curGroup._end, res ? res.at : item.t);
        const nm = c.kind === "mcp" ? c.name : c.title;
        if (!curGroup.names.includes(nm)) curGroup.names.push(nm);
        return;
      }

      // Any non-tool block terminates the current tool group.
      closeGroup();
      const isNew = newIds.has(m.id);
      if (b.type === "text") {
        if (!b.text.trim()) return;
        rows.push({
          type: "agent",
          id: blockId,
          role: m.role,
          time,
          iso: m.timestamp,
          md: b.text,
          isNew,
        });
      } else if (b.type === "thinking") {
        if (!b.thinking.trim()) return;
        rows.push({
          type: "thinking",
          id: blockId,
          time,
          iso: m.timestamp,
          text: b.thinking,
          isNew,
        });
      } else if (b.type === "provider_meta") {
        rows.push({ type: "meta", id: blockId, time, iso: m.timestamp, block: b, isNew });
      }
    });
  }
  closeGroup();

  // The trailing tool group (if the stream ends on one) stays open by default —
  // this is committed here, not derived from a moving "last index", so a group
  // doesn't spontaneously collapse mid-read when the next event streams in.
  const last = rows[rows.length - 1];
  if (last && last.type === "toolgroup") last.defaultOpen = true;

  return rows;
}

function groupHeader(names: string[]): string {
  const shown = names.slice(0, 5).join(", ");
  return names.length > 5 ? `${shown} +${names.length - 5}` : shown;
}

function rowSearchText(row: StreamRow): string {
  switch (row.type) {
    case "agent":
      return row.md;
    case "thinking":
      return row.text;
    case "meta":
      return JSON.stringify(row.block.data);
    case "toolgroup":
      return row.tools.map((t) => `${t.title} ${t.detail} ${t.preview} ${t.body}`).join(" ");
    case "compaction":
      return "compaction";
  }
}

function outlineLabel(row: StreamRow): string {
  switch (row.type) {
    case "toolgroup": {
      const count = `${row.tools.length} ${row.tools.length === 1 ? "step" : "steps"}`;
      const names = groupHeader(row.names);
      return names ? `${count} · ${names}` : count;
    }
    case "agent":
      return truncate(row.md.replace(/\s+/g, " ").trim(), 72) || "…";
    case "thinking":
      return `Thinking · ${truncate(row.text.replace(/\s+/g, " ").trim(), 60)}`;
    case "meta":
      return `${row.block.provider} ${row.block.kind === "status" ? "status" : "result"}`;
    case "compaction":
      return "Compaction";
  }
}

type TickTone = "agent" | "tool" | "user" | "muted";

function rowTone(row: StreamRow): TickTone {
  if (row.type === "toolgroup") return "tool";
  if (row.type === "agent") return row.role === "user" ? "user" : "agent";
  if (row.type === "thinking") return "agent";
  return "muted";
}

const TONE_DOT: Record<TickTone, string> = {
  agent: "bg-status-active",
  tool: "bg-status-info",
  user: "bg-status-neutral",
  muted: "bg-muted-foreground/40",
};

// --- Small UI pieces ---

function CopyIconButton({
  text,
  className,
  label = "Copy",
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onCopy = useCallback(
    (e: ReactMouseEvent) => {
      e.stopPropagation();
      void navigator.clipboard?.writeText(text);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1300);
    },
    [text],
  );

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={label}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

const PROVIDER_STATUS_STYLES: Record<string, { label: string; bg: string; text: string }> = {
  running: { label: "Running", bg: "bg-status-paused/15", text: "text-status-paused-strong" },
  working: { label: "Working", bg: "bg-status-paused/15", text: "text-status-paused-strong" },
  waiting_for_user: {
    label: "Awaiting Input",
    bg: "bg-status-active/15",
    text: "text-status-active-strong",
  },
  waiting_for_approval: {
    label: "Needs Approval",
    bg: "bg-status-active/15",
    text: "text-status-active-strong",
  },
  completed: { label: "Completed", bg: "bg-status-success/15", text: "text-status-success-strong" },
  done: { label: "Done", bg: "bg-status-success/15", text: "text-status-success-strong" },
  needs_input: {
    label: "Needs Input",
    bg: "bg-status-active/15",
    text: "text-status-active-strong",
  },
  error: { label: "Error", bg: "bg-status-error/15", text: "text-status-error-strong" },
};

function ProviderStatusPill({ value }: { value: string }) {
  const style = PROVIDER_STATUS_STYLES[value] ?? {
    label: value,
    bg: "bg-muted",
    text: "text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
        style.bg,
        style.text,
      )}
    >
      {style.label}
    </span>
  );
}

function ProviderMetaBubble({ block }: { block: ProviderMetaBlock }) {
  const label = block.provider.charAt(0).toUpperCase() + block.provider.slice(1);

  if (block.kind === "status") {
    const status = String(block.data.status ?? "");
    const detail = block.data.statusDetail ? String(block.data.statusDetail) : undefined;
    const acus = block.data.acusConsumed as number | undefined;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <ProviderStatusPill value={detail ?? status} />
        {acus !== undefined && acus > 0 && (
          <span className="text-[10px] text-muted-foreground">{acus.toFixed(2)} ACUs</span>
        )}
      </div>
    );
  }

  const taskStatus = block.data.taskStatus ? String(block.data.taskStatus) : undefined;
  const output = block.data.output ? String(block.data.output) : undefined;
  const summary = block.data.summary ? String(block.data.summary) : undefined;
  return (
    <div className="space-y-1.5 rounded-md border border-border/60 bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {label} Result
        </span>
        {taskStatus && <ProviderStatusPill value={taskStatus} />}
      </div>
      {summary && <p className="text-xs text-muted-foreground">{summary}</p>}
      {output && (
        <div className="prose-chat prose-session-log text-sm text-foreground">
          <Streamdown>{tidyMarkdown(output)}</Streamdown>
        </div>
      )}
    </div>
  );
}

// Shared 2-column [time | content] row scaffold (prose / thinking / meta / tool group).
function RowShell({
  time,
  iso,
  flash,
  isNew,
  children,
}: {
  time: string;
  iso: string;
  flash?: boolean;
  isNew?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group grid grid-cols-[46px_minmax(0,1fr)] items-start gap-x-3 border-b border-border/40 py-[7px] transition-colors hover:bg-muted/50 sm:grid-cols-[54px_minmax(0,1fr)] sm:gap-x-[18px]",
        flash && "sl-flash",
        isNew && "sl-enter",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help select-none pt-[3px] text-left font-mono text-[11px] tabular-nums text-muted-foreground">
            {time}
          </span>
        </TooltipTrigger>
        <TooltipContent>{fmtFull(iso)}</TooltipContent>
      </Tooltip>
      <div className="relative min-w-0">{children}</div>
    </div>
  );
}

function ResultSection({
  body,
  open,
  onToggle,
}: {
  body: string;
  open: boolean;
  onToggle: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);

  // Re-measure when the body changes (streaming results grow on refetch) — `body`
  // is the intentional trigger even though the measurement reads the DOM, not it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on body change
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setOverflow(el.scrollHeight - 2 > el.clientHeight);
  }, [body]);

  return (
    <>
      <div
        ref={wrapRef}
        className={cn("relative overflow-hidden", open ? "max-h-none" : "max-h-[11.5em]")}
      >
        <pre className="m-0 whitespace-pre-wrap break-words px-2.5 pb-2 pt-1 font-mono text-[11.5px] leading-[1.6] text-foreground/85">
          {body || "(no output)"}
        </pre>
        {overflow && !open && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent" />
        )}
      </div>
      {overflow && (
        <button
          type="button"
          onClick={onToggle}
          className="mx-2.5 mb-2 cursor-pointer text-[11px] font-semibold text-status-info-strong"
        >
          {open ? "Show less" : "Show full output"}
        </button>
      )}
    </>
  );
}

function ToolRow({
  tool,
  open,
  onToggle,
  outputOpen,
  onToggleOutput,
}: {
  tool: ToolEntry;
  open: boolean;
  onToggle: () => void;
  outputOpen: boolean;
  onToggleOutput: () => void;
}) {
  const dur = formatDur(tool.durMs);
  const hasInput = tool.input && tool.input !== "{}";

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-90",
          )}
        />
        <span className="shrink-0 whitespace-nowrap font-mono text-xs text-foreground">
          {tool.kind === "mcp" && tool.server ? (
            <>
              <span className="text-muted-foreground">{tool.server}.</span>
              {tool.name}
            </>
          ) : (
            tool.title
          )}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {tool.detail}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
          {tool.hasResult && (
            <span className={tool.ok ? "text-status-success-strong" : "text-status-error-strong"}>
              {tool.ok ? "✓ " : "✕ "}
            </span>
          )}
          {tool.preview}
        </span>
        {dur && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{dur}</span>}
      </button>

      {open && (
        <div className="border-t border-border">
          {hasInput && (
            <>
              <div className="flex items-center gap-1.5 px-2.5 pt-1.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
                <span>Input</span>
                <CopyIconButton text={tool.input} className="ml-auto" label="Copy input" />
              </div>
              <pre className="m-0 whitespace-pre-wrap break-words px-2.5 pb-2 pt-1 font-mono text-[11.5px] leading-[1.6] text-foreground/85">
                {tool.input}
              </pre>
            </>
          )}
          <div className="flex items-center gap-1.5 px-2.5 pt-1.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
            <span>Result</span>
            <CopyIconButton text={tool.body} className="ml-auto" label="Copy result" />
          </div>
          <ResultSection body={tool.body} open={outputOpen} onToggle={onToggleOutput} />
        </div>
      )}
    </div>
  );
}

function CompactionDivider({ snapshot }: { snapshot: ContextSnapshot }) {
  const isAuto = snapshot.compactTrigger !== "manual";
  const preTokens = snapshot.preCompactTokens;
  const postTokens = snapshot.contextUsedTokens;
  const percent = snapshot.contextPercent;

  return (
    <div className="flex items-center gap-2 border-y border-status-active/20 bg-status-active/5 px-1 py-2">
      <Scissors className="size-3 shrink-0 text-status-active-strong" />
      <span className="whitespace-nowrap font-mono text-[10px] font-semibold uppercase tracking-wider text-status-active-strong">
        {isAuto ? "Auto" : "Manual"} compaction
      </span>
      {preTokens != null && postTokens != null && (
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatTokens(preTokens)} → {formatTokens(postTokens)}
        </span>
      )}
      {percent != null && (
        <span className="font-mono text-[10px] text-muted-foreground">({percent.toFixed(0)}%)</span>
      )}
      <div className="h-px flex-1 bg-status-active/20" />
    </div>
  );
}

// Right-edge minimap: compact top-packed ticks (one per visible row) that widen
// on hover/focus into a clickable outline. Memoized + the outline list mounts
// only while open, so the full event list never re-renders on collapse toggles
// or defeats the main list's virtualization.
const MinimapRail = memo(function MinimapRail({
  rows,
  onJump,
}: {
  rows: StreamRow[];
  onJump: (index: number, row: StreamRow) => void;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [railH, setRailH] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = railRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setRailH(el.clientHeight));
    ro.observe(el);
    setRailH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const gap = rows.length > 1 ? Math.max(0, Math.min(8, (railH - 12) / (rows.length - 1))) : 0;

  return (
    <div
      ref={railRef}
      className="relative hidden w-3 shrink-0 sm:block"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <div className="absolute inset-0" aria-hidden>
        {rows.map((row, i) => (
          <div
            key={row.id}
            className={cn(
              "absolute inset-x-[3px] h-[3px] rounded-sm opacity-60",
              TONE_DOT[rowTone(row)],
            )}
            style={{ top: 6 + i * gap }}
          />
        ))}
      </div>
      {open && (
        <div className="absolute right-0 top-0 z-20 max-h-full w-64 overflow-y-auto rounded-l-md border-l border-border bg-card shadow-xl">
          <div className="sticky top-0 border-b border-border bg-card px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
            {rows.length} events · click to jump
          </div>
          {rows.map((row, i) => (
            <button
              key={row.id}
              type="button"
              onClick={() => onJump(i, row)}
              className="flex w-full cursor-pointer items-center gap-2 border-b border-border/40 px-3 py-1.5 text-left hover:bg-muted/50"
            >
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {"time" in row ? row.time : ""}
              </span>
              <span className={cn("size-[7px] shrink-0 rounded-full", TONE_DOT[rowTone(row)])} />
              <span className="min-w-0 flex-1 truncate text-xs">{outlineLabel(row)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

// --- Main component ---

const VIRTUALIZE_THRESHOLD = 120;

interface SessionLogViewerProps {
  logs: SessionLog[];
  compactionSnapshots?: ContextSnapshot[];
  className?: string;
  /**
   * Whether the underlying agent is still working. Drives the footer indicator.
   * Omit when unknown — the footer shows a neutral event count rather than
   * claiming the session is complete.
   */
  isRunning?: boolean;
}

export function SessionLogViewer({
  logs,
  compactionSnapshots,
  className,
  isRunning,
}: SessionLogViewerProps) {
  const safeLogs = logs ?? [];
  const messages = useMemo(() => parseSessionLogs(safeLogs), [safeLogs]);

  // Entrance animation only on genuinely-new rows. Kept pure: the render path
  // only READS seen ids; the ref is updated post-commit in an effect (so it's
  // StrictMode double-invoke safe).
  const seenIds = useRef<Set<string>>(new Set());
  const isFirst = useRef(true);
  const newIds = useMemo(() => {
    if (isFirst.current) return new Set<string>();
    const fresh = new Set<string>();
    for (const m of messages) if (!seenIds.current.has(m.id)) fresh.add(m.id);
    return fresh;
  }, [messages]);
  useEffect(() => {
    for (const m of messages) seenIds.current.add(m.id);
    isFirst.current = false;
  }, [messages]);

  const rows = useMemo(
    () => buildStream(messages, compactionSnapshots ?? [], newIds),
    [messages, compactionSnapshots, newIds],
  );

  const [query, setQuery] = useState("");
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.type !== "compaction" && rowSearchText(r).toLowerCase().includes(q),
    );
  }, [rows, query]);

  const virtualize = visibleRows.length > VIRTUALIZE_THRESHOLD;

  // Per-id collapse state, keyed by stable id so it survives refetch + recycling.
  const [groupToggle, setGroupToggle] = useState<Map<string, boolean>>(new Map());
  const [openTools, setOpenTools] = useState<Set<string>>(new Set());
  const [openOutputs, setOpenOutputs] = useState<Set<string>>(new Set());
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashRaf = useRef<number | null>(null);

  const isGroupOpen = useCallback(
    (row: Extract<StreamRow, { type: "toolgroup" }>) => groupToggle.get(row.id) ?? row.defaultOpen,
    [groupToggle],
  );

  const toggleGroup = useCallback((id: string, currentlyOpen: boolean) => {
    setGroupToggle((prev) => new Map(prev).set(id, !currentlyOpen));
  }, []);

  const openGroup = useCallback((id: string) => {
    setGroupToggle((prev) => new Map(prev).set(id, true));
  }, []);

  const toggleTool = useCallback((id: string) => {
    setOpenTools((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleOutput = useCallback((id: string) => {
    setOpenOutputs((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const flashRow = useCallback((id: string) => {
    if (flashRaf.current) cancelAnimationFrame(flashRaf.current);
    setFlashId(null);
    flashRaf.current = requestAnimationFrame(() => setFlashId(id));
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 1300);
  }, []);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (flashRaf.current) cancelAnimationFrame(flashRaf.current);
    },
    [],
  );

  // --- Scroll plumbing (virtualizer + stick-to-bottom + jump pill) ---
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [pending, setPending] = useState(0);
  const prevCount = useRef(0);
  const didInit = useRef(false);

  const estimateSize = useCallback(
    (index: number) => {
      const r = visibleRows[index];
      switch (r?.type) {
        case "agent":
          return 96;
        case "thinking":
          return 52;
        case "meta":
          return 44;
        case "toolgroup":
          return 52;
        case "compaction":
          return 40;
        default:
          return 64;
      }
    },
    [visibleRows],
  );

  const virtualizer = useVirtualizer({
    count: virtualize ? visibleRows.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan: 14,
    getItemKey: (i) => visibleRows[i]?.id ?? i,
  });

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      const ab = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
      atBottomRef.current = ab;
      setAtBottom(ab);
      if (ab) setPending(0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const stickToBottom = useCallback(() => {
    const el = parentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPending(0);
  }, []);

  // Keep pinned to the bottom as content grows/measures (only when already there).
  const totalSize = virtualize ? virtualizer.getTotalSize() : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalSize + visibleRows.length are intentional re-stick triggers — the effect reacts to content growth without reading them in the body.
  useEffect(() => {
    if (atBottomRef.current) requestAnimationFrame(stickToBottom);
  }, [totalSize, visibleRows.length, stickToBottom]);

  // Track newly-appended events for the "N new" pill when scrolled up.
  useEffect(() => {
    const cur = visibleRows.length;
    if (!didInit.current) {
      didInit.current = true;
      prevCount.current = cur;
      return;
    }
    if (cur > prevCount.current && !atBottomRef.current) {
      setPending((p) => p + (cur - prevCount.current));
    }
    prevCount.current = cur;
  }, [visibleRows.length]);

  const jumpTo = useCallback(
    (index: number, row: StreamRow) => {
      if (row.type === "toolgroup") openGroup(row.id);
      if (virtualize) {
        virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
      } else {
        parentRef.current
          ?.querySelector(`[data-row-id="${row.id}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      flashRow(row.id);
    },
    [virtualize, virtualizer, flashRow, openGroup],
  );

  const renderRow = useCallback(
    (row: StreamRow) => {
      const flash = flashId === row.id;
      if (row.type === "compaction") return <CompactionDivider snapshot={row.snapshot} />;
      if (row.type === "agent") {
        const isUser = row.role === "user";
        const isSystem = row.role === "system";
        return (
          <RowShell time={row.time} iso={row.iso} flash={flash} isNew={row.isNew}>
            {(isUser || isSystem) && (
              <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                {isUser ? "You" : "System"}
              </span>
            )}
            <div className="prose-chat prose-session-log mt-[3px] break-words text-foreground">
              <Streamdown>{tidyMarkdown(row.md)}</Streamdown>
            </div>
            <CopyIconButton
              text={row.md}
              className="absolute right-0 top-px cursor-pointer bg-card opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
            />
          </RowShell>
        );
      }
      if (row.type === "thinking") {
        return (
          <RowShell time={row.time} iso={row.iso} flash={flash} isNew={row.isNew}>
            <ThinkingRow text={row.text} />
          </RowShell>
        );
      }
      if (row.type === "meta") {
        return (
          <RowShell time={row.time} iso={row.iso} flash={flash} isNew={row.isNew}>
            <ProviderMetaBubble block={row.block} />
          </RowShell>
        );
      }
      const open = isGroupOpen(row);
      const dur = formatDur(row.durMs);
      return (
        <RowShell time={row.time} iso={row.iso} flash={flash} isNew={row.isNew}>
          <button
            type="button"
            onClick={() => toggleGroup(row.id, open)}
            className="flex w-full min-w-0 cursor-pointer items-center gap-2 py-0.5 text-left"
          >
            <ChevronRight
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform duration-200",
                open && "rotate-90",
              )}
            />
            <span className="shrink-0 text-[12.5px] font-semibold">
              {row.tools.length} {row.tools.length === 1 ? "step" : "steps"}
            </span>
            {dur && (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{dur}</span>
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
              {groupHeader(row.names)}
            </span>
          </button>
          {open && (
            <div className="mt-1.5 flex flex-col gap-1.5 pl-0.5">
              {row.tools.map((t) => (
                <ToolRow
                  key={t.id}
                  tool={t}
                  open={openTools.has(t.id)}
                  onToggle={() => toggleTool(t.id)}
                  outputOpen={openOutputs.has(t.id)}
                  onToggleOutput={() => toggleOutput(t.id)}
                />
              ))}
            </div>
          )}
        </RowShell>
      );
    },
    [flashId, isGroupOpen, openOutputs, openTools, toggleGroup, toggleOutput, toggleTool],
  );

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <TooltipProvider delayDuration={250}>
      <div
        className={cn(
          "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card",
          className,
        )}
      >
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
          <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Session Logs
          </span>
          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter session log"
              className="h-[30px] w-40 pl-7 text-xs sm:w-52"
            />
          </div>
        </div>

        {/* Body */}
        <div className="relative flex min-h-0 flex-1">
          <div
            ref={parentRef}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 [overflow-anchor:none]"
          >
            {visibleRows.length === 0 ? (
              <div className="flex h-full items-center justify-center py-12 text-sm text-muted-foreground">
                {rows.length === 0 ? "No session data" : "No matching events"}
              </div>
            ) : virtualize ? (
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualItems.map((vi) => {
                  const row = visibleRows[vi.index];
                  if (!row) return null;
                  const style: CSSProperties = {
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                  };
                  return (
                    <div
                      key={vi.key}
                      ref={virtualizer.measureElement}
                      data-index={vi.index}
                      data-row-id={row.id}
                      style={style}
                    >
                      {renderRow(row)}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col">
                {visibleRows.map((row) => (
                  <div key={row.id} data-row-id={row.id}>
                    {renderRow(row)}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Minimap rail */}
          {visibleRows.length > 0 && <MinimapRail rows={visibleRows} onJump={jumpTo} />}

          {/* Jump-to-latest pill */}
          <button
            type="button"
            onClick={stickToBottom}
            aria-label="Scroll to latest"
            className={cn(
              "absolute bottom-4 left-1/2 z-10 inline-flex -translate-x-1/2 cursor-pointer items-center gap-2 rounded-full bg-primary px-3.5 py-[7px] text-[12.5px] font-semibold text-primary-foreground shadow-lg transition-all",
              atBottom
                ? "pointer-events-none translate-y-3 opacity-0"
                : "translate-y-0 opacity-100",
            )}
          >
            <ArrowDown className="size-3.5" />
            {pending > 0 ? `${pending} new message${pending === 1 ? "" : "s"}` : null}
          </button>
        </div>

        {/* Footer */}
        <RunningFooter count={visibleRows.length} isRunning={isRunning} />
      </div>
    </TooltipProvider>
  );
}

// Reasoning block. Same collapsible-card shape as ToolRow (chevron · label ·
// inline one-line preview, body behind a border-t) so thinking reads as part of
// the same visual family — just recessed (muted surface, no accent color) to
// signal it's internal reasoning rather than output.
function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = truncate(text.replace(/\s+/g, " ").trim(), 90);
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-90",
          )}
        />
        <Brain className="size-3 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-[12px] font-medium italic text-muted-foreground">
          Thinking
        </span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/80">
            {preview}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-border/60 px-2.5 py-2">
          <div className="prose-chat prose-session-log text-xs text-muted-foreground">
            <Streamdown>{tidyMarkdown(text)}</Streamdown>
          </div>
        </div>
      )}
    </div>
  );
}

function RunningFooter({ count, isRunning }: { count: number; isRunning?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 border-t border-border bg-muted/20 px-3 py-2.5 text-[12.5px]">
      {isRunning === true ? (
        <>
          <span className="sl-orb size-[9px] shrink-0 rounded-full bg-status-active" aria-hidden />
          <span className="font-medium text-foreground">Agent is working…</span>
        </>
      ) : isRunning === false ? (
        <>
          <span
            className="grid size-4 shrink-0 place-items-center rounded-full bg-status-success/20 text-[10px] font-bold text-status-success-strong"
            aria-hidden
          >
            ✓
          </span>
          <span className="text-muted-foreground">Session complete</span>
        </>
      ) : (
        <span className="text-muted-foreground">Session log</span>
      )}
      <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
        {count} {count === 1 ? "event" : "events"}
      </span>
    </div>
  );
}

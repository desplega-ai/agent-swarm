import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Activity,
  ArrowDown,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Gauge,
  Scissors,
  Search,
  Wrench,
} from "lucide-react";
import { Highlight, themes } from "prism-react-renderer";
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
import { JsonTree } from "@/components/workflows/json-tree";
import { useTheme } from "@/hooks/use-theme";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatTokens } from "@/lib/format-tokens";
import { cn, normalizeNewlines } from "@/lib/utils";
import { type ParsedMessage, type ProviderMetaBlock, parseSessionLogs } from "@/logs-parser";

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
  if (name.includes(".") && !name.startsWith(".") && !name.endsWith(".")) {
    const [server, ...toolParts] = name.split(".");
    const tool = toolParts.join(".");
    if (server && tool) {
      return {
        kind: "mcp",
        name: tool,
        server,
        title: `${server}.${tool}`,
        detail: shortDetail(inp),
      };
    }
  }
  if (name.toLowerCase() === "bash") {
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

/** Normalize Unicode bullets at line-start to markdown lists, then paragraph-fix.
 * Fenced code blocks are split out and passed through verbatim — running the
 * single→double newline paragraph fix inside a ``` fence would double-space
 * every code line. Handles unclosed fences (streaming) by matching to EOL. */
function tidyMarkdown(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((part, i) =>
      i % 2 === 1 ? part : normalizeNewlines(part.replace(/^([ \t]*)[•·▪]\s+/gm, "$1- ")),
    )
    .join("");
}

type MetaRow = Extract<StreamRow, { type: "meta" }>;

interface HookRun {
  hookId: string;
  hookName?: string;
  events: Record<string, unknown>[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function shortId(value: string | undefined): string {
  if (!value) return "unknown";
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function formatCompactNumber(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: value < 10 ? 2 : 1 }).format(
    value,
  );
}

function formatUsd(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === 0) return "$0";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 6 : 4,
  }).format(value);
}

function formatMaybeTokens(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return formatTokens(value);
}

function formatPercent(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

function formatResetAt(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return fmtFull(new Date(parsed).toISOString());
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  return fmtFull(new Date(ms).toISOString());
}

function isHookMetaBlock(block: ProviderMetaBlock): boolean {
  return block.kind === "internal" && block.data.internalType === "hook";
}

function hookEventName(data: Record<string, unknown>): string {
  return stringValue(data.hook_event) ?? "Hook";
}

function hookRunId(data: Record<string, unknown>): string {
  return stringValue(data.hook_id) ?? "unknown";
}

function isThinkingTokensBlock(block: ProviderMetaBlock): boolean {
  return block.kind === "helper" && block.data.helperType === "thinking_tokens";
}

function appendProviderMetaRow(rows: StreamRow[], row: MetaRow) {
  if (isThinkingTokensBlock(row.block)) {
    appendThinkingTokenRow(rows, row);
    return;
  }

  if (!isHookMetaBlock(row.block)) {
    rows.push(row);
    return;
  }

  const hookEvent = hookEventName(row.block.data);
  const last = rows[rows.length - 1];
  if (
    last?.type === "meta" &&
    last.block.kind === "internal" &&
    last.block.data.internalType === "hook_group" &&
    last.block.data.hookEvent === hookEvent
  ) {
    appendHookEvent(last.block.data, row.block.data);
    return;
  }

  rows.push({
    ...row,
    block: {
      ...row.block,
      data: {
        internalType: "hook_group",
        hookEvent,
        hooks: [createHookRun(row.block.data)],
      },
    },
  });
}

function createHookRun(data: Record<string, unknown>): HookRun {
  return {
    hookId: hookRunId(data),
    hookName: stringValue(data.hook_name),
    events: [data],
  };
}

function appendHookEvent(groupData: Record<string, unknown>, data: Record<string, unknown>) {
  const hooks = Array.isArray(groupData.hooks) ? (groupData.hooks as HookRun[]) : [];
  const hookId = hookRunId(data);
  let hook = hooks.find((candidate) => candidate.hookId === hookId);
  if (!hook) {
    hook = createHookRun(data);
    hooks.push(hook);
  } else {
    hook.events.push(data);
    hook.hookName = hook.hookName ?? stringValue(data.hook_name);
  }
  groupData.hooks = hooks;
}

function appendThinkingTokenRow(rows: StreamRow[], row: MetaRow) {
  const last = rows[rows.length - 1];
  if (
    last?.type === "meta" &&
    last.block.kind === "helper" &&
    last.block.data.helperType === "thinking_token_group"
  ) {
    appendThinkingTokenEvent(last.block.data, row.block.data, row.iso);
    return;
  }

  rows.push({
    ...row,
    block: {
      ...row.block,
      data: {
        helperType: "thinking_token_group",
        provider: row.block.provider,
        firstIso: row.iso,
        lastIso: row.iso,
        estimatedTokens: numberValue(row.block.data.estimated_tokens),
        estimatedDelta: numberValue(row.block.data.estimated_tokens_delta),
        events: [row.block.data],
        active: false,
      },
    },
  });
}

function appendThinkingTokenEvent(
  groupData: Record<string, unknown>,
  data: Record<string, unknown>,
  iso: string,
) {
  const events = Array.isArray(groupData.events)
    ? (groupData.events as Record<string, unknown>[])
    : [];
  events.push(data);
  groupData.events = events;
  groupData.lastIso = iso;

  const estimated = numberValue(data.estimated_tokens);
  if (estimated !== undefined) groupData.estimatedTokens = estimated;
  const delta = numberValue(data.estimated_tokens_delta);
  if (delta !== undefined) {
    groupData.estimatedDelta = numberValue(groupData.estimatedDelta) ?? 0;
    groupData.estimatedDelta = (groupData.estimatedDelta as number) + delta;
  }
}

function markLiveThinkingGroup(rows: StreamRow[], isRunning?: boolean) {
  const last = rows[rows.length - 1];
  if (
    last?.type === "meta" &&
    last.block.kind === "helper" &&
    last.block.data.helperType === "thinking_token_group"
  ) {
    last.block.data.active = isRunning === true;
  }
}

function buildStream(
  messages: ParsedMessage[],
  snapshots: ContextSnapshot[],
  newIds: Set<string>,
  isRunning?: boolean,
): StreamRow[] {
  // Index every tool_result by the id of the call it answers (+ its timestamp).
  const resultById = new Map<string, { content: string; isError: boolean; at: number }>();
  const callIds = new Set<string>();
  for (const m of messages) {
    const at = new Date(m.timestamp).getTime();
    for (const b of m.content) {
      if (b.type === "tool_use" && b.id) {
        callIds.add(b.id);
      }
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
      if (b.type === "tool_result") {
        if (!b.tool_use_id || callIds.has(b.tool_use_id)) return; // folded into its tool_use group
        closeGroup();
        rows.push({
          type: "toolgroup",
          id: `orphan-${blockId}:${b.tool_use_id}`,
          time,
          iso: m.timestamp,
          tools: [
            {
              id: `${blockId}:${b.tool_use_id}`,
              kind: "other",
              name: "tool_result",
              server: "",
              title: "tool result",
              detail: b.tool_use_id,
              input: "",
              preview: previewOf(b.content),
              body: b.content,
              ok: b.isError !== true,
              hasResult: true,
              durMs: 0,
            },
          ],
          names: ["tool result"],
          durMs: 0,
          defaultOpen: true,
          isNew: newIds.has(m.id),
        });
        return;
      }

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
        appendProviderMetaRow(rows, {
          type: "meta",
          id: blockId,
          time,
          iso: m.timestamp,
          block: b,
          isNew,
        });
      }
    });
  }
  closeGroup();
  markLiveThinkingGroup(rows, isRunning);

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
      return metaOutlineLabel(row.block);
    case "compaction":
      return "Compaction";
  }
}

function metaOutlineLabel(block: ProviderMetaBlock): string {
  if (block.kind === "status") return "Status";
  if (block.kind === "result") {
    const data = block.data;
    const cost = recordValue(data.cost);
    const status =
      data.subtype ?? (data.isError === true || data.is_error === true ? "error" : "ok");
    const model = stringValue(cost?.model) ?? stringValue(data.model);
    return `Result · ${status}${model ? ` · ${model}` : ""}`;
  }
  if (block.kind === "helper") {
    if (block.data.helperType === "thinking_tokens") {
      return `Thinking tokens · ${formatMaybeTokens(numberValue(block.data.estimated_tokens)) ?? "helper"}`;
    }
    if (block.data.helperType === "thinking_token_group") {
      return `Thinking · ${formatMaybeTokens(numberValue(block.data.estimatedTokens)) ?? "tokens"}`;
    }
    if (block.data.helperType === "context_usage") {
      return `Context · ${formatPercent(numberValue(block.data.contextPercent)) ?? "usage"}`;
    }
    if (block.data.helperType === "turn_usage") return "Turn usage";
    return "Helper";
  }
  if (block.kind === "internal") {
    if (block.data.internalType === "rate_limit") {
      const info = recordValue(block.data.rate_limit_info) ?? block.data;
      return `Rate limit · ${stringValue(info.status) ?? "event"}`;
    }
    if (block.data.internalType === "hook_group") {
      const hooks = Array.isArray(block.data.hooks) ? block.data.hooks : [];
      return `Hooks · ${String(block.data.hookEvent ?? "Hook")} · ${hooks.length}`;
    }
    return stringValue(block.data.type) ?? "Runtime";
  }
  if (block.kind === "lifecycle") return stringValue(block.data.type) ?? "Lifecycle";
  const raw = recordValue(block.data.raw);
  return stringValue(raw?.type) ?? block.kind.replaceAll("_", " ");
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

// --- Markdown code blocks -------------------------------------------------
// Agent output frequently embeds fenced code (```bash, ```json, …). Streamdown's
// built-in CodeBlock renders a heavy, double-bordered box whose copy/download
// controls fight the surrounding .prose-* styles (and didn't reliably work). We
// override `code`/`pre` — the same pattern as markdown-view.tsx's Monaco
// override, but lightweight (no editor instances, safe inside the virtualized
// log) — to render one clean terminal-style block with a single working Copy
// button and no download.
// Markdown fence label → Prism language id (Prism's bundled grammars use a few
// different names; unknowns fall through and render as plain, uncolored code).
const PRISM_LANG_ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  ts: "typescript",
  js: "javascript",
  yml: "yaml",
  py: "python",
  rb: "ruby",
  md: "markdown",
  dockerfile: "docker",
};

const LogCodeBlock = memo(function LogCodeBlock({
  language,
  value,
}: {
  language: string;
  value: string;
}) {
  const { theme } = useTheme();
  const lang = language && language.toLowerCase() !== "text" ? language.toLowerCase() : null;
  const prismLang = lang ? (PRISM_LANG_ALIASES[lang] ?? lang) : "text";
  return (
    <div className="sl-code group/code relative my-2 overflow-hidden rounded-lg border border-border/70 bg-muted/40">
      {lang ? (
        <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-muted/50 py-1 pl-3 pr-1">
          <span className="select-none font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {lang}
          </span>
          <CopyIconButton text={value} label="Copy code" className="size-6" />
        </div>
      ) : (
        <CopyIconButton
          text={value}
          label="Copy code"
          className="absolute right-1.5 top-1.5 z-10 bg-muted/80 opacity-0 backdrop-blur transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
        />
      )}
      {/* Prism highlights synchronously (no async flash, safe in the virtualized
          list). We drop the theme's own background so our container surface shows
          through and only keep the per-token colors. */}
      <Highlight
        code={value}
        language={prismLang}
        theme={theme === "dark" ? themes.vsDark : themes.github}
      >
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className="sl-code-pre">
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token, k) => (
                  <span key={k} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
});

// Streamdown component overrides shared by every session-log markdown surface.
const LOG_MD_COMPONENTS = {
  code({
    className,
    children,
    node: _node,
    ...rest
  }: {
    className?: string;
    children?: ReactNode;
    node?: unknown;
  }) {
    const m = /language-([\w-]+)/.exec(className ?? "");
    const raw = Array.isArray(children) ? children.join("") : String(children ?? "");
    // Treat as a block when fenced with a language OR multi-line (inline
    // markdown code is always single-line). Everything else is an inline chip
    // styled by the .prose-* rules.
    if (!m && !raw.includes("\n")) {
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }
    return <LogCodeBlock language={m?.[1] ?? ""} value={raw.replace(/\n$/, "")} />;
  },
  // Our block brings its own container — unwrap Streamdown's <pre> so we don't
  // nest a styled block inside a styled <pre>.
  pre({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  },
};

// Single entry point for session-log markdown: tidies bullets/newlines, disables
// Streamdown's floating table/code controls, and routes fenced code through the
// clean LogCodeBlock above.
function LogMarkdown({ children }: { children: string }) {
  return (
    <Streamdown components={LOG_MD_COMPONENTS} controls={false}>
      {tidyMarkdown(children)}
    </Streamdown>
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
  success: { label: "Success", bg: "bg-status-success/15", text: "text-status-success-strong" },
  allowed: { label: "Allowed", bg: "bg-status-success/15", text: "text-status-success-strong" },
  allowed_warning: {
    label: "Allowed Warning",
    bg: "bg-status-warning/15",
    text: "text-status-warning-strong",
  },
  rejected: { label: "Rejected", bg: "bg-status-error/15", text: "text-status-error-strong" },
  needs_input: {
    label: "Needs Input",
    bg: "bg-status-active/15",
    text: "text-status-active-strong",
  },
  error: { label: "Error", bg: "bg-status-error/15", text: "text-status-error-strong" },
  failed: { label: "Failed", bg: "bg-status-error/15", text: "text-status-error-strong" },
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
  if (block.kind === "status") return <ProviderStatusMeta block={block} />;
  if (block.kind === "helper") return <HelperMetaBubble block={block} />;
  if (block.kind === "internal") return <InternalMetaBubble block={block} />;
  if (block.kind === "result") return <ResultMetaBubble block={block} />;
  if (block.kind === "file_change") return <FileChangeMeta block={block} />;
  if (block.kind !== "structured_output") return <GenericMetaBubble block={block} />;

  return <ProviderStructuredOutputMeta block={block} />;
}

function ProviderStatusMeta({ block }: { block: ProviderMetaBlock }) {
  const status = stringValue(block.data.status) ?? "status";
  const detail = stringValue(block.data.statusDetail);
  const acus = numberValue(block.data.acusConsumed);
  return (
    <LowKeyMetaLine
      icon={<Activity className="size-3" />}
      title="status"
      detail={detail && detail !== status ? detail : undefined}
      raw={block.data}
      stats={
        <>
          <ProviderStatusPill value={detail ?? status} />
          <LowKeyStat
            label="ACUs"
            value={acus !== undefined && acus > 0 ? acus.toFixed(2) : undefined}
          />
        </>
      }
    />
  );
}

function ProviderStructuredOutputMeta({ block }: { block: ProviderMetaBlock }) {
  const taskStatus = stringValue(block.data.taskStatus);
  const output = stringValue(block.data.output);
  const summary = stringValue(block.data.summary);
  return (
    <LowKeyMetaLine
      icon={<Check className="size-3" />}
      title="result"
      detail={summary && !output ? summary : undefined}
      raw={block.data}
      stats={taskStatus ? <ProviderStatusPill value={taskStatus} /> : undefined}
    >
      {summary && output && (
        <p className="max-w-4xl text-[11.5px] leading-snug text-muted-foreground">{summary}</p>
      )}
      {output && (
        <div className="prose-chat prose-session-log max-w-4xl text-xs text-foreground/90">
          <LogMarkdown>{output}</LogMarkdown>
        </div>
      )}
    </LowKeyMetaLine>
  );
}

function HelperMetaBubble({ block }: { block: ProviderMetaBlock }) {
  if (block.data.helperType === "thinking_tokens") return <ThinkingTokensMeta block={block} />;
  if (block.data.helperType === "thinking_token_group") {
    return <ThinkingTokenGroupMeta block={block} />;
  }
  if (block.data.helperType === "context_usage") return <ContextUsageMeta block={block} />;
  if (block.data.helperType === "turn_usage") return <TurnUsageMeta block={block} />;
  return <GenericMetaBubble block={block} />;
}

function InternalMetaBubble({ block }: { block: ProviderMetaBlock }) {
  if (block.data.internalType === "rate_limit") return <RateLimitMeta block={block} />;
  if (block.data.internalType === "hook_group") return <HookGroupMeta block={block} />;
  if (block.data.internalType === "runtime") return <RuntimeInternalMeta block={block} />;
  return <GenericMetaBubble block={block} />;
}

function MetaPanel({
  icon,
  title,
  badge,
  children,
  raw,
  tone = "muted",
}: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  children?: ReactNode;
  raw: unknown;
  tone?: "muted" | "info" | "success" | "warning" | "error";
}) {
  const toneClass = {
    muted: "border-border/60 bg-muted/25",
    info: "border-status-info/30 bg-status-info/5",
    success: "border-status-success/30 bg-status-success/5",
    warning: "border-status-warning/30 bg-status-warning/5",
    error: "border-status-error/30 bg-status-error/5",
  }[tone];
  return (
    <div className={cn("overflow-hidden rounded-lg border px-3 py-2", toneClass)}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="grid size-5 shrink-0 place-items-center rounded-md bg-background/60 text-muted-foreground">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {badge}
      </div>
      {children && <div className="mt-2">{children}</div>}
      <RawDetails data={raw} />
    </div>
  );
}

function MetaStat({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1 rounded-md border border-border/60 bg-background/60 px-1.5 py-1">
      <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="truncate font-mono text-[11px] text-foreground">{value}</span>
    </span>
  );
}

function RawDetails({ data }: { data: unknown }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => safeJson(data), [data]);
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-background/60 hover:text-foreground"
        >
          <ChevronRight
            className={cn("size-3 transition-transform duration-200", open && "rotate-90")}
          />
          Raw
        </button>
        <CopyIconButton text={text} label="Copy raw event" className="size-5" />
      </div>
      {open && (
        <JsonTree
          data={data}
          defaultExpandDepth={1}
          maxHeight="260px"
          className="mt-1 bg-muted/50"
        />
      )}
    </div>
  );
}

function LowKeyMetaLine({
  icon,
  title,
  detail,
  stats,
  raw,
  children,
}: {
  icon: ReactNode;
  title?: string;
  detail?: string;
  stats?: ReactNode;
  raw: unknown;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => safeJson(raw), [raw]);
  return (
    <div className="py-0.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/75">
          {icon}
        </span>
        {title && <span className="font-mono uppercase tracking-wider">{title}</span>}
        {detail && <span className="min-w-0 max-w-full truncate">{detail}</span>}
        {stats}
        <span className="ml-auto inline-flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="inline-flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/80 hover:bg-muted hover:text-foreground"
          >
            <ChevronRight
              className={cn("size-2.5 transition-transform duration-200", open && "rotate-90")}
            />
            Raw
          </button>
          <CopyIconButton text={text} label="Copy raw event" className="size-5" />
        </span>
      </div>
      {children && <div className="ml-6 mt-1 space-y-1">{children}</div>}
      {open && (
        <JsonTree
          data={raw}
          defaultExpandDepth={1}
          maxHeight="220px"
          className="mt-1.5 bg-muted/50"
        />
      )}
    </div>
  );
}

function LowKeyStat({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <span className="inline-flex items-baseline gap-1 font-mono text-[10.5px] text-muted-foreground">
      <span className="uppercase tracking-wider text-muted-foreground/75">{label}</span>
      <span className="text-foreground/80">{value}</span>
    </span>
  );
}

function formatThoughtDuration(firstIso: unknown, lastIso: unknown): string {
  if (typeof firstIso !== "string" || typeof lastIso !== "string") return "briefly";
  const first = Date.parse(firstIso);
  const last = Date.parse(lastIso);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return "briefly";
  const ms = Math.max(0, last - first);
  return formatDur(ms) || "<1s";
}

function ThinkingTokensMeta({ block }: { block: ProviderMetaBlock }) {
  const total = formatMaybeTokens(numberValue(block.data.estimated_tokens));
  const delta = formatMaybeTokens(numberValue(block.data.estimated_tokens_delta));
  return (
    <LowKeyMetaLine
      icon={<Brain className="size-3" />}
      raw={block.data}
      detail={`Thinking${total ? ` · ${total} estimated tokens` : ""}`}
      stats={<LowKeyStat label="Delta" value={delta ? `+${delta}` : undefined} />}
    />
  );
}

function ThinkingTokenGroupMeta({ block }: { block: ProviderMetaBlock }) {
  const active = block.data.active === true;
  const tokens = formatMaybeTokens(numberValue(block.data.estimatedTokens));
  const duration = formatThoughtDuration(block.data.firstIso, block.data.lastIso);
  const text = active
    ? `Thinking${tokens ? ` · ${tokens} estimated tokens` : ""}`
    : `Thought for ${duration}${tokens ? ` · ${tokens} estimated thinking tokens` : ""}`;
  return (
    <LowKeyMetaLine
      icon={<Brain className="size-3" />}
      detail={active ? undefined : text}
      raw={block.data}
      stats={
        active ? (
          <span className="shimmer-text font-mono text-[11px] font-medium">{text}</span>
        ) : undefined
      }
    />
  );
}

function ContextUsageMeta({ block }: { block: ProviderMetaBlock }) {
  const used = formatMaybeTokens(numberValue(block.data.contextUsedTokens));
  const total = formatMaybeTokens(numberValue(block.data.contextTotalTokens));
  const percent = formatPercent(numberValue(block.data.contextPercent));
  const output = formatMaybeTokens(numberValue(block.data.outputTokens));
  return (
    <LowKeyMetaLine
      icon={<Gauge className="size-3" />}
      title="context"
      raw={block.data}
      stats={
        <>
          <LowKeyStat label="Used" value={used && total ? `${used} / ${total}` : used} />
          <LowKeyStat label="Out" value={output} />
          <LowKeyStat label="Pct" value={percent} />
          <LowKeyStat label="Formula" value={stringValue(block.data.contextFormula)} />
        </>
      }
    />
  );
}

function TurnUsageMeta({ block }: { block: ProviderMetaBlock }) {
  const usage = recordValue(block.data.usage) ?? {};
  return (
    <LowKeyMetaLine
      icon={<Gauge className="size-3" />}
      raw={block.data}
      stats={
        <>
          <LowKeyStat label="In" value={formatMaybeTokens(numberValue(usage.input_tokens))} />
          <LowKeyStat
            label="Cached"
            value={formatMaybeTokens(numberValue(usage.cached_input_tokens))}
          />
          <LowKeyStat label="Out" value={formatMaybeTokens(numberValue(usage.output_tokens))} />
          <LowKeyStat
            label="Reasoning"
            value={formatMaybeTokens(numberValue(usage.reasoning_output_tokens))}
          />
        </>
      }
    />
  );
}

function RateLimitMeta({ block }: { block: ProviderMetaBlock }) {
  const info = recordValue(block.data.rate_limit_info) ?? block.data;
  const status = stringValue(info.status) ?? "rate limit";
  const reset = formatResetAt(info.resetsAt ?? info.resets_at ?? block.data.rateLimitResetAt);
  return (
    <LowKeyMetaLine
      icon={<Activity className="size-3" />}
      title="rate limit"
      detail={status}
      raw={block.data}
      stats={
        <>
          <LowKeyStat
            label="Type"
            value={stringValue(info.rateLimitType ?? info.rate_limit_type)}
          />
          <LowKeyStat label="Resets" value={reset} />
          <LowKeyStat label="Overage" value={stringValue(info.overageStatus)} />
        </>
      }
    />
  );
}

function HookGroupMeta({ block }: { block: ProviderMetaBlock }) {
  const hookEvent = String(block.data.hookEvent ?? "Hook");
  const hooks = Array.isArray(block.data.hooks) ? (block.data.hooks as HookRun[]) : [];
  return (
    <LowKeyMetaLine
      icon={<Wrench className="size-3" />}
      title="hooks"
      detail={hookEvent}
      raw={block.data}
      stats={
        <LowKeyStat
          label="Runs"
          value={`${hooks.length} ${hooks.length === 1 ? "hook" : "hooks"}`}
        />
      }
    >
      {hooks.map((hook) => (
        <HookRunRow key={hook.hookId} hook={hook} />
      ))}
    </LowKeyMetaLine>
  );
}

function HookRunRow({ hook }: { hook: HookRun }) {
  const response = hook.events.find((event) => event.subtype === "hook_response");
  const started = hook.events.find((event) => event.subtype === "hook_started");
  const outcome = stringValue(response?.outcome);
  const exit = numberValue(response?.exit_code);
  const output = stringValue(response?.output ?? response?.stdout);
  const ok = !response || outcome === "success" || exit === 0;
  return (
    <div className="text-[11px] text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-foreground/80">
          {hook.hookName ?? stringValue(started?.hook_name) ?? "hook"}
        </span>
        <span className="shrink-0 font-mono text-[10px]">{shortId(hook.hookId)}</span>
        {response && (
          <span
            className={cn(
              "shrink-0 font-mono text-[10px] uppercase tracking-wide",
              ok ? "text-status-success-strong/85" : "text-status-error-strong/85",
            )}
          >
            {outcome ?? (ok ? "ok" : "error")}
          </span>
        )}
      </div>
      {output && (
        <p className="mt-1 truncate text-[11px] leading-snug text-muted-foreground">
          {output.replace(/\s+/g, " ")}
        </p>
      )}
    </div>
  );
}

function RuntimeInternalMeta({ block }: { block: ProviderMetaBlock }) {
  const type = stringValue(block.data.type) ?? "runtime";
  const props = recordValue(block.data.properties);
  const info = recordValue(props?.info);
  const model = recordValue(info?.model);
  const status = recordValue(props?.status);
  const sessionId =
    stringValue(block.data.sessionId) ??
    stringValue(block.data.sessionID) ??
    stringValue(props?.sessionID);
  const title =
    stringValue(info?.title) ??
    stringValue(status?.type) ??
    stringValue(props?.event) ??
    stringValue(props?.file);
  return (
    <LowKeyMetaLine
      icon={<Activity className="size-3" />}
      title={type}
      detail={title}
      raw={block.data}
      stats={
        <>
          <LowKeyStat label="Session" value={sessionId ? shortId(sessionId) : undefined} />
          <LowKeyStat label="Agent" value={stringValue(info?.agent)} />
          <LowKeyStat
            label="Model"
            value={
              stringValue(model?.id) ?? stringValue(model?.modelID) ?? stringValue(model?.modelId)
            }
          />
        </>
      }
    />
  );
}

function ResultMetaBubble({ block }: { block: ProviderMetaBlock }) {
  const data = block.data;
  const cost: Record<string, unknown> = recordValue(data.cost) ?? {};
  const usage: Record<string, unknown> = recordValue(data.usage) ?? {};
  const isError = data.isError === true || data.is_error === true || cost.isError === true;
  const status = stringValue(data.subtype) ?? (isError ? "error" : "success");
  const output = stringValue(data.output) ?? stringValue(data.result);
  const model = stringValue(cost.model) ?? stringValue(data.model);
  return (
    <MetaPanel
      icon={<Check className="size-3" />}
      title="Result"
      raw={data}
      tone={isError ? "error" : "success"}
      badge={<ProviderStatusPill value={status} />}
    >
      <div className="flex flex-wrap gap-1.5">
        <MetaStat label="Model" value={model} />
        <MetaStat
          label="Cost"
          value={formatUsd(numberValue(cost.totalCostUsd) ?? numberValue(data.total_cost_usd))}
        />
        <MetaStat
          label="Duration"
          value={formatDur(numberValue(cost.durationMs) ?? numberValue(data.duration_ms) ?? 0)}
        />
        <MetaStat
          label="Turns"
          value={formatCompactNumber(numberValue(cost.numTurns) ?? numberValue(data.num_turns))}
        />
        <MetaStat
          label="Input"
          value={formatMaybeTokens(
            numberValue(cost.inputTokens) ?? numberValue(usage.input_tokens),
          )}
        />
        <MetaStat
          label="Output"
          value={formatMaybeTokens(
            numberValue(cost.outputTokens) ?? numberValue(usage.output_tokens),
          )}
        />
        <MetaStat
          label="Cache R"
          value={formatMaybeTokens(
            numberValue(cost.cacheReadTokens) ?? numberValue(usage.cache_read_input_tokens),
          )}
        />
        <MetaStat
          label="Cache W"
          value={formatMaybeTokens(
            numberValue(cost.cacheWriteTokens) ?? numberValue(usage.cache_creation_input_tokens),
          )}
        />
      </div>
      {output && (
        <div className="prose-chat prose-session-log mt-2 border-t border-border/50 pt-2 text-sm text-foreground">
          <LogMarkdown>{output}</LogMarkdown>
        </div>
      )}
    </MetaPanel>
  );
}

function FileChangeMeta({ block }: { block: ProviderMetaBlock }) {
  const diff = block.data.diff;
  const changes = extractFileChanges(diff);
  return (
    <MetaPanel
      icon={<Scissors className="size-3" />}
      title="File changes"
      raw={block.data}
      tone="muted"
      badge={
        <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {changes.length || 1} {changes.length === 1 ? "file" : "files"}
        </span>
      }
    >
      {changes.length > 0 ? (
        <div className="space-y-1">
          {changes.slice(0, 8).map((change, index) => (
            <div
              key={`${change.path}-${index}`}
              className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-background/55 px-2 py-1"
            >
              <span className="shrink-0 rounded bg-muted px-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                {change.kind ?? "change"}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                {change.path}
              </span>
            </div>
          ))}
          {changes.length > 8 && (
            <div className="px-1 font-mono text-[10px] text-muted-foreground">
              +{changes.length - 8} more files
            </div>
          )}
        </div>
      ) : null}
    </MetaPanel>
  );
}

function extractFileChanges(value: unknown): Array<{ path: string; kind?: string }> {
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractFileChanges(item));
  }
  const obj = recordValue(value);
  if (!obj) return [];
  const nested = obj.diff ?? obj.changes;
  if (Array.isArray(nested)) return extractFileChanges(nested);
  const path = stringValue(obj.path) ?? stringValue(obj.file);
  if (!path) return [];
  return [{ path, kind: stringValue(obj.kind) ?? stringValue(obj.event) }];
}

function GenericMetaBubble({ block }: { block: ProviderMetaBlock }) {
  const kindLabel: Record<ProviderMetaBlock["kind"], string> = {
    status: "Status",
    structured_output: "Result",
    internal: "Internal",
    helper: "Helper",
    lifecycle: "Lifecycle",
    result: "Result",
    file_change: "File Change",
    parse_error: "Parse Error",
    unknown: "Unknown",
  };
  const raw = recordValue(block.data.raw);
  const eventName = stringValue(block.data.type) ?? stringValue(raw?.type);
  const subtype = stringValue(block.data.subtype) ?? stringValue(raw?.subtype);
  if (block.kind === "lifecycle") {
    return (
      <LowKeyMetaLine
        icon={<Activity className="size-3" />}
        title={eventName ?? "lifecycle"}
        detail={subtype}
        raw={block.data}
      />
    );
  }

  return (
    <MetaPanel
      icon={<Activity className="size-3" />}
      title={eventName ? `${kindLabel[block.kind]} · ${eventName}` : kindLabel[block.kind]}
      raw={block.data}
      tone={block.kind === "parse_error" ? "error" : "muted"}
    >
      {block.kind === "parse_error" && (
        <JsonTree
          data={block.data}
          defaultExpandDepth={1}
          maxHeight="260px"
          className="bg-muted/50"
        />
      )}
    </MetaPanel>
  );
}

// Shared 2-column [time | content] row scaffold (prose / thinking / meta / tool group).
function RowShell({
  time,
  iso,
  flash,
  isNew,
  highlight,
  streamDelayMs,
  children,
}: {
  time: string;
  iso: string;
  flash?: boolean;
  isNew?: boolean;
  /** Row streamed in while the viewer was following — slide in + light highlight. */
  highlight?: boolean;
  /** Delay (ms) before the entrance plays — drives the one-by-one staggered reveal. */
  streamDelayMs?: number;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group grid grid-cols-[46px_minmax(0,1fr)] items-start gap-x-3 border-b border-border/40 py-[7px] transition-colors hover:bg-muted/50 sm:grid-cols-[54px_minmax(0,1fr)] sm:gap-x-[18px]",
        flash && "sl-flash",
        // One animation per element (the `animation` shorthands would clobber
        // each other): a row that arrives while following slides in AND glows;
        // otherwise it just slides in.
        highlight ? "sl-stream" : isNew && "sl-enter",
      )}
      style={streamDelayMs ? { animationDelay: `${streamDelayMs}ms` } : undefined}
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

// Staggered-reveal tuning: when a poll appends a small batch of new rows while
// following, each row after the first is delayed by STAGGER_STEP_MS so they
// cascade in one-by-one. Batches larger than STAGGER_MAX_ROWS (catch-up /
// initial load) skip the stagger and appear together.
const STAGGER_MAX_ROWS = 6;
const STAGGER_STEP_MS = 100;

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
    () => buildStream(messages, compactionSnapshots ?? [], newIds, isRunning),
    [messages, compactionSnapshots, newIds, isRunning],
  );

  const { searchParams, setParam } = useUrlSearchState();
  const query = readStringParam(searchParams, "logSearch");
  const setQuery = useCallback((value: string) => setParam("logSearch", value), [setParam]);
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
  const contentRef = useRef<HTMLDivElement | null>(null);
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
    // Don't compute atBottom synchronously here: on first mount scrollTop is 0
    // while content overflows, which would latch "not at bottom" and defeat the
    // initial pin below. The pin establishes the at-bottom state; real scroll
    // events take over from there.
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const stickToBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    // In virtualized mode getTotalSize() is an estimate until rows measure, so a
    // bare scrollTop can undershoot the real bottom. scrollToIndex forces the
    // tail to render + measure; the scrollTop assignment then lands flush.
    if (virtualize && visibleRows.length > 0) {
      virtualizer.scrollToIndex(visibleRows.length - 1, { align: "end" });
    }
    el.scrollTop = el.scrollHeight;
    setPending(0);
  }, [virtualize, virtualizer, visibleRows.length]);

  // Keep pinned to the bottom as content grows/measures (only when already there).
  const totalSize = virtualize ? virtualizer.getTotalSize() : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalSize + visibleRows.length are intentional re-stick triggers — the effect reacts to content growth without reading them in the body.
  useEffect(() => {
    if (atBottomRef.current) requestAnimationFrame(stickToBottom);
  }, [totalSize, visibleRows.length, stickToBottom]);

  // Land at the newest event when the viewer first populates, and re-pin across
  // a few frames while async content (virtualizer measurement, Streamdown,
  // fonts) settles. Conventional log/chat behavior: opening a task drops you at
  // the bottom whether the agent is still streaming or already finished — fixes
  // both "doesn't auto-follow on open" and "completed task opens at the top".
  const didInitialPin = useRef(false);
  const hasRows = visibleRows.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on first content; intentionally re-pins across frames without re-subscribing.
  useLayoutEffect(() => {
    if (didInitialPin.current || !hasRows) return;
    didInitialPin.current = true;
    atBottomRef.current = true;
    setAtBottom(true);
    const lastIndex = visibleRows.length - 1;
    const landAtBottom = () => {
      const el = parentRef.current;
      if (!el) return;
      if (virtualize && lastIndex >= 0) {
        virtualizer.scrollToIndex(lastIndex, { align: "end" });
      }
      el.scrollTop = el.scrollHeight;
    };
    landAtBottom();
    let frame = 0;
    let raf = requestAnimationFrame(function settle() {
      landAtBottom();
      if (++frame < 12) raf = requestAnimationFrame(settle);
    });
    return () => cancelAnimationFrame(raf);
  }, [hasRows]);

  // Re-pin to the bottom whenever the content grows while we're in follow mode.
  // The growth-stick effect above only reacts to row-count / virtualizer-total
  // changes; it misses a row whose own height grows after it's added (streaming
  // text, async markdown + Prism layout). Observing the content box catches all
  // of those — this is what actually keeps the log auto-following.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) stickToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [stickToBottom]);

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

  // Staggered reveal — when a poll appends a small batch of new rows while we're
  // following the tail, give each row after the first an incremental
  // animation-delay so they cascade in one-by-one instead of popping in all at
  // once. Excluded: scrolled-up state and large/initial batches (appear at
  // once). Map: row id → delay (ms).
  const staggerById = useMemo(() => {
    const m = new Map<string, number>();
    if (!atBottomRef.current) return m;
    const fresh = visibleRows.filter((r) => r.type !== "compaction" && r.isNew);
    if (fresh.length === 0 || fresh.length > STAGGER_MAX_ROWS) return m;
    fresh.forEach((r, i) => {
      if (i > 0) m.set(r.id, i * STAGGER_STEP_MS);
    });
    return m;
  }, [visibleRows]);

  const renderRow = useCallback(
    (row: StreamRow) => {
      const flash = flashId === row.id;
      if (row.type === "compaction") return <CompactionDivider snapshot={row.snapshot} />;
      const streamDelayMs = staggerById.get(row.id) ?? 0;
      if (row.type === "agent") {
        const isUser = row.role === "user";
        const isSystem = row.role === "system";
        return (
          <RowShell
            time={row.time}
            iso={row.iso}
            flash={flash}
            isNew={row.isNew}
            highlight={row.isNew && atBottomRef.current}
            streamDelayMs={streamDelayMs}
          >
            {(isUser || isSystem) && (
              <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                {isUser ? "You" : "System"}
              </span>
            )}
            <div className="prose-chat prose-session-log mt-[3px] break-words text-foreground">
              <LogMarkdown>{row.md}</LogMarkdown>
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
          <RowShell
            time={row.time}
            iso={row.iso}
            flash={flash}
            isNew={row.isNew}
            highlight={row.isNew && atBottomRef.current}
            streamDelayMs={streamDelayMs}
          >
            <ThinkingRow text={row.text} />
          </RowShell>
        );
      }
      if (row.type === "meta") {
        return (
          <RowShell
            time={row.time}
            iso={row.iso}
            flash={flash}
            isNew={row.isNew}
            highlight={row.isNew && atBottomRef.current}
            streamDelayMs={streamDelayMs}
          >
            <ProviderMetaBubble block={row.block} />
          </RowShell>
        );
      }
      const open = isGroupOpen(row);
      const dur = formatDur(row.durMs);
      return (
        <RowShell
          time={row.time}
          iso={row.iso}
          flash={flash}
          isNew={row.isNew}
          highlight={row.isNew && atBottomRef.current}
        >
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
    [
      flashId,
      isGroupOpen,
      openOutputs,
      openTools,
      toggleGroup,
      toggleOutput,
      toggleTool,
      staggerById,
    ],
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
            <div ref={contentRef}>
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
            <LogMarkdown>{text}</LogMarkdown>
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

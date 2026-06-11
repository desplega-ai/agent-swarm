import { type ReactNode, useMemo, useState } from "react";
import { getTranscript } from "../api.ts";
import { HarnessIcon } from "../components/HarnessIcon.tsx";
import { JsonView } from "../components/JsonView.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { usePoll } from "../hooks.ts";
import {
  itemsToParsedMessages,
  normalizeSessionLogs,
  type ParsedMessage,
  type ProviderMetaBlock,
  type SessionLogRecord,
  type ToolResultBlock,
  type ToolUseBlock,
} from "../logs-parser/index.ts";
import "./transcript.css";

const THINKING_COLLAPSE = 400;
/** Successful tool results clip earlier (item 8 — no walls of monospace). */
const RESULT_CLIP = 700;
const ERROR_RESULT_CLIP = 2_000;
const RAW_CLIP = 2_000;

interface MetaLine {
  key: string;
  block: ProviderMetaBlock;
}

type Entry =
  | { kind: "divider"; key: string; iteration: number }
  | { kind: "msg"; key: string; msg: ParsedMessage }
  | { kind: "metas"; key: string; lines: MetaLine[] }
  | { kind: "raw"; key: string; cli: string; content: string; iteration: number };

interface BuiltTranscript {
  entries: Entry[];
  messageCount: number;
  /** Rows that contributed nothing to a parsed message — rendered as raw fallbacks. */
  unparsedCount: number;
  resultById: Map<string, ToolResultBlock>;
  callIds: Set<string>;
}

/**
 * Item 15 — render ALL rows. Every source row either contributes to a parsed
 * message (text/tool/meta blocks) or renders in place as a `.t-raw` fallback;
 * nothing is silently dropped.
 */
function buildTranscript(rows: SessionLogRecord[]): BuiltTranscript {
  const result = normalizeSessionLogs(rows);

  // Rows that failed JSONL decode render as raw text, not buried meta lines.
  const rawRecIds = new Set<string>();
  const items = result.items.filter((item) => {
    if (item.kind !== "parse_error") return true;
    rawRecIds.add(item.recId);
    return false;
  });
  const messages = itemsToParsedMessages(items);

  // Coverage: source rows that produced at least one content block.
  const covered = new Set<string>();
  for (const item of items) {
    if (item.kind === "tool_call" && !item.tool) continue;
    if (item.kind === "tool_result" && !item.result) continue;
    covered.add(item.recId);
    for (const id of item.coveredRecIds ?? []) covered.add(id);
  }

  const messagesByRec = new Map<string, ParsedMessage[]>();
  for (const msg of messages) {
    const list = messagesByRec.get(msg.id);
    if (list) list.push(msg);
    else messagesByRec.set(msg.id, [msg]);
  }

  // Pair tool results to their calls across ALL messages by tool_use_id.
  const resultById = new Map<string, ToolResultBlock>();
  const callIds = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_result") resultById.set(block.tool_use_id, block);
      else if (block.type === "tool_use") callIds.add(block.id);
    }
  }

  // Interleave: messages render at their first source row; uncovered rows
  // become raw entries in their original position.
  type SeqNode =
    | { kind: "msg"; msg: ParsedMessage }
    | { kind: "raw"; key: string; cli: string; content: string; iteration: number };
  const sequence: SeqNode[] = [];
  const emitted = new Set<string>();
  let unparsedCount = 0;
  result.ordered.forEach((d, i) => {
    const rec = d.rec;
    if (!rawRecIds.has(rec.id)) {
      const msgs = messagesByRec.get(rec.id);
      if (msgs && !emitted.has(rec.id)) {
        emitted.add(rec.id);
        for (const msg of msgs) sequence.push({ kind: "msg", msg });
        return;
      }
      if (covered.has(rec.id)) return;
    }
    unparsedCount++;
    sequence.push({
      kind: "raw",
      key: `raw-${i}`,
      cli: rec.cli,
      content: rec.content,
      iteration: rec.iteration,
    });
  });

  // Iteration dividers + collapsing of consecutive meta-only messages.
  const entries: Entry[] = [];
  let prevIteration: number | null = null;
  sequence.forEach((node, i) => {
    const iteration = node.kind === "msg" ? node.msg.iteration : node.iteration;
    const crossed = prevIteration !== null && iteration !== prevIteration;
    if (crossed) entries.push({ kind: "divider", key: `div-${i}`, iteration });
    prevIteration = iteration;

    if (node.kind === "raw") {
      entries.push(node);
      return;
    }
    const msg = node.msg;
    const metas = msg.content.filter((b): b is ProviderMetaBlock => b.type === "provider_meta");
    if (metas.length > 0 && metas.length === msg.content.length) {
      // meta-only message — consecutive ones collapse into one group
      const lines = metas.map((block, j) => ({ key: `m-${i}-${j}`, block }));
      const last = entries[entries.length - 1];
      if (last && last.kind === "metas") last.lines.push(...lines);
      else entries.push({ kind: "metas", key: `metas-${i}`, lines });
    } else {
      entries.push({ kind: "msg", key: `msg-${i}`, msg });
    }
  });

  return { entries, messageCount: messages.length, unparsedCount, resultById, callIds };
}

export default function Transcript(props: { attemptId: string; live?: boolean }): ReactNode {
  const live = props.live === true;
  const { data, error } = usePoll(
    () => getTranscript(props.attemptId, { live }),
    live ? 5000 : null,
    [props.attemptId, live],
  );

  const built = useMemo(
    () => (data?.source === "raw-session-logs" && data.rows ? buildTranscript(data.rows) : null),
    [data],
  );

  if (!data) {
    return (
      <div className="transcript">
        {error ? (
          <div className="t-empty dim">Transcript failed to load: {error}</div>
        ) : (
          <div className="t-empty">
            <Spinner label="Loading transcript…" />
          </div>
        )}
      </div>
    );
  }

  if (data.source === null) {
    return (
      <div className="transcript">
        <div className="t-empty dim">No transcript captured</div>
        {live ? <Footer /> : null}
      </div>
    );
  }

  if (data.source === "transcript") {
    return (
      <div className="transcript">
        <Caption harness={data.harness} live={false}>
          <span className="t-caption-sep">·</span>
          <span>Legacy flat transcript (older run)</span>
        </Caption>
        <pre className="t-flat">{data.text ?? ""}</pre>
        {live ? <Footer /> : null}
      </div>
    );
  }

  const rowCount = data.rows?.length ?? 0;
  return (
    <div className="transcript">
      <Caption harness={data.harness} live={data.live === true}>
        <span className="t-caption-sep">·</span>
        <span>{rowCount.toLocaleString()} Events</span>
        <span className="t-caption-sep">·</span>
        <span>{(built?.messageCount ?? 0).toLocaleString()} Messages</span>
        {built && built.unparsedCount > 0 ? (
          <>
            <span className="t-caption-sep">·</span>
            <Tooltip text="Rows the parser could not decode — rendered below as raw text">
              <span className="t-unparsed">{built.unparsedCount.toLocaleString()} Unparsed</span>
            </Tooltip>
          </>
        ) : null}
      </Caption>
      {rowCount === 0 ? <div className="t-empty dim">No events yet</div> : null}
      {built?.entries.map((entry) => {
        switch (entry.kind) {
          case "divider": {
            return (
              <div className="t-divider" key={entry.key}>
                — Iteration {entry.iteration} —
              </div>
            );
          }
          case "metas": {
            return <MetaGroup lines={entry.lines} key={entry.key} />;
          }
          case "raw": {
            return <RawRow cli={entry.cli} content={entry.content} key={entry.key} />;
          }
          default: {
            return (
              <MessageCard
                msg={entry.msg}
                resultById={built.resultById}
                callIds={built.callIds}
                key={entry.key}
              />
            );
          }
        }
      })}
      {live ? <Footer /> : null}
    </div>
  );
}

function Caption(props: {
  harness: string | null;
  live: boolean;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="t-caption">
      {props.live ? (
        <Tooltip text="Streaming from the attempt's sandbox — refreshes every 5s">
          <span className="t-live pulse">● Live</span>
        </Tooltip>
      ) : null}
      {props.harness ? (
        <HarnessIcon harness={props.harness} size={13} showLabel />
      ) : (
        <span className="dim">Unknown harness</span>
      )}
      {props.children}
    </div>
  );
}

function Footer(): ReactNode {
  return (
    <div className="t-footer">
      <Spinner label="Streaming…" />
    </div>
  );
}

// ---- per-event-type components (item 15; polish item 8) ----

const ROLE_GLYPHS: Record<ParsedMessage["role"], string> = {
  assistant: "✦",
  user: "◆",
  system: "○",
};

function fmtTime(iso: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function MessageCard(props: {
  msg: ParsedMessage;
  resultById: Map<string, ToolResultBlock>;
  callIds: Set<string>;
}): ReactNode {
  const { msg, resultById, callIds } = props;
  const rendered: ReactNode[] = [];
  // blocks never reorder within a parsed message — positional keys are stable
  let pos = 0;
  for (const block of msg.content) {
    const key = `b${pos++}`;
    switch (block.type) {
      case "text": {
        if (block.text) {
          rendered.push(<TextView text={block.text} role={msg.role} key={key} />);
        }
        break;
      }
      case "thinking": {
        rendered.push(<Thinking text={block.thinking} key={key} />);
        break;
      }
      case "tool_use": {
        rendered.push(
          <ToolCard call={block} result={resultById.get(block.id) ?? null} key={key} />,
        );
        break;
      }
      case "tool_result": {
        // paired results render inline under their call; only orphans render standalone
        if (!callIds.has(block.tool_use_id)) {
          rendered.push(<OrphanResult result={block} key={key} />);
        }
        break;
      }
      case "provider_meta": {
        rendered.push(<MetaLineView block={block} key={key} />);
        break;
      }
    }
  }
  if (rendered.length === 0) {
    const onlyPairedResults = msg.content.every(
      (b) => b.type === "tool_result" && callIds.has(b.tool_use_id),
    );
    if (onlyPairedResults) return null; // those rows render under their tool calls
    rendered.push(
      <div className="t-text dim" key="empty">
        (Empty message)
      </div>,
    );
  }
  const time = fmtTime(msg.timestamp);
  return (
    <div className={`t-msg t-${msg.role}`}>
      <div className="t-head">
        <span className={`t-glyph t-glyph-${msg.role}`} aria-hidden="true">
          {ROLE_GLYPHS[msg.role]}
        </span>
        <span className="t-role">{msg.role}</span>
        {time ? <span className="t-time">{time}</span> : null}
      </div>
      {rendered}
    </div>
  );
}

/** Assistant prose renders as markdown (item 8); other roles stay plain pre-wrap text. */
function TextView(props: { text: string; role: ParsedMessage["role"] }): ReactNode {
  if (props.role === "assistant") {
    return (
      <div className="t-text">
        <Markdown text={props.text} />
      </div>
    );
  }
  return <div className="t-text t-text-plain">{props.text}</div>;
}

function Thinking(props: { text: string }): ReactNode {
  const collapsible = props.text.length > THINKING_COLLAPSE;
  const [open, setOpen] = useState(!collapsible);
  if (!open) {
    return (
      <button type="button" className="t-toggle" onClick={() => setOpen(true)}>
        ▸ Thinking ({props.text.length.toLocaleString()} chars)
      </button>
    );
  }
  return (
    <div className="t-thinking-wrap">
      {collapsible ? (
        <button type="button" className="t-toggle" onClick={() => setOpen(false)}>
          ▾ Thinking ({props.text.length.toLocaleString()} chars)
        </button>
      ) : null}
      <div className="t-thinking">{props.text}</div>
    </div>
  );
}

/** Result state as a shared status glyph (item 8) — ✓ / ✗ / ○ with hover info. */
function ToolStatus(props: { result: ToolResultBlock | null }): ReactNode {
  const { result } = props;
  if (result === null) return <StatusBadge status="pending" tip="No result captured" />;
  if (result.isError) return <StatusBadge status="failed" tip="Tool returned an error" />;
  return <StatusBadge status="passed" tip="Tool succeeded" />;
}

/** Keys most likely to be the human-meaningful argument, in preference order. */
const PREVIEW_KEYS = ["command", "file_path", "path", "url", "pattern"];

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Single-line dim preview of the first meaningful string argument (item 8). */
function argPreview(input: unknown): string | null {
  if (typeof input === "string" && input.trim().length > 0) return squash(input);
  const rec = plainRecord(input);
  if (!rec) return null;
  for (const key of PREVIEW_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v.trim().length > 0) return squash(v);
  }
  for (const v of Object.values(rec)) {
    if (typeof v === "string" && v.trim().length > 0) return squash(v);
  }
  return null;
}

function ToolCard(props: { call: ToolUseBlock; result: ToolResultBlock | null }): ReactNode {
  const { call, result } = props;
  const [argsOpen, setArgsOpen] = useState(false);
  const preview = argPreview(call.input);
  const keyCount = Object.keys(plainRecord(call.input) ?? {}).length;
  const hasInput = call.input !== undefined && call.input !== null;
  const collapseArgs = hasInput && keyCount > 1;
  return (
    <div className={`t-tool${result?.isError ? " t-tool-error" : ""}`}>
      <div className="t-tool-head">
        <span className="t-tool-name">⚙ {call.name}</span>
        {preview ? <span className="t-tool-preview">{preview}</span> : null}
        <ToolStatus result={result} />
      </div>
      {collapseArgs ? (
        <div className="t-tool-args">
          <button type="button" className="t-toggle" onClick={() => setArgsOpen(!argsOpen)}>
            {argsOpen ? "▾" : "▸"} Args ({keyCount})
          </button>
          {argsOpen ? <JsonView value={call.input} collapseDepth={1} /> : null}
        </div>
      ) : null}
      {hasInput && !collapseArgs ? <JsonView value={call.input} collapseDepth={1} /> : null}
      {result ? <ResultBody result={result} /> : null}
    </div>
  );
}

function OrphanResult(props: { result: ToolResultBlock }): ReactNode {
  return (
    <div className={`t-tool${props.result.isError ? " t-tool-error" : ""}`}>
      <div className="t-tool-head">
        <span className="t-tool-name">
          ⚙ Tool Result <span className="dim">{props.result.tool_use_id}</span>
        </span>
        <ToolStatus result={props.result} />
      </div>
      <ResultBody result={props.result} />
    </div>
  );
}

function ClippedText(props: { text: string; clip?: number }): ReactNode {
  const clip = props.clip ?? RESULT_CLIP;
  const [full, setFull] = useState(false);
  const clippable = props.text.length > clip;
  const clipped = !full && clippable;
  return (
    <>
      <pre>{clipped ? `${props.text.slice(0, clip)}…` : props.text}</pre>
      {clippable ? (
        <button type="button" className="t-toggle" onClick={() => setFull(!full)}>
          {full ? "Show Less" : `Show All (${props.text.length.toLocaleString()} chars)`}
        </button>
      ) : null}
    </>
  );
}

function ResultBody(props: { result: ToolResultBlock }): ReactNode {
  const { result } = props;
  if (!result.content) {
    return <div className="t-tool-result dim">(Empty result)</div>;
  }
  return (
    <div className={`t-tool-result${result.isError ? " error" : ""}`}>
      <div className="t-result-head">↳ {result.isError ? "Error" : "Result"}</div>
      <ClippedText text={result.content} clip={result.isError ? ERROR_RESULT_CLIP : RESULT_CLIP} />
    </div>
  );
}

const META_KIND_LABELS: Record<ProviderMetaBlock["kind"], string> = {
  status: "Status",
  structured_output: "Structured Output",
  internal: "Internal",
  helper: "Helper",
  lifecycle: "Lifecycle",
  result: "Result",
  file_change: "File Change",
  parse_error: "Parse Error",
  unknown: "Unknown",
};

function MetaLineView(props: { block: ProviderMetaBlock }): ReactNode {
  const { block } = props;
  const [open, setOpen] = useState(false);
  const dataType = typeof block.data.type === "string" ? block.data.type : "";
  return (
    <div className="t-meta">
      <button type="button" className="t-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} · {META_KIND_LABELS[block.kind]}
        {dataType ? `: ${dataType}` : ""}
      </button>
      {open ? <JsonView value={block.data} collapseDepth={1} /> : null}
    </div>
  );
}

function MetaGroup(props: { lines: MetaLine[] }): ReactNode {
  const [open, setOpen] = useState(false);
  if (props.lines.length === 1) return <MetaLineView block={props.lines[0].block} />;
  return (
    <div className="t-meta-group">
      <button type="button" className="t-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} · {props.lines.length} Internal Events
      </button>
      {open ? props.lines.map((l) => <MetaLineView block={l.block} key={l.key} />) : null}
    </div>
  );
}

/** Raw fallback for rows the parser could not decode (item 15 — nothing dropped). */
function RawRow(props: { cli: string; content: string }): ReactNode {
  return (
    <div className="t-raw">
      <div className="t-raw-head">Unparsed · {props.cli}</div>
      <ClippedText text={props.content} clip={RAW_CLIP} />
    </div>
  );
}

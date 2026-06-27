/**
 * Shared log-line model + renderer (v6 spec §5 — FROZEN contract).
 *
 * ONE path renders the Runner (live + artifact), every Worker <i>, and API log
 * sub-tabs: ANSI strip at render time, structured parses first (runner lines,
 * pino-ish JSON), then leading-timestamp extraction, then severity heuristics.
 * Stored artifacts keep their raw bytes — stripping/parsing is display-only.
 */

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import "./log-lines.css";

export type LogLineLevel = "error" | "warn" | "info" | "banner";

export interface ParsedLogRow {
  /** ISO string when parseable, else null. */
  ts: string | null;
  level: LogLineLevel;
  /** ANSI-stripped, ts prefix removed. */
  text: string;
}

/** ANSI CSI escape sequences (colors, cursor moves) — stripped at render only. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI sequences start with ESC (0x1b) - frozen spec §5 pattern
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, "");
}

/** runner.log line shape (v4 spec §2.2): "ISO [level] line". */
const RUNNER_LINE_RE = /^(\S+) \[(info|warn|error)\] (.*)$/;

/** Leading ISO-8601 timestamp (§4's `<iso>Z <line>` prefix, bracketed or bare). */
const TS_PREFIX_RE =
  /^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s+/;

// Severity heuristics (§5 step 4 — first match wins).
const ERROR_RE = /\b(error|err|fatal|panic|unhandled|exception|traceback)\b/i;
const WARN_RE = /\b(warn|warning|deprecated|retry(ing)?|timed?\s?out)\b/i;
const BANNER_RE = /^[\s=\-_*#~+|│┌┐└┘─]+$/;

function heuristicLevel(text: string): LogLineLevel {
  if (ERROR_RE.test(text) || text.startsWith("✗")) return "error";
  if (WARN_RE.test(text)) return "warn";
  if (BANNER_RE.test(text) || text.startsWith("===") || text.startsWith("--->")) return "banner";
  return "info";
}

/** Pino-ish JSON log line → leveled row; null when the line is not JSON. */
function jsonLogRow(line: string): ParsedLogRow | null {
  if (!line.startsWith("{")) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  let level: LogLineLevel = "info";
  const rawLevel = obj.level;
  if (typeof rawLevel === "number") {
    level = rawLevel >= 50 ? "error" : rawLevel >= 40 ? "warn" : "info";
  } else if (rawLevel === "error" || rawLevel === "fatal") {
    level = "error";
  } else if (rawLevel === "warn" || rawLevel === "warning") {
    level = "warn";
  }
  const time = obj.time ?? obj.ts ?? obj.timestamp;
  const ts =
    typeof time === "number"
      ? new Date(time).toISOString()
      : typeof time === "string"
        ? time
        : null;
  const msg = obj.msg ?? obj.message;
  return { ts, level, text: typeof msg === "string" && msg.length > 0 ? msg : line };
}

/** Per-line pipeline (§5, frozen order): strip → structured → ts extraction → heuristics. */
export function parseLogLine(rawLine: string): ParsedLogRow {
  const line = stripAnsi(rawLine);
  const m = RUNNER_LINE_RE.exec(line);
  if (m) return { ts: m[1], level: m[2] as LogLineLevel, text: m[3] };
  const json = jsonLogRow(line);
  if (json) return json;
  const tsm = TS_PREFIX_RE.exec(line);
  const ts = tsm ? tsm[1] : null;
  const text = tsm ? line.slice(tsm[0].length) : line;
  return { ts, level: heuristicLevel(text), text };
}

/** Whole-artifact text → rows (trailing empty lines dropped). */
export function parseLogText(text: string): ParsedLogRow[] {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map(parseLogLine);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** HH:MM:SS for the timestamp column; "" when absent/unparseable. */
export function fmtLogTs(ts: string | null): string {
  if (ts === null) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// 1-character colored level flags (§5): E (red) / W (amber) / · (dim); banner = none.
const LEVEL_FLAGS: Record<LogLineLevel, string> = {
  error: "E",
  warn: "W",
  info: "·",
  banner: "",
};

const LEVEL_LABELS: Record<LogLineLevel, string> = {
  error: "Error",
  warn: "Warning",
  info: "Info",
  banner: "Banner",
};

/**
 * v7.5 item 3: split `text` on case-insensitive occurrences of `query` and wrap
 * matches in <mark>. Returns the plain string when nothing matches / no query.
 */
function highlightMatches(text: string, query: string): ReactNode {
  const needle = query.toLowerCase();
  if (needle === "") return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  while (from <= text.length) {
    const at = lower.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark className="ll-hl" key={String(at)}>
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  if (parts.length === 0) return text;
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

type CopyState = "idle" | "copied" | "failed";

const COPY_LABELS: Record<CopyState, string> = {
  idle: "Copy all",
  copied: "✓ Copied",
  failed: "Copy failed",
};

/**
 * Scrollable log body. `live` pins auto-scroll to the bottom while new rows
 * stream in — only when the user is already at the bottom.
 *
 * v7.5 item 3 toolbar (every log surface renders through this one component):
 * case-insensitive substring search that filters rows + highlights matches
 * (with a match count), and a "Copy all" button writing the raw log to the
 * clipboard. Log text is plain selectable content — expand/collapse moved to
 * a dedicated per-row toggle so drag-selection is never swallowed.
 */
export function LogLines(props: {
  rows: ParsedLogRow[];
  live?: boolean;
  /**
   * v7.5 item 3: exact source text for the "Copy all" affordance (the stored
   * artifact's raw bytes). Absent/null (e.g. the live runner stream) ⇒ copy
   * falls back to reconstructing the rendered rows.
   */
  rawText?: string | null;
}): ReactNode {
  const { rows, live = false, rawText = null } = props;
  // Timestamp column only renders when ≥1 row in this log has a parseable ts
  // (legacy un-timestamped artifacts stay full-width). Computed on ALL rows so
  // the layout doesn't jump while a search filter is active.
  const hasTs = rows.some((row) => fmtLogTs(row.ts) !== "");

  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () => (needle === "" ? rows : rows.filter((row) => row.text.toLowerCase().includes(needle))),
    [rows, needle],
  );

  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copyTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );
  const flashCopyState = (state: CopyState) => {
    setCopyState(state);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), 1500);
  };
  const copyAll = () => {
    // Raw artifact bytes when available; otherwise reconstruct what's rendered
    // (live stream) — always the FULL log, regardless of the active filter.
    const text =
      rawText !== null && rawText !== ""
        ? rawText
        : rows.map((row) => (row.ts !== null ? `${row.ts} ${row.text}` : row.text)).join("\n");
    navigator.clipboard.writeText(text).then(
      () => flashCopyState("copied"),
      () => flashCopyState("failed"),
    );
  };

  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const onScroll = () => {
    const el = bodyRef.current;
    if (el) pinnedRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  };
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null || !live || visible.length === 0) return;
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [visible, live]);

  return (
    <div className="ll-wrap">
      <div className="ll-toolbar">
        <input
          type="search"
          className="ll-search"
          placeholder="Search log…"
          aria-label="Search log lines (case-insensitive)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {needle !== "" ? (
          <span className="ll-match-count" aria-live="polite">
            {visible.length === 0
              ? "no matches"
              : `${String(visible.length)} of ${String(rows.length)} lines`}
          </span>
        ) : null}
        <button
          type="button"
          className={copyState === "copied" ? "btn ll-copy copied" : "btn ll-copy"}
          onClick={copyAll}
          disabled={rows.length === 0 && (rawText === null || rawText === "")}
          title="Copy the full log to the clipboard"
        >
          {COPY_LABELS[copyState]}
        </button>
      </div>
      <div className="ll-body" ref={bodyRef} onScroll={onScroll}>
        {visible.map((row, i) => (
          <LogLineRow
            row={row}
            hasTs={hasTs}
            highlight={needle}
            key={`${String(i)}:${row.ts ?? ""}`}
          />
        ))}
        {visible.length === 0 && needle !== "" ? (
          <div className="ll-empty">No lines match “{query.trim()}”</div>
        ) : null}
      </div>
    </div>
  );
}

function LogLineRow(props: { row: ParsedLogRow; hasTs: boolean; highlight: string }): ReactNode {
  const { row, hasTs, highlight } = props;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={hasTs ? `ll-row with-ts level-${row.level}` : `ll-row level-${row.level}`}>
      {hasTs ? (
        <span className="ll-ts" title={row.ts ?? undefined}>
          {fmtLogTs(row.ts)}
        </span>
      ) : null}
      <span
        className={`ll-flag level-${row.level}`}
        role="img"
        aria-label={LEVEL_LABELS[row.level]}
      >
        {LEVEL_FLAGS[row.level]}
      </span>
      {/* Plain selectable text (v7.5 item 3) — the old <button> swallowed drag-selection. */}
      <span
        className={expanded ? "ll-msg expanded" : "ll-msg"}
        title={expanded ? undefined : row.text}
      >
        {highlightMatches(row.text, highlight)}
      </span>
      <button
        type="button"
        className={expanded ? "ll-expand expanded" : "ll-expand"}
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "Collapse line" : "Expand line (full text)"}
        aria-label={expanded ? "Collapse line" : "Expand line"}
      >
        {expanded ? "▴" : "▾"}
      </button>
    </div>
  );
}

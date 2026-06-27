import type { ReactNode } from "react";
import { fmtDuration } from "../components/format.ts";
import { Elapsed } from "../components/Spinner.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { useNow } from "../hooks.ts";
import type { PhaseTimingsJson } from "../types.ts";

interface PhaseDef {
  key: Exclude<keyof PhaseTimingsJson, "perTask">;
  label: string;
  color: string;
}

const PHASES: PhaseDef[] = [
  { key: "bootMs", label: "Boot", color: "var(--blue)" },
  { key: "seedMs", label: "Seed", color: "var(--blue)" },
  { key: "tasksMs", label: "Tasks", color: "var(--accent)" },
  { key: "logCaptureMs", label: "Log Capture", color: "var(--dim)" },
  { key: "costMs", label: "Cost Wait", color: "var(--dim)" },
  { key: "checksMs", label: "Checks", color: "var(--green)" },
  { key: "llmJudgeMs", label: "LLM Judge", color: "var(--orange)" },
  { key: "agenticJudgeMs", label: "Agentic Judge", color: "var(--orange)" },
  { key: "artifactsMs", label: "Artifacts", color: "var(--green)" },
];

/** AttemptPhase (progress endpoint) → PhaseTimings key (v4 spec §2.1 mapping). */
const LIVE_PHASE_KEYS: Record<string, PhaseDef["key"]> = {
  boot: "bootMs",
  seed: "seedMs",
  tasks: "tasksMs",
  "log-capture": "logCaptureMs",
  cost: "costMs",
  checks: "checksMs",
  "llm-judge": "llmJudgeMs",
  "agentic-judge": "agenticJudgeMs",
  artifacts: "artifactsMs",
};

interface WfRow {
  key: string;
  label: string;
  ms: number | null;
  startMs: number;
  color: string;
  sub: boolean;
  /** The in-flight phase (live mode) — growing accent bar + ticking duration. */
  live: boolean;
  /** Live mode, not reached yet — renders dim "Pending" instead of "Not measured". */
  pending: boolean;
}

/** Phases laid out sequentially: each bar starts where the previous measured one ended. */
function buildRows(
  timings: PhaseTimingsJson,
  liveKey: PhaseDef["key"] | null,
  liveMs: number,
  liveMode: boolean,
): { rows: WfRow[]; total: number } {
  const rows: WfRow[] = [];
  const liveIdx = liveKey !== null ? PHASES.findIndex((p) => p.key === liveKey) : -1;
  let cursor = 0;
  for (const [idx, phase] of PHASES.entries()) {
    const measured = timings[phase.key] ?? null;
    const isLive = liveKey === phase.key && measured === null;
    const ms = isLive ? liveMs : measured;
    rows.push({
      key: phase.key,
      label: phase.label,
      ms,
      startMs: cursor,
      color: isLive ? "var(--accent)" : phase.color,
      sub: false,
      live: isLive,
      pending: liveMode && ms === null && (liveIdx === -1 || idx > liveIdx),
    });
    if (phase.key === "tasksMs") {
      const perTask = Array.isArray(timings.perTask) ? timings.perTask : [];
      let taskCursor = cursor;
      for (const t of perTask) {
        rows.push({
          key: `task-${t.taskId}`,
          label: `Task ${t.taskId}`,
          ms: t.ms,
          startMs: taskCursor,
          color: phase.color,
          sub: true,
          live: false,
          pending: false,
        });
        taskCursor += t.ms;
      }
    }
    if (ms !== null) cursor += ms;
  }
  return { rows, total: cursor };
}

function fmtPct(ratio: number): string {
  const pct = ratio * 100;
  return pct < 0.1 ? "<0.1%" : `${pct.toFixed(1)}%`;
}

/**
 * Waterfall diagram of attempt phase timings (item 7): one horizontal bar per
 * phase on a shared time axis, offset by cumulative start; hovering highlights
 * the bar and shows name + duration + share of total + start offset.
 *
 * Live mode (v4 item 6): pass `live` while the attempt runs — completed phases
 * come from the progress registry and the current phase renders as a growing
 * accent bar (the bar is the single animated element; Elapsed is ticking text).
 */
export default function Waterfall(props: {
  timings: PhaseTimingsJson;
  totalMs: number | null;
  /** Live mode: the in-flight phase renders as a growing accent bar. */
  live?: { currentPhase: string | null; currentPhaseStartedAt: string | null } | null;
}): ReactNode {
  const live = props.live ?? null;
  const now = useNow(1000);
  const liveKey =
    live !== null && live.currentPhase !== null
      ? (LIVE_PHASE_KEYS[live.currentPhase] ?? null)
      : null;
  const liveStart =
    live !== null && live.currentPhaseStartedAt !== null
      ? Date.parse(live.currentPhaseStartedAt)
      : Number.NaN;
  const liveMs = liveKey !== null && !Number.isNaN(liveStart) ? Math.max(0, now - liveStart) : 0;
  const { rows, total } = buildRows(props.timings, liveKey, liveMs, live !== null);
  // Live mode keeps a minimum 1s axis so bars render from second zero.
  const axis = Math.max(total, props.totalMs ?? 0, live !== null ? 1000 : 0);
  if (axis <= 0) {
    return <div className="dim rd-not-captured">No phase durations recorded</div>;
  }
  return (
    <div className="wf">
      <div className="wf-axis">
        <span>0s</span>
        <span>{fmtDuration(axis)}</span>
      </div>
      {rows.map((row) => (
        <WaterfallRow
          key={row.key}
          row={row}
          axis={axis}
          liveSince={row.live ? (live?.currentPhaseStartedAt ?? null) : null}
        />
      ))}
      <div className="wf-foot dim">
        {live !== null
          ? `Live · Measured so far: ${fmtDuration(total)}`
          : `Measured phases: ${fmtDuration(total)}${
              props.totalMs !== null ? ` · Attempt duration: ${fmtDuration(props.totalMs)}` : ""
            }`}
      </div>
    </div>
  );
}

function WaterfallRow(props: { row: WfRow; axis: number; liveSince: string | null }): ReactNode {
  const { row, axis } = props;
  const rowClass = [row.sub ? "wf-row sub" : "wf-row", row.live ? "live" : ""]
    .filter(Boolean)
    .join(" ");
  if (row.ms === null) {
    return (
      <div className={rowClass}>
        <div className="wf-label" title={row.label}>
          {row.label}
        </div>
        <div className="wf-na">{row.pending ? "Pending" : "Not measured"}</div>
        <div className="wf-dur">—</div>
      </div>
    );
  }
  const left = Math.min((row.startMs / axis) * 100, 99);
  const width = Math.min((row.ms / axis) * 100, 100 - left);
  const tip = row.live
    ? [
        row.label,
        `Running — ${fmtDuration(row.ms)} elapsed`,
        `Starts at +${fmtDuration(row.startMs)}`,
      ].join("\n")
    : [
        row.label,
        `${fmtDuration(row.ms)} · ${fmtPct(row.ms / axis)} of total`,
        `Starts at +${fmtDuration(row.startMs)}`,
      ].join("\n");
  return (
    <div className={rowClass}>
      <div className="wf-label" title={row.label}>
        {row.label}
      </div>
      <Tooltip text={tip}>
        <span className="wf-track">
          <span
            className={row.live ? "wf-bar pulse" : "wf-bar"}
            style={{ left: `${left}%`, width: `${width}%`, background: row.color }}
          />
        </span>
      </Tooltip>
      <div className="wf-dur">
        {row.live ? <Elapsed since={props.liveSince} /> : fmtDuration(row.ms)}
      </div>
    </div>
  );
}

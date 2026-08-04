import { Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import type { SubagentRun } from "@/logs-parser";

const AGENT_TONES = [
  { dot: "bg-action-agent-task", bar: "bg-action-agent-task/15 text-action-agent-task" },
  { dot: "bg-action-script", bar: "bg-action-script/15 text-action-script" },
  { dot: "bg-action-notify", bar: "bg-action-notify/15 text-action-notify" },
] as const;

function toneFor(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return AGENT_TONES[Math.abs(hash) % AGENT_TONES.length] ?? AGENT_TONES[0];
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
}

function formatClock(iso?: string): string {
  if (!iso) return "now";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "now";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function SubagentDot({ run }: { run: SubagentRun }) {
  return (
    <span className="relative grid size-4 shrink-0 place-items-center" aria-hidden="true">
      <span className={cn("size-2 rounded-full", toneFor(run.id).dot)} />
    </span>
  );
}

export function SubagentStatus({ run }: { run: SubagentRun }) {
  const completed = run.status === "completed";
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-[10px]",
        run.status === "running" && "text-status-active-strong",
        completed && "text-status-success-strong",
        run.status === "failed" && "text-status-error-strong",
      )}
    >
      {completed && <Check className="mr-1 inline size-2.5" />}
      {run.status}
    </span>
  );
}

export function SubagentDetailField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1 sm:grid-cols-[72px_minmax(0,1fr)] sm:gap-4">
      <dt className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </dt>
      <dd className="m-0 whitespace-pre-wrap break-words text-[11.5px] leading-[1.6] text-foreground/85">
        {children}
      </dd>
    </div>
  );
}

export function SubagentDetails({ run }: { run: SubagentRun }) {
  return (
    <dl className="grid content-start gap-2">
      <SubagentDetailField label="Input">{run.input || "No input recorded."}</SubagentDetailField>
      <SubagentDetailField label="Outcome">
        {run.outcome ||
          (run.status === "running"
            ? "Running now. The outcome appears here when the harness returns."
            : "No outcome recorded.")}
      </SubagentDetailField>
    </dl>
  );
}

function AgentLabel({
  run,
  selected,
  onSelect,
}: {
  run: SubagentRun;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex h-11 w-full min-w-0 cursor-pointer items-center gap-2 border-b border-border/40 pr-3 text-left transition-colors hover:bg-muted/30",
        selected && "bg-muted/25",
      )}
    >
      <SubagentDot run={run} />
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium">{run.label}</span>
        <span className="block truncate font-mono text-[9.5px] text-muted-foreground">
          {run.agentType}
        </span>
      </span>
    </button>
  );
}

function TimelineLane({
  run,
  selected,
  windowStart,
  windowMs,
  now,
  onSelect,
}: {
  run: SubagentRun;
  selected: boolean;
  windowStart: number;
  windowMs: number;
  now: number;
  onSelect: () => void;
}) {
  const start = Date.parse(run.startedAt);
  const finish = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const left = windowMs > 0 ? ((start - windowStart) / windowMs) * 100 : 0;
  const width =
    windowMs > 0 ? Math.max(((Math.max(finish, start) - start) / windowMs) * 100, 1.25) : 1.25;
  const tone = toneFor(run.id);
  const duration = Math.max(0, finish - start);
  const clampedLeft = Math.min(100, Math.max(0, left));
  const clampedWidth = Math.min(Math.max(width, 1.25), Math.max(1.25, 100 - clampedLeft));

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`${run.label}, ${run.status}, ${formatDuration(duration)}, ended ${formatClock(run.finishedAt)}`}
      aria-pressed={selected}
      className={cn(
        "grid h-11 w-full cursor-pointer grid-cols-[minmax(0,1fr)_84px] items-center gap-4 border-b border-border/40 pr-6 text-left transition-colors hover:bg-muted/30",
        selected && "bg-muted/25",
      )}
    >
      <span className="relative h-7 bg-[linear-gradient(to_right,var(--color-border)_1px,transparent_1px)] bg-[size:25%_100%]">
        <span
          className={cn(
            "absolute top-1/2 flex h-4 -translate-y-1/2 items-center rounded-sm px-2",
            tone.bar,
          )}
          style={{
            left: `${clampedLeft}%`,
            width: `${clampedWidth}%`,
          }}
        >
          <span className="truncate font-mono text-[9px] font-bold">
            {formatDuration(duration)}
          </span>
          {run.status === "running" && (
            <span className="ml-auto size-1.5 shrink-0 rounded-full bg-status-active" />
          )}
        </span>
      </span>
      <span className="text-right font-mono text-[9.5px] tabular-nums text-muted-foreground">
        {formatClock(run.finishedAt)}
      </span>
    </button>
  );
}

export function SubagentWaterfall({ runs }: { runs: SubagentRun[] }) {
  const [selectedId, setSelectedId] = useState(runs[0]?.id ?? "");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!runs.some((run) => run.id === selectedId)) setSelectedId(runs[0]?.id ?? "");
  }, [runs, selectedId]);
  useEffect(() => {
    if (!runs.some((run) => run.status === "running")) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runs]);

  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const { windowStart, windowMs } = useMemo(() => {
    const starts = runs.map((run) => Date.parse(run.startedAt)).filter(Number.isFinite);
    const ends = runs
      .map((run) => (run.finishedAt ? Date.parse(run.finishedAt) : now))
      .filter(Number.isFinite);
    const start = starts.length > 0 ? Math.min(...starts) : now;
    const end = ends.length > 0 ? Math.max(...ends, start + 1000) : start + 1000;
    return { windowStart: start, windowMs: Math.max(1000, end - start) };
  }, [runs, now]);

  if (!selected) return null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3">
      <div className="flex items-center border-b border-border/60 py-2 text-[10px] text-muted-foreground">
        <span className="font-mono uppercase tracking-[0.1em]">Agent waterfall</span>
        <span className="ml-3 font-mono">{formatDuration(windowMs)} live window</span>
        <span className="ml-auto font-mono">
          {runs.filter((run) => run.status === "running").length} running
        </span>
      </div>

      <div className="flex min-w-0 border-b border-border/60">
        <div className="w-[146px] shrink-0 sm:w-[190px]">
          <div className="flex h-8 items-center border-b border-border/40 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
            Agent
          </div>
          {runs.map((run) => (
            <AgentLabel
              key={run.id}
              run={run}
              selected={run.id === selected.id}
              onSelect={() => setSelectedId(run.id)}
            />
          ))}
        </div>

        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="min-w-[620px]">
            <div className="grid h-8 grid-cols-[minmax(0,1fr)_84px] items-center gap-4 border-b border-border/40 pr-6 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
              <span className="relative grid grid-cols-3 tabular-nums">
                <span>0s</span>
                <span className="text-center">{formatDuration(windowMs / 2)}</span>
                <span className="text-right">{formatDuration(windowMs)}</span>
              </span>
              <span className="text-right">End</span>
            </div>
            {runs.map((run) => (
              <TimelineLane
                key={run.id}
                run={run}
                selected={run.id === selected.id}
                windowStart={windowStart}
                windowMs={windowMs}
                now={now}
                onSelect={() => setSelectedId(run.id)}
              />
            ))}
          </div>
        </div>
      </div>

      <section className="grid gap-3 border-b border-border/40 py-3 sm:grid-cols-[190px_minmax(0,1fr)] sm:gap-4">
        <div className="flex min-w-0 items-start gap-2">
          <SubagentDot run={selected} />
          <div className="min-w-0">
            <h3 className="truncate text-xs font-medium">{selected.label}</h3>
            <p className="mt-0.5 truncate font-mono text-[9.5px] text-muted-foreground">
              {selected.agentType}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-2">
              <SubagentStatus run={selected} />
              <span className="font-mono text-[9.5px] text-muted-foreground">
                {formatClock(selected.startedAt)} → {formatClock(selected.finishedAt)}
              </span>
            </p>
          </div>
        </div>
        <SubagentDetails run={selected} />
      </section>
    </div>
  );
}

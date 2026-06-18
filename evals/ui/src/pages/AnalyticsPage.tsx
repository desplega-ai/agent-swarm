import { type ReactNode, useCallback, useMemo, useState } from "react";
import { getAnalytics } from "../api.ts";
import { ConfigChip } from "../components/ConfigChip.tsx";
import { BarChart, type BarGroup } from "../components/charts/BarChart.tsx";
import { colorForGroup, HARNESS_COLORS, VENDOR_COLORS } from "../components/charts/chart-utils.ts";
import { type HeatCellData, HeatTable } from "../components/charts/HeatTable.tsx";
import { type ChartMarker, LineChart, type LineSeries } from "../components/charts/LineChart.tsx";
import { type MiniBar, MiniBarChart } from "../components/charts/MiniBarChart.tsx";
import { ScatterChart, type ScatterPoint } from "../components/charts/ScatterChart.tsx";
import { type Column, DataTable, MultiSelect } from "../components/DataTable.tsx";
import { EntityLink } from "../components/EntityLink.tsx";
import {
  fmtAgo,
  fmtCost,
  fmtDate,
  fmtDuration,
  fmtScore,
  fmtTokens,
} from "../components/format.ts";
import { HarnessIcon } from "../components/HarnessIcon.tsx";
import { ModelChip } from "../components/ModelChip.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { InfoTip } from "../components/Tooltip.tsx";
import { useConfigs, useModels, usePoll } from "../hooks.ts";
import type {
  AnalyticsCell,
  AnalyticsFilterOptions,
  AnalyticsGroupRollup,
  AnalyticsModel,
  AnalyticsResponse,
  AnalyticsScatterPoint,
  AnalyticsSeries,
  AnalyticsSeriesPoint,
  AnalyticsTokenSums,
} from "../types.ts";
import "./analytics.css";

/** Pass-rate format (v5 spec §3): 0.875 → "88%". */
function fmtPct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Axis-tick-friendly cost: "$0.14" / "$0.0021" (trailing zeros trimmed — fits the 46px gutter). */
function fmtCostTick(v: number): string {
  return `$${Number(v.toFixed(4))}`;
}

/** Hover-title breakdown of a token sum (v7 §11): in/out/cacheR/cacheW. */
function tokensTitle(t: AnalyticsTokenSums): string {
  return (
    `in ${fmtTokens(t.inputTokens)} · out ${fmtTokens(t.outputTokens)} · ` +
    `cacheR ${fmtTokens(t.cacheReadTokens)} · cacheW ${fmtTokens(t.cacheWriteTokens)} · ` +
    `over ${t.tokenAttempts} token-bearing attempts`
  );
}

/**
 * MultiSelect search haystack for a config option (round 9 item 3): the raw id
 * plus the same pretty name ConfigChip renders (resolved model name → config
 * label → raw model), so typing a model name matches the pretty chip.
 */
function useConfigSearchText(): (id: string) => string {
  const { byId } = useConfigs();
  const { resolve } = useModels();
  return useCallback(
    (id: string) => {
      const config = byId(id);
      if (config === null) return id;
      const name =
        config.model === null
          ? (config.label ?? "Default Model")
          : (resolve(config.model)?.name ?? config.label ?? config.model);
      return `${id} ${name}`;
    },
    [byId, resolve],
  );
}

// ---- metric definitions (the InfoTip carries each metric's formula) ----

interface MetricDef<T> {
  label: string;
  tip: string;
  value: (row: T) => number | null;
  format: (v: number) => string;
}

type TrendMetricKey = "score" | "passRate" | "cost" | "duration";

const TREND_ORDER: TrendMetricKey[] = ["score", "passRate", "cost", "duration"];

const TREND_METRICS: Record<TrendMetricKey, MetricDef<AnalyticsSeriesPoint>> = {
  score: {
    label: "Score",
    tip: "Mean judge score (0–1) over the run's attempts that have a score. Runs without a score become line gaps, never zeros.",
    value: (p) => p.avgScore,
    format: (v) => fmtScore(v),
  },
  passRate: {
    label: "Pass Rate",
    tip: "Passed ÷ graded attempts (passed + failed) per run. Errors are infra failures — they never lower the rate.",
    value: (p) => p.passRate,
    format: fmtPct,
  },
  cost: {
    label: "Task Cost",
    tip: "Mean task cost per priced attempt in the run. Judge LLM cost is harness overhead and excluded.",
    value: (p) => p.avgCostUsd,
    format: fmtCostTick,
  },
  duration: {
    label: "Duration",
    tip: "Mean attempt duration per run, over attempts that captured a duration.",
    value: (p) => p.avgDurationMs,
    format: (v) => fmtDuration(v),
  },
};

type HeatMetricKey = "avg" | "total" | "judge" | "min" | "max";

const HEAT_ORDER: HeatMetricKey[] = ["avg", "total", "judge", "min", "max"];

const HEAT_METRICS: Record<HeatMetricKey, MetricDef<AnalyticsCell>> = {
  avg: {
    label: "Avg Cost",
    tip: "Σ task cost ÷ priced attempts in the cell, across all runs (judge cost excluded).",
    value: (c) => c.avgCostUsd,
    format: (v) => fmtCost(v),
  },
  total: {
    label: "Total Cost",
    tip: "Σ task cost over the cell's priced attempts, across all runs.",
    value: (c) => c.totalCostUsd,
    format: (v) => fmtCost(v),
  },
  judge: {
    label: "Judge Cost",
    tip: "Mean judge LLM cost per attempt — harness overhead, never included in task cost.",
    value: (c) => c.avgJudgeCostUsd,
    format: (v) => fmtCost(v),
  },
  min: {
    label: "Min Cost",
    tip: "Cheapest priced attempt in the cell, across all runs (v7 §6).",
    value: (c) => c.minCostUsd ?? null,
    format: (v) => fmtCost(v),
  },
  max: {
    label: "Max Cost",
    tip: "Most expensive priced attempt in the cell, across all runs (v7 §6).",
    value: (c) => c.maxCostUsd ?? null,
    format: (v) => fmtCost(v),
  },
};

type ModelMetricKey = "attempt" | "run" | "minute" | "duration" | "accuracy";

const MODEL_ORDER: ModelMetricKey[] = ["attempt", "run", "minute", "duration", "accuracy"];

const MODEL_METRICS: Record<ModelMetricKey, MetricDef<AnalyticsModel>> = {
  attempt: {
    label: "$ / Attempt",
    tip: "Σ task cost ÷ priced attempts.",
    value: (m) => m.avgCostPerAttempt,
    format: (v) => fmtCost(v),
  },
  run: {
    label: "$ / Run",
    tip: "Σ task cost ÷ distinct runs with ≥ 1 priced attempt.",
    value: (m) => m.avgCostPerRun,
    format: (v) => fmtCost(v),
  },
  minute: {
    label: "$ / Minute",
    tip: "Σ task cost ÷ minutes of agent work, over attempts carrying both a cost and a duration.",
    value: (m) => m.costPerMinute,
    format: (v) => fmtCost(v),
  },
  duration: {
    label: "Duration",
    tip: "Mean attempt duration over attempts with a duration — lower is better (chart sorts fastest first).",
    value: (m) => m.avgDurationMs,
    format: (v) => fmtDuration(v),
  },
  accuracy: {
    label: "Accuracy",
    tip: "Mean judge score over attempts with a score — higher is better.",
    value: (m) => m.avgScore,
    format: (v) => fmtScore(v),
  },
};

// ---- small page-local building blocks ----

/** Segmented metric control (pill group). */
function Seg<K extends string>(props: {
  options: readonly { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
}): ReactNode {
  return (
    <div className="an-seg">
      {props.options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={o.key === props.value ? "active" : undefined}
          onClick={() => props.onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Panel header: question-shaped title + right-aligned controls. */
function SectionHead(props: { title: string; tip: string; children?: ReactNode }): ReactNode {
  return (
    <div className="an-panel-head">
      <h3 className="panel-title">
        {props.title} <InfoTip text={props.tip} />
      </h3>
      {props.children !== undefined ? <div className="an-controls">{props.children}</div> : null}
    </div>
  );
}

function TipRow(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="tip-card-row">
      <span className="tip-card-label">{props.label}</span>
      <span className="tip-card-value">{props.children}</span>
    </div>
  );
}

// ---- section 0: Highlights — three at-a-glance per-model cards (v7 §7.3) ----

interface HighlightDef {
  key: string;
  title: string;
  sub: string;
  tip: string;
  value: (m: AnalyticsModel) => number | null;
  format: (v: number) => string;
  /** Bar order: best first ("asc" when lower is better). */
  dir: "asc" | "desc";
}

const HIGHLIGHT_CARDS: HighlightDef[] = [
  {
    key: "accuracy",
    title: "Accuracy",
    sub: "avg judge score · higher is better",
    tip: "Mean judge score per model, across every graded attempt of every run. Top 8 models by attempts; bar color = model vendor.",
    value: (m) => m.avgScore,
    format: (v) => fmtScore(v),
    dir: "desc",
  },
  {
    key: "speed",
    title: "Speed",
    sub: "avg attempt duration · lower is better",
    tip: "Mean attempt duration per model, over attempts that captured a duration. Top 8 models by attempts; bar color = model vendor.",
    value: (m) => m.avgDurationMs,
    format: (v) => fmtDuration(v),
    dir: "asc",
  },
  {
    key: "price",
    title: "Price",
    sub: "avg cost per attempt · lower is better",
    tip: "Σ task cost ÷ priced attempts per model (judge cost excluded). Top 8 models by attempts; bar color = model vendor.",
    value: (m) => m.avgCostPerAttempt,
    format: (v) => fmtCost(v),
    dir: "asc",
  },
];

const HIGHLIGHT_MODEL_CAP = 8;

function HighlightCard(props: {
  def: HighlightDef;
  models: AnalyticsModel[];
  resolve: (id: string | null) => { name: string } | null;
}): ReactNode {
  const { def, models, resolve } = props;
  // `attempts` rides along for the round-9 bar hover tooltip (item 5).
  const bars = useMemo<MiniBar[]>(() => {
    const dir = def.dir === "asc" ? 1 : -1;
    return [...models]
      .sort((a, b) => b.attempts - a.attempts)
      .map((m) => ({ m, v: def.value(m) }))
      .filter((e): e is { m: AnalyticsModel; v: number } => e.v !== null)
      .slice(0, HIGHLIGHT_MODEL_CAP)
      .sort((a, b) => dir * (a.v - b.v))
      .map(({ m, v }) => ({
        key: m.model,
        label: resolve(m.model)?.name ?? m.model,
        value: v,
        color: colorForGroup(m.vendor ?? "(unknown)", VENDOR_COLORS),
        attempts: m.attempts,
      }));
  }, [def, models, resolve]);

  return (
    <div className="panel an-highlight">
      <div className="an-highlight-title">
        {def.title} <InfoTip text={def.tip} />
      </div>
      <div className="an-highlight-sub dim">{def.sub}</div>
      <MiniBarChart bars={bars} format={def.format} emptyText="No data yet" />
    </div>
  );
}

function HighlightsSection(props: { models: AnalyticsModel[] }): ReactNode {
  const { resolve } = useModels();
  return (
    <div className="an-highlights">
      {HIGHLIGHT_CARDS.map((def) => (
        <HighlightCard key={def.key} def={def} models={props.models} resolve={resolve} />
      ))}
    </div>
  );
}

// ---- section 1: Trends — "Is the swarm improving over time?" ----

function bestOf(list: AnalyticsSeries[]): AnalyticsSeries | null {
  return list.reduce<AnalyticsSeries | null>(
    (acc, s) => (acc === null || s.points.length > acc.points.length ? s : acc),
    null,
  );
}

/** Overlay cap (v7 §6.2 — frozen): excess pairs dropped in series-size order. */
const SERIES_CAP = 8;

function TrendsSection(props: { series: AnalyticsSeries[] }): ReactNode {
  const { series } = props;
  const configSearchText = useConfigSearchText();
  // null = uninitialized → default to the single best (scenario, config) pair.
  const [pickedScenarios, setPickedScenarios] = useState<string[] | null>(null);
  const [pickedConfigs, setPickedConfigs] = useState<string[] | null>(null);
  const [metricKey, setMetricKey] = useState<TrendMetricKey>("score");
  const metric = TREND_METRICS[metricKey];

  const scenarioOptions = useMemo(
    () => [...new Set(series.map((s) => s.scenarioId))].sort(),
    [series],
  );
  const configOptions = useMemo(() => [...new Set(series.map((s) => s.configId))].sort(), [series]);

  const best = useMemo(() => bestOf(series), [series]);
  const scenSel = pickedScenarios ?? (best !== null ? [best.scenarioId] : []);
  const cfgSel = pickedConfigs ?? (best !== null ? [best.configId] : []);

  // Plotted series = the cartesian product of the selections that has a series
  // (empty selection = no filter), capped at SERIES_CAP, largest series kept.
  const matched = series.filter(
    (s) =>
      (scenSel.length === 0 || scenSel.includes(s.scenarioId)) &&
      (cfgSel.length === 0 || cfgSel.includes(s.configId)),
  );
  const plotted = [...matched]
    .sort((a, b) => b.points.length - a.points.length)
    .slice(0, SERIES_CAP);

  // plotted is derived fresh each render and the mapping is trivial — no memo.
  const chartSeries: LineSeries[] = plotted.map((s) => ({
    id: `${s.scenarioId}|${s.configId}`,
    name: `${s.scenarioId} × ${s.configId}`,
    points: s.points
      .map((p) => ({ x: Date.parse(p.createdAt), y: metric.value(p) }))
      .filter((p) => Number.isFinite(p.x)),
  }));

  // Version markers are per-series — rendered only when exactly 1 series plots.
  const single = plotted.length === 1 ? (plotted[0] ?? null) : null;
  const markers: ChartMarker[] =
    single === null
      ? []
      : single.versionEvents
          .map((ev) => ({
            x: Date.parse(ev.createdAt),
            label: `${ev.kind === "api" ? "api" : "w"} ${ev.to}`,
            color: ev.kind === "api" ? "var(--blue)" : "var(--orange)",
          }))
          .filter((m) => Number.isFinite(m.x));

  const runsPlotted = plotted.reduce((acc, s) => acc + s.points.length, 0);

  return (
    <div className="panel">
      <SectionHead
        title="Improving Over Time?"
        tip="One point per run for each selected scenario × config pair — pick several to overlay them. Dashed vertical lines mark API / worker version changes captured at sandbox boot (shown when a single series is plotted)."
      >
        {series.length > 0 ? (
          <>
            <MultiSelect
              label="Scenario"
              options={scenarioOptions}
              selected={scenSel}
              onChange={setPickedScenarios}
              renderOption={(o) => <span className="an-opt-id">{o}</span>}
            />
            <MultiSelect
              label="Config"
              options={configOptions}
              selected={cfgSel}
              onChange={setPickedConfigs}
              renderOption={(o) => <ConfigChip configId={o} />}
              searchText={configSearchText}
            />
            <Seg
              options={TREND_ORDER.map((k) => ({ key: k, label: TREND_METRICS[k].label }))}
              value={metricKey}
              onChange={setMetricKey}
            />
            <InfoTip text={metric.tip} />
          </>
        ) : null}
      </SectionHead>
      {series.length === 0 ? (
        <div className="chart-empty">Not enough data yet — finished eval runs will chart here</div>
      ) : (
        <>
          <LineChart
            series={chartSeries}
            markers={markers}
            height={240}
            yFormat={metric.format}
            emptyText={
              matched.length === 0
                ? "No series match the selection"
                : `No ${metric.label} data for this selection yet`
            }
          />
          <div className="an-foot">
            <span className="dim">
              {runsPlotted} {runsPlotted === 1 ? "run" : "runs"} across {plotted.length}{" "}
              {plotted.length === 1 ? "series" : "series"}
            </span>
            {matched.length > plotted.length ? (
              <span className="dim">
                showing {plotted.length} of {matched.length} series
              </span>
            ) : null}
            {single !== null ? (
              single.versionEvents.length > 0 ? (
                single.versionEvents.map((ev) => (
                  <span
                    className="an-event"
                    key={`${ev.kind}-${ev.runId}-${ev.to}`}
                    title={ev.createdAt}
                  >
                    <span className={`an-event-kind ${ev.kind}`}>
                      {ev.kind === "api" ? "API" : "Worker"}
                    </span>
                    <span className="an-event-change">
                      {ev.from !== null ? `${ev.from} → ${ev.to}` : ev.to}
                    </span>
                    <EntityLink kind="run" id={ev.runId} />
                    <span className="dim">{fmtDate(ev.createdAt)}</span>
                  </span>
                ))
              ) : (
                <span className="dim">No version changes captured in this series</span>
              )
            ) : plotted.length > 1 ? (
              <span className="dim">Version markers appear when a single series is plotted</span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

// ---- section 2: Efficiency — score vs tokens scatter (v7 §7.3, screenshot 6;
// round-8 §C4: X selector Tokens|Price|Time, worst quadrant; y-axis pinned to
// the constant [0,1] domain so the quadrant bands anchor to the true scale) ----

type ScatterYKey = "score" | "passRate";
type ScatterXKey = "tokens" | "price" | "duration";
type ColorByKey = "harness" | "vendor";

const SCATTER_Y: Record<
  ScatterYKey,
  {
    label: string;
    value: (p: AnalyticsScatterPoint) => number | null;
    format: (v: number) => string;
  }
> = {
  score: { label: "Avg Score", value: (p) => p.avgScore, format: (v) => fmtScore(v) },
  passRate: { label: "Pass Rate", value: (p) => p.passRate, format: fmtPct },
};

/** X-axis options (round-8 spec §C4 — FROZEN keys). All lower-is-better, so the
 * attractive quadrant stays x:"low" / y:"high" for every axis. */
const SCATTER_X: Record<
  ScatterXKey,
  {
    /** Seg + section-title label. */
    label: string;
    axisLabel: string;
    value: (p: AnalyticsScatterPoint) => number | null;
    format: (v: number) => string;
  }
> = {
  tokens: {
    label: "Tokens",
    axisLabel: "Avg total tokens per attempt",
    value: (p) => p.avgTotalTokens,
    format: (v) => fmtTokens(Math.round(v)),
  },
  price: {
    label: "Price",
    axisLabel: "Avg cost per attempt",
    value: (p) => p.avgCostUsd,
    format: (v) => fmtCost(v),
  },
  duration: {
    label: "Time",
    axisLabel: "Avg duration per attempt",
    value: (p) => p.avgDurationMs,
    format: (v) => fmtDuration(v),
  },
};

const SCATTER_LABEL_CAP = 14;

function EfficiencySection(props: { scatter: AnalyticsScatterPoint[] }): ReactNode {
  const [yKey, setYKey] = useState<ScatterYKey>("score");
  const [xKey, setXKey] = useState<ScatterXKey>("tokens");
  const [colorBy, setColorBy] = useState<ColorByKey>("vendor");
  const { resolve } = useModels();
  const yDef = SCATTER_Y[yKey];
  const xDef = SCATTER_X[xKey];

  const points = useMemo<ScatterPoint[]>(
    () =>
      props.scatter.flatMap((p) => {
        const y = yDef.value(p);
        const x = xDef.value(p);
        if (x === null || y === null) return [];
        const group = colorBy === "harness" ? (p.harnesses[0] ?? "(unknown)") : p.vendor;
        const color = colorForGroup(group, colorBy === "harness" ? HARNESS_COLORS : VENDOR_COLORS);
        const label = resolve(p.model)?.name ?? p.model;
        return [
          {
            key: p.model,
            label,
            x,
            y,
            color,
            group,
            r: 4 + Math.min(4, Math.sqrt(p.attempts)),
            tip: (
              <>
                <div className="chart-tip-title">{label}</div>
                <div className="chart-tip-row">
                  <span>Avg Score</span>
                  <span className="chart-tip-value">{fmtScore(p.avgScore)}</span>
                </div>
                <div className="chart-tip-row">
                  <span>Pass Rate</span>
                  <span className="chart-tip-value">
                    {p.passRate !== null ? fmtPct(p.passRate) : "—"}
                  </span>
                </div>
                <div className="chart-tip-row">
                  <span>Avg Tokens</span>
                  <span className="chart-tip-value">{fmtTokens(p.avgTotalTokens)}</span>
                </div>
                <div className="chart-tip-row">
                  <span>Avg Cost</span>
                  <span className="chart-tip-value">{fmtCost(p.avgCostUsd)}</span>
                </div>
                <div className="chart-tip-row">
                  <span>Avg Duration</span>
                  <span className="chart-tip-value">{fmtDuration(p.avgDurationMs)}</span>
                </div>
                <div className="chart-tip-row">
                  <span>Attempts</span>
                  <span className="chart-tip-value">{p.attempts}</span>
                </div>
              </>
            ),
          },
        ];
      }),
    [props.scatter, yDef, xDef, colorBy, resolve],
  );

  return (
    <div className="panel">
      <SectionHead
        title={`Efficiency — ${yKey === "score" ? "Score" : "Pass Rate"} vs ${xDef.label}`}
        tip="One dot per model: quality on the y axis against the selected spend metric (avg tokens, cost, or duration per attempt) on the x axis — lower is always better on x. Dot size scales with attempts. The green corner is the most attractive quadrant (high quality, low spend) and the red corner the least attractive; the y axis is pinned to the full 0–1 range (Score 0.00–1.00, Pass Rate 0–100%) so the quadrants stay correct and comparable across runs, while the x axis auto-scales to the data."
      >
        <span className="an-seg-label dim">X</span>
        <Seg
          options={[
            { key: "tokens" as const, label: "Tokens" },
            { key: "price" as const, label: "Price" },
            { key: "duration" as const, label: "Time" },
          ]}
          value={xKey}
          onChange={setXKey}
        />
        <span className="an-seg-label dim">Y</span>
        <Seg
          options={[
            { key: "score" as const, label: "Score" },
            { key: "passRate" as const, label: "Pass Rate" },
          ]}
          value={yKey}
          onChange={setYKey}
        />
        <span className="an-seg-label dim">Color</span>
        <Seg
          options={[
            { key: "harness" as const, label: "Harness" },
            { key: "vendor" as const, label: "Vendor" },
          ]}
          value={colorBy}
          onChange={setColorBy}
        />
      </SectionHead>
      <ScatterChart
        points={points}
        height={300}
        xLabel={xDef.axisLabel}
        yLabel={yDef.label}
        xFormat={xDef.format}
        yFormat={yDef.format}
        quadrant={{ x: "low", y: "high", label: "most attractive quadrant", worst: true }}
        // Both Score and Pass Rate are 0–1 proportions, so pin the y-axis to a
        // constant [0,1] domain — the quadrant bands then anchor to the true
        // scale (top band = high quality on the real axis, not the plotted
        // range) and the chart stays comparable across runs. Score renders as
        // fixed-decimal ticks (fmtScore), Pass Rate as 0–100% (fmtPct).
        yDomain={[0, 1]}
        showLabels={points.length <= SCATTER_LABEL_CAP}
        emptyText="No graded attempts with this metric yet — v7 runs capture tokens for every attempt"
      />
    </div>
  );
}

// ---- section 3: Cost Matrix — "What is the cost of running it in special tasks?" ----

function CellTip(props: { cell: AnalyticsCell }): ReactNode {
  const c = props.cell;
  return (
    <div className="tip-card">
      <div className="tip-card-title">
        {c.scenarioId} × {c.configId}
      </div>
      <TipRow label="Attempts">
        {c.attempts}
        {c.errors > 0 ? <span className="dim"> · {c.errors} errors</span> : null}
      </TipRow>
      <TipRow label="Graded">
        {c.graded} ({c.passed} passed)
      </TipRow>
      <TipRow label="Pass Rate">{c.passRate !== null ? fmtPct(c.passRate) : "—"}</TipRow>
      <TipRow label="Priced">
        {c.pricedAttempts} / {c.attempts}
      </TipRow>
      <TipRow label="Avg Cost">{fmtCost(c.avgCostUsd)}</TipRow>
      <TipRow label="Min Cost">{fmtCost(c.minCostUsd ?? null)}</TipRow>
      <TipRow label="Max Cost">{fmtCost(c.maxCostUsd ?? null)}</TipRow>
      <TipRow label="Total Cost">{fmtCost(c.totalCostUsd)}</TipRow>
      <TipRow label="Judge Cost">
        {c.totalJudgeCostUsd !== null ? (
          <>
            {fmtCost(c.totalJudgeCostUsd)} <span className="dim">·</span>{" "}
            {fmtCost(c.avgJudgeCostUsd)} / attempt
          </>
        ) : (
          "—"
        )}
      </TipRow>
      <TipRow label="Avg Score">{fmtScore(c.avgScore)}</TipRow>
      <TipRow label="Avg Duration">{fmtDuration(c.avgDurationMs)}</TipRow>
      <TipRow label="Tokens">
        {c.tokens != null ? (
          <span title={tokensTitle(c.tokens)}>{fmtTokens(c.tokens.totalTokens)}</span>
        ) : (
          "—"
        )}
      </TipRow>
      <TipRow label="Last Run">{fmtAgo(c.lastRunAt)}</TipRow>
    </div>
  );
}

function CostSection(props: { data: AnalyticsResponse }): ReactNode {
  const { data } = props;
  const [metricKey, setMetricKey] = useState<HeatMetricKey>("avg");
  const metric = HEAT_METRICS[metricKey];

  const cellMap = useMemo(
    () => new Map(data.matrix.map((c) => [`${c.scenarioId}\u0000${c.configId}`, c])),
    [data.matrix],
  );
  const rows = useMemo(
    () =>
      data.scenarioIds.map((id) => ({
        key: id,
        label: <EntityLink kind="scenario" id={id} />,
      })),
    [data.scenarioIds],
  );
  const cols = useMemo(
    () =>
      data.configIds.map((id) => ({
        key: id,
        label: <ConfigChip configId={id} link />,
      })),
    [data.configIds],
  );
  const cell = useCallback(
    (rowKey: string, colKey: string): HeatCellData | null => {
      const c = cellMap.get(`${rowKey}\u0000${colKey}`);
      if (!c) return null;
      const v = metric.value(c);
      return {
        value: v,
        display: v !== null ? metric.format(v) : <span className="dim">—</span>,
        tip: <CellTip cell={c} />,
      };
    },
    [cellMap, metric],
  );

  const totals = useMemo(() => {
    let attempts = 0;
    let priced = 0;
    let cost: number | null = null;
    let judgeCost: number | null = null;
    for (const c of data.matrix) {
      attempts += c.attempts;
      priced += c.pricedAttempts;
      if (c.totalCostUsd !== null) cost = (cost ?? 0) + c.totalCostUsd;
      if (c.totalJudgeCostUsd !== null) judgeCost = (judgeCost ?? 0) + c.totalJudgeCostUsd;
    }
    return { attempts, priced, cost, judgeCost };
  }, [data.matrix]);

  return (
    <div className="panel">
      <SectionHead
        title="What Does It Cost?"
        tip="Cost per scenario × config, aggregated across every run. Only priced attempts count toward cost; judge LLM cost is harness overhead kept separate — switch the metric to Judge Cost to inspect it. Min/Max show the per-attempt spread."
      >
        <Seg
          options={HEAT_ORDER.map((k) => ({ key: k, label: HEAT_METRICS[k].label }))}
          value={metricKey}
          onChange={setMetricKey}
        />
        <InfoTip text={metric.tip} />
      </SectionHead>
      <div className="an-heat-scroll">
        <HeatTable
          rows={rows}
          cols={cols}
          cell={cell}
          emptyText="Not enough data yet — attempts will fill the matrix"
        />
      </div>
      {data.matrix.length > 0 ? (
        <div className="an-summary dim">
          Σ Task Cost <span className="an-strong">{fmtCost(totals.cost)}</span> · Σ Judge Cost{" "}
          <span className="an-strong">{fmtCost(totals.judgeCost)}</span> · {totals.priced}/
          {totals.attempts} attempts priced
        </div>
      ) : null}
    </div>
  );
}

// ---- section 4: Models — "What model is better while keeping performance?" ----

const MODEL_COLUMNS: Column<AnalyticsModel>[] = [
  {
    key: "model",
    header: "Model",
    searchText: (m) => m.model,
    render: (m) => <ModelChip model={m.model} />,
  },
  {
    key: "providers",
    header: "Providers",
    width: "84px",
    sortValue: (m) => m.providers.join(" ") || null,
    render: (m) =>
      m.providers.length > 0 ? (
        <span className="an-providers">
          {m.providers.map((p) => (
            <HarnessIcon key={p} harness={p} />
          ))}
        </span>
      ) : (
        <span className="dim">—</span>
      ),
  },
  {
    key: "attempts",
    header: "Attempts",
    width: "76px",
    align: "right",
    sortValue: (m) => m.attempts,
    titleText: (m) =>
      `${m.attempts} attempts · ${m.graded} graded · ${m.errors} errors · ${m.runs} runs`,
    render: (m) => m.attempts,
  },
  {
    key: "passRate",
    header: "Pass Rate",
    headerTip:
      "Passed ÷ graded (passed + failed). Errors are infra failures and never lower the rate.",
    width: "80px",
    align: "right",
    sortValue: (m) => m.passRate,
    titleText: (m) => `${m.passed} passed / ${m.graded} graded`,
    render: (m) => (m.passRate !== null ? fmtPct(m.passRate) : <span className="dim">—</span>),
  },
  {
    key: "score",
    header: "Avg Score",
    headerTip: "Mean judge score over attempts with a score.",
    width: "82px",
    align: "right",
    sortValue: (m) => m.avgScore,
    render: (m) => fmtScore(m.avgScore),
  },
  {
    key: "costAttempt",
    header: "$ / Attempt",
    headerTip: MODEL_METRICS.attempt.tip,
    width: "88px",
    align: "right",
    sortValue: (m) => m.avgCostPerAttempt,
    render: (m) => fmtCost(m.avgCostPerAttempt),
  },
  {
    key: "costRun",
    header: "$ / Run",
    headerTip: MODEL_METRICS.run.tip,
    width: "80px",
    align: "right",
    sortValue: (m) => m.avgCostPerRun,
    render: (m) => fmtCost(m.avgCostPerRun),
  },
  {
    key: "costMinute",
    header: "$ / Minute",
    headerTip: MODEL_METRICS.minute.tip,
    width: "86px",
    align: "right",
    sortValue: (m) => m.costPerMinute,
    render: (m) => fmtCost(m.costPerMinute),
  },
  {
    key: "duration",
    header: "Avg Duration",
    headerTip: "Mean attempt duration over attempts with a duration.",
    width: "94px",
    align: "right",
    sortValue: (m) => m.avgDurationMs,
    render: (m) => fmtDuration(m.avgDurationMs),
  },
  {
    key: "tokens",
    header: "Tokens",
    headerTip:
      "Σ tokens (input + output + cache read + cache write) over the model's token-bearing attempts — hover for the breakdown (v7 §11).",
    width: "76px",
    align: "right",
    sortValue: (m) => m.tokens?.totalTokens ?? null,
    titleText: (m) => (m.tokens != null ? tokensTitle(m.tokens) : "no token data"),
    render: (m) =>
      m.tokens != null ? fmtTokens(m.tokens.totalTokens) : <span className="dim">—</span>,
  },
];

function ModelsSection(props: { models: AnalyticsModel[] }): ReactNode {
  const [metricKey, setMetricKey] = useState<ModelMetricKey>("attempt");
  const metric = MODEL_METRICS[metricKey];
  const { resolve } = useModels();

  const groups = useMemo<BarGroup[]>(() => {
    // §6.2: ascending for Duration (faster = better at the top), descending otherwise.
    const dir = metricKey === "duration" ? 1 : -1;
    return props.models
      .map((m) => ({ m, v: metric.value(m) }))
      .sort((a, b) => {
        if (a.v === null && b.v === null) return b.m.attempts - a.m.attempts;
        if (a.v === null) return 1;
        if (b.v === null) return -1;
        return dir * (a.v - b.v) || b.m.attempts - a.m.attempts;
      })
      .map(({ m, v }) => ({
        key: m.model,
        label: resolve(m.model)?.name ?? m.model,
        values: [v],
      }));
  }, [props.models, metric, metricKey, resolve]);

  return (
    <div className="panel">
      <SectionHead
        title="Which Model Wins?"
        tip="Per-model rollups across every run (model key: harness-reported model, falling back to the config). Cheap AND passing is the goal — read Pass Rate against the cost columns."
      >
        <Seg
          options={MODEL_ORDER.map((k) => ({ key: k, label: MODEL_METRICS[k].label }))}
          value={metricKey}
          onChange={setMetricKey}
        />
        <InfoTip text={metric.tip} />
      </SectionHead>
      <div className="an-models-chart">
        <BarChart
          groups={groups}
          series={[metric.label]}
          horizontal
          format={metric.format}
          emptyText="No priced attempts yet"
        />
      </div>
      <DataTable
        rows={props.models}
        columns={MODEL_COLUMNS}
        rowKey={(m) => m.model}
        searchable={false}
        defaultSort={{ key: "attempts", dir: "desc" }}
        emptyText="Not enough data yet — model rollups appear after the first run"
      />
    </div>
  );
}

// ---- section 5: Rollups — by harness / by vendor (v7 §7.3) ----

function rollupColumns(mode: ColorByKey): Column<AnalyticsGroupRollup>[] {
  return [
    {
      key: "group",
      header: mode === "harness" ? "Harness" : "Vendor",
      searchText: (r) => r.group,
      render: (r) => (
        <span className="an-group">
          <span
            className="chart-dot"
            style={{
              background: colorForGroup(
                r.group,
                mode === "harness" ? HARNESS_COLORS : VENDOR_COLORS,
              ),
            }}
          />
          {mode === "harness" ? <HarnessIcon harness={r.group} showLabel /> : r.group}
        </span>
      ),
    },
    {
      key: "models",
      header: "Models",
      width: "64px",
      align: "right",
      sortValue: (r) => r.models.length,
      titleText: (r) => (r.models.length > 0 ? r.models.join(", ") : "no models"),
      render: (r) => r.models.length,
    },
    {
      key: "runs",
      header: "Runs",
      width: "56px",
      align: "right",
      sortValue: (r) => r.runs,
      render: (r) => r.runs,
    },
    {
      key: "attempts",
      header: "Attempts",
      width: "74px",
      align: "right",
      sortValue: (r) => r.attempts,
      titleText: (r) =>
        `${r.attempts} attempts · ${r.graded} graded · ${r.errors} errors · ${r.configIds.length} configs`,
      render: (r) => r.attempts,
    },
    {
      key: "passRate",
      header: "Pass Rate",
      headerTip:
        "Passed ÷ graded (passed + failed). Errors are infra failures and never lower the rate.",
      width: "78px",
      align: "right",
      sortValue: (r) => r.passRate,
      titleText: (r) => `${r.passed} passed / ${r.graded} graded`,
      render: (r) => (r.passRate !== null ? fmtPct(r.passRate) : <span className="dim">—</span>),
    },
    {
      key: "score",
      header: "Avg Score",
      headerTip: "Mean judge score over attempts with a score.",
      width: "78px",
      align: "right",
      sortValue: (r) => r.avgScore,
      render: (r) => fmtScore(r.avgScore),
    },
    {
      key: "totalCost",
      header: "Σ Cost",
      headerTip: "Σ task cost over the group's priced attempts (judge cost excluded).",
      width: "78px",
      align: "right",
      sortValue: (r) => r.totalCostUsd,
      titleText: (r) => `${r.pricedAttempts} / ${r.attempts} attempts priced`,
      render: (r) => fmtCost(r.totalCostUsd),
    },
    {
      key: "avgCost",
      header: "$ / Attempt",
      headerTip: "Σ task cost ÷ priced attempts.",
      width: "86px",
      align: "right",
      sortValue: (r) => r.avgCostPerAttempt,
      render: (r) => fmtCost(r.avgCostPerAttempt),
    },
    {
      key: "minCost",
      header: "Min",
      headerTip: "Cheapest priced attempt in the group.",
      width: "72px",
      align: "right",
      sortValue: (r) => r.minCostUsd,
      render: (r) => fmtCost(r.minCostUsd),
    },
    {
      key: "maxCost",
      header: "Max",
      headerTip: "Most expensive priced attempt in the group.",
      width: "72px",
      align: "right",
      sortValue: (r) => r.maxCostUsd,
      render: (r) => fmtCost(r.maxCostUsd),
    },
    {
      key: "duration",
      header: "Avg Duration",
      headerTip: "Mean attempt duration over attempts with a duration.",
      width: "92px",
      align: "right",
      sortValue: (r) => r.avgDurationMs,
      render: (r) => fmtDuration(r.avgDurationMs),
    },
    {
      key: "tokens",
      header: "Tokens",
      headerTip:
        "Σ tokens (input + output + cache read + cache write) over the group's token-bearing attempts — hover for the breakdown.",
      width: "76px",
      align: "right",
      sortValue: (r) => r.tokens?.totalTokens ?? null,
      titleText: (r) => (r.tokens != null ? tokensTitle(r.tokens) : "no token data"),
      render: (r) =>
        r.tokens != null ? fmtTokens(r.tokens.totalTokens) : <span className="dim">—</span>,
    },
  ];
}

function RollupSection(props: {
  harnesses: AnalyticsGroupRollup[];
  vendors: AnalyticsGroupRollup[];
}): ReactNode {
  const [mode, setMode] = useState<ColorByKey>("harness");
  const rows = mode === "harness" ? props.harnesses : props.vendors;
  const columns = useMemo(() => rollupColumns(mode), [mode]);

  return (
    <div className="panel">
      <SectionHead
        title="By Harness, By Vendor"
        tip="The same per-model aggregates rolled up one level: by harness provider (which agent CLI ran the attempt) or by model vendor (who serves the model the attempt actually used). Group colors match the scatter above."
      >
        <Seg
          options={[
            { key: "harness" as const, label: "By Harness" },
            { key: "vendor" as const, label: "By Vendor" },
          ]}
          value={mode}
          onChange={setMode}
        />
      </SectionHead>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.group}
        searchable={false}
        defaultSort={{ key: "attempts", dir: "desc" }}
        emptyText="Not enough data yet — rollups appear after the first run"
      />
    </div>
  );
}

// ---- page ----

/**
 * Pre-filter option lists for the global filter bar (v7.6 §C3). Stale cached
 * payloads without filterOptions degrade to the (filtered-row) configIds plus
 * the §7.1 configId-prefix rule for harness keys.
 */
function filterOptionsOf(data: AnalyticsResponse): AnalyticsFilterOptions {
  if (data.filterOptions !== undefined) return data.filterOptions;
  const harnesses: string[] = [];
  for (const id of data.configIds) {
    const prefix = id.split("-")[0] ?? "";
    const harness = prefix.length > 0 ? prefix : "(unknown)";
    if (!harnesses.includes(harness)) harnesses.push(harness);
  }
  return { harnesses, configIds: data.configIds };
}

function PageHead(props: {
  data: AnalyticsResponse;
  onRefresh: () => void;
  fHarnesses: string[];
  fConfigIds: string[];
  onHarnesses: (next: string[]) => void;
  onConfigIds: (next: string[]) => void;
}): ReactNode {
  const { data } = props;
  const configSearchText = useConfigSearchText();
  const attempts = useMemo(
    () => data.matrix.reduce((acc, c) => acc + c.attempts, 0),
    [data.matrix],
  );
  const options = useMemo(() => filterOptionsOf(data), [data]);
  const active = props.fHarnesses.length + props.fConfigIds.length;
  return (
    <div className="an-head">
      <h2 className="an-title">Analytics</h2>
      <div className="an-filters">
        <MultiSelect
          label="Harness"
          options={options.harnesses}
          selected={props.fHarnesses}
          onChange={props.onHarnesses}
          renderOption={(o) => <HarnessIcon harness={o} showLabel />}
        />
        <MultiSelect
          label="Config"
          options={options.configIds}
          selected={props.fConfigIds}
          onChange={props.onConfigIds}
          renderOption={(o) => <ConfigChip configId={o} />}
          searchText={configSearchText}
        />
        {active > 0 ? (
          <button
            type="button"
            className="an-filter-clear"
            title="Clear the global filters — every section is currently narrowed to the selection"
            onClick={() => {
              props.onHarnesses([]);
              props.onConfigIds([]);
            }}
          >
            ✕ {active} {active === 1 ? "filter" : "filters"}
          </button>
        ) : null}
      </div>
      <span className="an-meta dim" title={data.generatedAt}>
        {attempts} attempts · {data.scenarioIds.length} scenarios × {data.configIds.length} configs
        {active > 0 ? " · filtered" : ""} · generated {fmtAgo(data.generatedAt)}
      </span>
      <button type="button" className="btn" onClick={props.onRefresh}>
        ↻ Refresh
      </button>
    </div>
  );
}

/**
 * Analytics v2 (v7 spec §6.2/§7.3) — top to bottom: Highlights (three per-model
 * mini bar cards à la artificialanalysis.ai), Trends (multi-select scenario ×
 * config overlay), Efficiency (score-vs-tokens scatter with the most-attractive
 * quadrant and a harness/vendor color toggle), Cost Matrix (now with Min/Max),
 * Models (now with Duration/Accuracy metrics + Tokens), and harness/vendor
 * rollups. Single fetch + manual refresh; every section degrades to an explicit
 * empty state over partial/pre-v7 data (no NaN, ever).
 *
 * v7.6 §C3: the sticky page header carries a global harness + config filter,
 * applied SERVER-SIDE — every section below re-aggregates over the filtered
 * attempts (per-model means cannot be recomputed from pre-aggregated cells).
 * Filter state is component state only (empty = all); usePoll keeps the prior
 * payload on screen while a filter refetch is in flight (no flash).
 */
export default function AnalyticsPage(): ReactNode {
  const [fHarnesses, setFHarnesses] = useState<string[]>([]);
  const [fConfigIds, setFConfigIds] = useState<string[]>([]);
  const analytics = usePoll(
    () => getAnalytics({ harnesses: fHarnesses, configIds: fConfigIds }),
    null,
    [fHarnesses.join(","), fConfigIds.join(",")],
  );

  if (analytics.data === null) {
    return analytics.error !== null ? (
      <div className="panel an-error">Failed to load analytics: {analytics.error}</div>
    ) : (
      <div className="panel">
        <Spinner label="Loading analytics…" />
      </div>
    );
  }

  return (
    <>
      <PageHead
        data={analytics.data}
        onRefresh={analytics.refresh}
        fHarnesses={fHarnesses}
        fConfigIds={fConfigIds}
        onHarnesses={setFHarnesses}
        onConfigIds={setFConfigIds}
      />
      <HighlightsSection models={analytics.data.models} />
      <TrendsSection series={analytics.data.series} />
      <EfficiencySection scatter={analytics.data.scatter ?? []} />
      <CostSection data={analytics.data} />
      <ModelsSection models={analytics.data.models} />
      <RollupSection
        harnesses={analytics.data.harnesses ?? []}
        vendors={analytics.data.vendors ?? []}
      />
    </>
  );
}

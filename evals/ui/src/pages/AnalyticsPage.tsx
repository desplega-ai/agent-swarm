import { type ReactNode, useCallback, useMemo, useState } from "react";
import { getAnalytics } from "../api.ts";
import { ConfigChip } from "../components/ConfigChip.tsx";
import { BarChart, type BarGroup } from "../components/charts/BarChart.tsx";
import { type HeatCellData, HeatTable } from "../components/charts/HeatTable.tsx";
import { type ChartMarker, LineChart, type LineSeries } from "../components/charts/LineChart.tsx";
import { type Column, DataTable } from "../components/DataTable.tsx";
import { EntityLink } from "../components/EntityLink.tsx";
import { fmtAgo, fmtCost, fmtDate, fmtDuration, fmtScore } from "../components/format.ts";
import { HarnessIcon } from "../components/HarnessIcon.tsx";
import { ModelChip } from "../components/ModelChip.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { InfoTip } from "../components/Tooltip.tsx";
import { useModels, usePoll } from "../hooks.ts";
import type {
  AnalyticsCell,
  AnalyticsModel,
  AnalyticsResponse,
  AnalyticsSeries,
  AnalyticsSeriesPoint,
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

type HeatMetricKey = "avg" | "total" | "judge";

const HEAT_ORDER: HeatMetricKey[] = ["avg", "total", "judge"];

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
};

type ModelMetricKey = "attempt" | "run" | "minute";

const MODEL_ORDER: ModelMetricKey[] = ["attempt", "run", "minute"];

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

// ---- section 1: Trends — "Is the swarm improving over time?" ----

function bestOf(list: AnalyticsSeries[]): AnalyticsSeries | null {
  return list.reduce<AnalyticsSeries | null>(
    (acc, s) => (acc === null || s.points.length > acc.points.length ? s : acc),
    null,
  );
}

function TrendsSection(props: { series: AnalyticsSeries[] }): ReactNode {
  const { series } = props;
  const [pickedScenario, setPickedScenario] = useState<string | null>(null);
  const [pickedConfig, setPickedConfig] = useState<string | null>(null);
  const [metricKey, setMetricKey] = useState<TrendMetricKey>("score");
  const metric = TREND_METRICS[metricKey];

  const scenarioIds = useMemo(() => [...new Set(series.map((s) => s.scenarioId))], [series]);

  // Default: the (scenario, config) pair with the most points; selections fall
  // back gracefully when the picked combination has no series.
  const scenarioId =
    pickedScenario !== null && scenarioIds.includes(pickedScenario)
      ? pickedScenario
      : (bestOf(series)?.scenarioId ?? null);
  const scenarioSeries = useMemo(
    () => series.filter((s) => s.scenarioId === scenarioId),
    [series, scenarioId],
  );
  const selected =
    scenarioSeries.find((s) => s.configId === pickedConfig) ?? bestOf(scenarioSeries);

  const chartSeries = useMemo<LineSeries[]>(() => {
    if (selected === null) return [];
    return [
      {
        id: `${selected.scenarioId}|${selected.configId}`,
        name: `${selected.scenarioId} × ${selected.configId}`,
        points: selected.points
          .map((p) => ({ x: Date.parse(p.createdAt), y: metric.value(p) }))
          .filter((p) => Number.isFinite(p.x)),
      },
    ];
  }, [selected, metric]);

  const markers = useMemo<ChartMarker[]>(() => {
    if (selected === null) return [];
    return selected.versionEvents
      .map((ev) => ({
        x: Date.parse(ev.createdAt),
        label: `${ev.kind === "api" ? "api" : "w"} ${ev.to}`,
        color: ev.kind === "api" ? "var(--blue)" : "var(--orange)",
      }))
      .filter((m) => Number.isFinite(m.x));
  }, [selected]);

  return (
    <div className="panel">
      <SectionHead
        title="Improving Over Time?"
        tip="One point per run for the selected scenario × config. Dashed vertical lines mark API / worker version changes captured at sandbox boot — development progress shows up as the metric moving across those lines."
      >
        {selected !== null ? (
          <>
            <label className="an-select">
              <span className="dim">Scenario</span>
              <select
                value={scenarioId ?? ""}
                onChange={(e) => {
                  setPickedScenario(e.target.value);
                  setPickedConfig(null);
                }}
              >
                {scenarioIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <label className="an-select">
              <span className="dim">Config</span>
              <select value={selected.configId} onChange={(e) => setPickedConfig(e.target.value)}>
                {scenarioSeries.map((s) => (
                  <option key={s.configId} value={s.configId}>
                    {s.configId}
                  </option>
                ))}
              </select>
            </label>
            <Seg
              options={TREND_ORDER.map((k) => ({ key: k, label: TREND_METRICS[k].label }))}
              value={metricKey}
              onChange={setMetricKey}
            />
            <InfoTip text={metric.tip} />
          </>
        ) : null}
      </SectionHead>
      {selected === null ? (
        <div className="chart-empty">Not enough data yet — finished eval runs will chart here</div>
      ) : (
        <>
          <LineChart
            series={chartSeries}
            markers={markers}
            height={240}
            yFormat={metric.format}
            emptyText={`No ${metric.label} data for this pair yet`}
          />
          <div className="an-foot">
            <span className="dim">
              {selected.points.length} {selected.points.length === 1 ? "run" : "runs"} plotted
            </span>
            {selected.versionEvents.length > 0 ? (
              selected.versionEvents.map((ev) => (
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
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---- section 2: Cost Matrix — "What is the cost of running it in special tasks?" ----

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
        tip="Cost per scenario × config, aggregated across every run. Only priced attempts count toward cost; judge LLM cost is harness overhead kept separate — switch the metric to Judge Cost to inspect it."
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

// ---- section 3: Models — "What model is better while keeping performance?" ----

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
];

function ModelsSection(props: { models: AnalyticsModel[] }): ReactNode {
  const [metricKey, setMetricKey] = useState<ModelMetricKey>("attempt");
  const metric = MODEL_METRICS[metricKey];
  const { resolve } = useModels();

  const groups = useMemo<BarGroup[]>(
    () =>
      props.models
        .map((m) => ({ m, v: metric.value(m) }))
        .sort(
          (a, b) =>
            (b.v ?? Number.NEGATIVE_INFINITY) - (a.v ?? Number.NEGATIVE_INFINITY) ||
            b.m.attempts - a.m.attempts,
        )
        .map(({ m, v }) => ({
          key: m.model,
          label: resolve(m.model)?.name ?? m.model,
          values: [v],
        })),
    [props.models, metric, resolve],
  );

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

// ---- page ----

function PageHead(props: { data: AnalyticsResponse; onRefresh: () => void }): ReactNode {
  const { data } = props;
  const attempts = useMemo(
    () => data.matrix.reduce((acc, c) => acc + c.attempts, 0),
    [data.matrix],
  );
  return (
    <div className="an-head">
      <h2 className="an-title">Analytics</h2>
      <span className="an-meta dim" title={data.generatedAt}>
        {attempts} attempts · {data.scenarioIds.length} scenarios × {data.configIds.length} configs
        · generated {fmtAgo(data.generatedAt)}
      </span>
      <button type="button" className="btn" onClick={props.onRefresh}>
        ↻ Refresh
      </button>
    </div>
  );
}

/**
 * Analytics (v5 spec §3) — three sections, one per Taras question:
 * Trends ("Is the swarm improving over time?"), Cost Matrix ("What is the cost
 * of running it in special tasks?"), Models ("What model is better while
 * keeping performance?"). Single fetch + manual refresh; every section
 * degrades to an explicit empty state over partial/old data.
 */
export default function AnalyticsPage(): ReactNode {
  const analytics = usePoll(getAnalytics, null, []);

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
      <PageHead data={analytics.data} onRefresh={analytics.refresh} />
      <TrendsSection series={analytics.data.series} />
      <CostSection data={analytics.data} />
      <ModelsSection models={analytics.data.models} />
    </>
  );
}

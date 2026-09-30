import { type ReactNode, useEffect, useMemo, useState } from "react";
import { getReliability, getSuites } from "../api.ts";
import { ConfigChip } from "../components/ConfigChip.tsx";
import { seriesColor } from "../components/charts/chart-utils.ts";
import { type TrendSeries, TrendChart } from "../components/charts/TrendChart.tsx";
import { fmtAgo, fmtDate } from "../components/format.ts";
import { Seg } from "../components/Seg.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { SuiteSelect } from "../components/SuiteSelect.tsx";
import { InfoTip } from "../components/Tooltip.tsx";
import { navigate, replaceHashQuery, useHashRoute, usePoll } from "../hooks.ts";
import {
  defaultTrendConfigs,
  type ReliabilityResponse,
  type ReliabilityRow,
  reliabilityRows,
  type TrendMetric,
  trendLine,
} from "../lib/suite-analytics.ts";
import "./reliability.css";

/** The most lines the trend draws at once: one per colour in the chart palette. */
const MAX_TREND_CONFIGS = 6;

const METRICS: readonly { key: TrendMetric; label: string; title: string }[] = [
  {
    key: "score",
    label: "Score",
    title: "Mean score over the run's attempts, with a 95% bootstrap band",
  },
  {
    key: "passRate",
    label: "Pass rate",
    title: "Mean per-scenario pass rate in the run",
  },
];

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function oneOf<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === raw) ?? fallback;
}

// ---- pass@1 vs pass^k ----

function Dumbbell(props: { row: ReliabilityRow; k: number }): ReactNode {
  const { row, k } = props;
  const lo = Math.min(row.passAt1, row.passPowK) * 100;
  const hi = Math.max(row.passAt1, row.passPowK) * 100;
  return (
    <div
      className="rel-track"
      role="img"
      aria-label={`pass@1 ${pct(row.passAt1)}, pass^${k} ${pct(row.passPowK)}`}
    >
      <div className="rel-bar" style={{ left: `${lo}%`, width: `${Math.max(0.4, hi - lo)}%` }} />
      <span
        className="rel-dot rel-dot-at1"
        style={{ left: `${row.passAt1 * 100}%` }}
        title={`pass@1 ${pct(row.passAt1)}: the chance one attempt passes`}
      />
      <span
        className="rel-dot rel-dot-powk"
        style={{ left: `${row.passPowK * 100}%` }}
        title={`pass^${k} ${pct(row.passPowK)}: the chance ${k} attempts in a row all pass`}
      />
    </div>
  );
}

function ReliabilityPanel(props: {
  rel: ReliabilityResponse;
  k: number;
  onK: (k: number) => void;
}): ReactNode {
  const { rel, k } = props;
  const { rows, waiting } = useMemo(() => reliabilityRows(rel, k), [rel, k]);
  const ks = useMemo(
    () => Array.from({ length: rel.maxK - 1 }, (_, i) => i + 2).map((n) => ({
      key: String(n),
      label: `k = ${n}`,
    })),
    [rel.maxK],
  );
  return (
    <div className="panel">
      <div className="an-panel-head">
        <h3 className="panel-title">
          pass@1 against pass^{k}{" "}
          <InfoTip
            text={`pass@1 is the chance one attempt passes. pass^${k} is the chance ${k} attempts on the same scenario all pass, averaged over the scenarios with at least ${k} graded attempts. The bar between them is what repeating the task costs: a short bar is a setup you can trust to pass every time.`}
          />
        </h3>
        <div className="an-controls">
          <span className="an-seg-label dim">Repeats</span>
          <Seg options={ks} value={String(k)} onChange={(v) => props.onK(Number(v))} />
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="chart-empty">
          No config has a scenario with {k} graded attempts yet, so pass^{k} is not defined. Try a
          smaller k, or run the suite with more repeats.
        </div>
      ) : (
        <>
          <div className="rel-legend">
            <span className="rel-legend-item">
              <span className="rel-dot rel-dot-at1 rel-dot-static" /> pass@1
            </span>
            <span className="rel-legend-item">
              <span className="rel-dot rel-dot-powk rel-dot-static" /> pass^{k}
            </span>
            <span className="dim">most reliable first</span>
          </div>
          <div className="rel-rows">
            <div className="rel-row rel-head">
              <span>Config</span>
              <span className="rel-axis">
                <span>0%</span>
                <span>50%</span>
                <span>100%</span>
              </span>
              <span className="rel-num">pass@1</span>
              <span className="rel-num">pass^{k}</span>
              <span className="rel-num">Gap</span>
            </div>
            {rows.map((row) => (
              <button
                type="button"
                className="rel-row"
                key={row.configId}
                onClick={() => navigate(`#/runs?config=${encodeURIComponent(row.configId)}`)}
                title="Open this config's runs"
              >
                <span className="rel-cfg">
                  <ConfigChip configId={row.configId} effort={null} />
                  {row.lowN ? <span className="lb-badge">low n</span> : null}
                  {!row.fullCoverage ? (
                    <span className="lb-badge" title="Has not run every scenario of the suite">
                      partial
                    </span>
                  ) : null}
                </span>
                <Dumbbell row={row} k={k} />
                <span className="rel-num">{pct(row.passAt1)}</span>
                <span className="rel-num">
                  {pct(row.passPowK)}
                  {row.scenarios < rel.configs.find((c) => c.configId === row.configId)?.curve[0]?.scenarios!
                    ? <span className="dim" title={`Over ${row.scenarios} scenarios with ${k}+ graded attempts`}>*</span>
                    : null}
                </span>
                <span className={row.gap >= 0.25 ? "rel-num tone-red" : "rel-num dim"}>
                  {row.gap < 0.005 ? "0" : `−${Math.round(row.gap * 100)}`}
                </span>
              </button>
            ))}
          </div>
          {waiting.length > 0 ? (
            <p className="dim lb-foot">
              Waiting for more repeats (no scenario has {k} graded attempts):{" "}
              {waiting.map((c) => c.configId).join(", ")}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---- trend with confidence bands ----

function TrendPanel(props: {
  rel: ReliabilityResponse;
  picked: string[] | null;
  onPick: (ids: string[]) => void;
  metric: TrendMetric;
  onMetric: (m: TrendMetric) => void;
}): ReactNode {
  const { rel, metric } = props;
  const fallback = useMemo(() => defaultTrendConfigs(rel, 3), [rel]);
  const selected = (props.picked ?? fallback).filter((id) =>
    rel.configs.some((c) => c.configId === id),
  );
  const series: TrendSeries[] = useMemo(
    () =>
      rel.configs
        .filter((c) => selected.includes(c.configId))
        .map((c) => {
          const line = trendLine(c, metric);
          return {
            id: c.configId,
            name: c.configId,
            color: seriesColor(selected.indexOf(c.configId)),
            points: line.points.map((p) => ({
              x: p.x,
              y: p.y,
              lo: p.lo,
              hi: p.hi,
              label: p.point.runName ?? p.point.runId,
              detail: `${p.point.scenarios} scenarios, ${p.point.attempts} attempts`,
            })),
          };
        }),
    [rel, selected, metric],
  );
  const runs = new Set(series.flatMap((s) => s.points.map((p) => p.label))).size;
  const toggle = (id: string) => {
    const on = selected.includes(id);
    if (on) props.onPick(selected.filter((x) => x !== id));
    else if (selected.length < MAX_TREND_CONFIGS) props.onPick([...selected, id]);
  };
  return (
    <div className="panel">
      <div className="an-panel-head">
        <h3 className="panel-title">
          Run to run{" "}
          <InfoTip text="One point per run for each config, over the scenarios that run covered. The shaded band is the 95% bootstrap interval of the run's score, resampling attempts within each scenario. A dip that stays inside the band is noise; one below it is worth a look." />
        </h3>
        <div className="an-controls">
          <Seg options={METRICS} value={metric} onChange={props.onMetric} />
        </div>
      </div>
      <div className="rel-picks" role="group" aria-label="Configs to draw">
        {rel.configs.map((c) => {
          const on = selected.includes(c.configId);
          const idx = selected.indexOf(c.configId);
          const runsHere = c.trend.length;
          return (
            <button
              type="button"
              key={c.configId}
              className={on ? "rel-pick on" : "rel-pick"}
              aria-pressed={on}
              disabled={!on && selected.length >= MAX_TREND_CONFIGS}
              title={`${runsHere} ${runsHere === 1 ? "run" : "runs"}`}
              onClick={() => toggle(c.configId)}
            >
              <span
                className="chart-dot"
                style={{ background: on ? seriesColor(idx) : "var(--border)" }}
              />
              {c.configId}
              <span className="dim"> · {runsHere}</span>
            </button>
          );
        })}
      </div>
      <TrendChart
        series={series}
        yFormat={(v) => (metric === "score" ? v.toFixed(2) : `${Math.round(v * 100)}%`)}
        emptyText={
          selected.length === 0
            ? "Pick a config to draw its runs"
            : "No runs with a value for this metric yet"
        }
      />
      <p className="dim lb-foot">
        {runs === 0
          ? ""
          : runs === 1
            ? "One run so far: a trend needs two or more. Each new run adds a point."
            : `${runs} runs drawn`}
        {selected.length >= MAX_TREND_CONFIGS ? ` · at most ${MAX_TREND_CONFIGS} configs at once` : ""}
      </p>
    </div>
  );
}

/**
 * Reliability view (Phase 6): how far a setup's pass rate falls when the task is
 * repeated (pass@1 against pass^k), and how its score moves run to run with a
 * confidence band. Replaces the old "Improving over time?" chart.
 */
export default function ReliabilityView(): ReactNode {
  const route = useHashRoute();
  const { query } = route;
  const [suiteChoice, setSuiteChoice] = useState<string | null>(() => query.get("suite"));
  const [k, setK] = useState<number>(() => {
    const n = Number(query.get("k"));
    return Number.isInteger(n) && n >= 2 ? n : 3;
  });
  const [metric, setMetric] = useState<TrendMetric>(() =>
    oneOf<TrendMetric>(query.get("metric"), ["score", "passRate"], "score"),
  );
  const [picked, setPicked] = useState<string[] | null>(() => {
    const raw = query.get("configs");
    return raw ? raw.split(",").filter(Boolean) : null;
  });

  useEffect(() => {
    setSuiteChoice(route.query.get("suite"));
    const n = Number(route.query.get("k"));
    setK(Number.isInteger(n) && n >= 2 ? n : 3);
    setMetric(oneOf<TrendMetric>(route.query.get("metric"), ["score", "passRate"], "score"));
    const raw = route.query.get("configs");
    setPicked(raw ? raw.split(",").filter(Boolean) : null);
  }, [route]);

  const suites = usePoll(getSuites, null, []);
  const suite = suiteChoice ?? suites.data?.current ?? null;
  const rel = usePoll<ReliabilityResponse | null>(
    () => (suite === null ? Promise.resolve(null) : getReliability(suite)),
    null,
    [suite],
  );

  useEffect(() => {
    replaceHashQuery({
      suite: suiteChoice,
      k: k === 3 ? null : String(k),
      metric: metric === "score" ? null : metric,
      configs: picked === null ? null : picked.join(","),
    });
  }, [suiteChoice, k, metric, picked]);

  const data = rel.data;
  const err = suites.error ?? rel.error;
  // Never ask for a k the response has no curve for.
  const kShown = data === null ? k : Math.min(Math.max(2, k), Math.max(2, data.maxK));

  return (
    <>
      <div className="lb-head">
        <h2 className="an-title">Reliability</h2>
        <SuiteSelect suites={suites.data} value={suite} onChange={setSuiteChoice} />
        <span className="an-meta dim" title={data?.generatedAt}>
          {data === null
            ? ""
            : `${data.configs.length} configs · generated ${fmtAgo(data.generatedAt)}`}
        </span>
        <button type="button" className="btn" onClick={rel.refresh}>
          ↻ Refresh
        </button>
      </div>
      {err !== null && data === null ? (
        <div className="panel an-error">Failed to load reliability: {err}</div>
      ) : data === null ? (
        <div className="panel">
          <Spinner label="Loading reliability…" />
        </div>
      ) : data.configs.length === 0 ? (
        <div className="panel lb-banner">
          <strong>No graded attempts in suite {data.suiteVersion} yet.</strong> Pick another suite
          above, or start a run of this one.
        </div>
      ) : (
        <>
          <ReliabilityPanel rel={data} k={kShown} onK={setK} />
          <TrendPanel
            rel={data}
            picked={picked}
            onPick={setPicked}
            metric={metric}
            onMetric={setMetric}
          />
          <p className="dim lb-foot">
            Latest run in this suite:{" "}
            {(() => {
              const last = data.configs
                .flatMap((c) => c.trend)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
              return last ? `${last.runName ?? last.runId}, ${fmtDate(last.createdAt)}` : "none";
            })()}
          </p>
        </>
      )}
    </>
  );
}

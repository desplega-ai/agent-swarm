import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { getFrontier, getLeaderboard, getSuites } from "../api.ts";
import { ConfigChip } from "../components/ConfigChip.tsx";
import { colorForGroup } from "../components/charts/chart-utils.ts";
import { FrontierChart, Marker } from "../components/charts/FrontierChart.tsx";
import { type Column, DataTable } from "../components/DataTable.tsx";
import { EffortChip, effortKeyLabel } from "../components/EffortChip.tsx";
import { fmtAgo, fmtCost, fmtDuration, fmtTokens } from "../components/format.ts";
import { HarnessIcon } from "../components/HarnessIcon.tsx";
import { ModelChip } from "../components/ModelChip.tsx";
import { Seg } from "../components/Seg.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { SuiteSelect } from "../components/SuiteSelect.tsx";
import { InfoTip } from "../components/Tooltip.tsx";
import { navigate, replaceHashQuery, useHashRoute, usePoll } from "../hooks.ts";
import { paretoFrontier } from "../lib/pareto.ts";
import {
  buildFrontierDots,
  type DotShape,
  defaultHarness,
  effortsByConfig,
  type FrontierAxis,
  type FrontierDot,
  type FrontierResponse,
  frontierLine,
  frontierPicks,
  type LeaderboardResponse,
  type LeaderboardRow,
  rankSortValue,
  SHAPE_LEGEND,
  type Track,
  timeTicks,
  trackConfigIds,
} from "../lib/suite-analytics.ts";
import AnalyticsPage from "./AnalyticsPage.tsx";
import HeatmapView from "./HeatmapView.tsx";
import ReliabilityView from "./ReliabilityView.tsx";
import "./leaderboard.css";

/**
 * One hue per harness on the frontier. The shared HARNESS_COLORS gives claude
 * (orange) and codex (accent amber) near-identical hues, which is fine in a
 * bar chart and unreadable when two dots sit close together.
 */
const HARNESS_HUES: Record<string, string> = {
  claude: "var(--orange)",
  codex: "var(--blue)",
  pi: "var(--green)",
  opencode: "var(--yellow)",
};

function harnessColor(harness: string): string {
  return colorForGroup(harness, HARNESS_HUES);
}

const AXES: readonly { key: FrontierAxis; label: string; title: string }[] = [
  { key: "cost", label: "Cost", title: "Mean agent $ per attempt (judge cost excluded)" },
  {
    key: "time",
    label: "Agent time",
    title: "Median time the agent worked, sandbox boot and seeding excluded",
  },
];

const TRACKS: readonly { key: Track; label: string; title: string }[] = [
  {
    key: "fixed",
    label: "Fixed harness",
    title: "Compare models on one harness, so the harness is not a variable",
  },
  {
    key: "free",
    label: "Best harness per model",
    title: "Each model on the harness that scores it best",
  },
];

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function fmtAxisCost(v: number): string {
  return v >= 1 ? `$${v}` : `$${Number(v.toPrecision(2))}`;
}

function fmtAxisTime(ms: number): string {
  return fmtDuration(ms);
}

function effortLabel(efforts: readonly string[]): string {
  if (efforts.length === 0) return "harness default";
  return efforts.map(effortKeyLabel).join(" + ");
}

function scoreText(score: number | null): string {
  return score === null ? "—" : score.toFixed(3);
}

function ciText(row: { score: number | null; scoreCi: { lo: number; hi: number } | null }): string {
  if (row.score === null) return "no score";
  if (row.scoreCi === null || row.scoreCi.hi - row.scoreCi.lo < 1e-6) {
    return `${row.score.toFixed(3)}, no interval (one attempt per scenario)`;
  }
  return `${row.score.toFixed(3)}, 95% CI ${row.scoreCi.lo.toFixed(3)} to ${row.scoreCi.hi.toFixed(3)}`;
}

function openRuns(configId: string): void {
  navigate(`#/runs?config=${encodeURIComponent(configId)}`);
}

// ---- table ----

function leaderboardColumns(k: number, showHarness: boolean): Column<LeaderboardRow>[] {
  const cols: Column<LeaderboardRow>[] = [
    {
      key: "rank",
      header: "Rank",
      width: "84px",
      headerTip:
        "1 is best among the ranked rows of this track. The range is the 95% bootstrap interval of the rank. Only configs that ran every scenario of the suite are ranked.",
      sortValue: rankSortValue,
      titleText: (r) =>
        r.rank === null
          ? "Not ranked: this config has not run every scenario of the suite"
          : `Rank ${r.rank}${r.rankSpread ? `, 95% range ${r.rankSpread.lo} to ${r.rankSpread.hi}` : ""}`,
      render: (r) =>
        r.rank === null ? (
          <span className="dim">—</span>
        ) : (
          <span className="lb-rank">
            <strong>#{r.rank}</strong>
            {r.rankSpread !== null && r.rankSpread.lo !== r.rankSpread.hi ? (
              <span className="dim lb-rank-spread">
                {r.rankSpread.lo}–{r.rankSpread.hi}
              </span>
            ) : null}
          </span>
        ),
    },
    {
      key: "model",
      header: "Model",
      headerTip: "The concrete model the attempts ran on (resolved_model), not the alias",
      searchText: (r) => `${r.configId} ${r.resolvedModel} ${r.harness}`,
      titleText: (r) => r.configId,
      sortValue: (r) => r.resolvedModel,
      render: (r) => (
        <span className="lb-model">
          <ModelChip model={r.resolvedModel} />
          {r.resolvedModels.length > 1 ? (
            <span className="dim" title={r.resolvedModels.join(", ")}>
              +{r.resolvedModels.length - 1}
            </span>
          ) : null}
        </span>
      ),
    },
  ];
  if (showHarness) {
    cols.push({
      key: "harness",
      header: "Harness",
      width: "104px",
      sortValue: (r) => r.harness,
      filterOptions: (rows) => [...new Set(rows.map((r) => r.harness))].sort(),
      filterValue: (r) => r.harness,
      filterRender: (o) => <HarnessIcon harness={o} showLabel />,
      searchText: (r) => r.harness,
      render: (r) => <HarnessIcon harness={r.harness} showLabel />,
    });
  }
  cols.push(
    {
      key: "effort",
      header: "Effort",
      width: "96px",
      sortValue: (r) => r.efforts.join("+"),
      titleText: (r) => `Reasoning effort: ${effortLabel(r.efforts)}`,
      render: (r) =>
        r.efforts.length === 1 && r.efforts[0] !== "default" ? (
          <EffortChip effort={r.efforts[0]} />
        ) : (
          <span className="dim">{r.efforts.length > 1 ? "mixed" : "default"}</span>
        ),
    },
    {
      key: "score",
      header: "Score",
      width: "132px",
      align: "right",
      headerTip:
        "Mean of the per-scenario mean scores, 0 to 1. The second number is the half-width of the 95% bootstrap interval; none is shown while every scenario has a single attempt.",
      sortValue: (r) => r.score,
      titleText: ciText,
      render: (r) => (
        <span className="lb-score">
          <strong>{scoreText(r.score)}</strong>
          {r.scoreCi !== null && r.scoreCi.hi - r.scoreCi.lo >= 1e-6 ? (
            <span className="dim lb-ci">±{((r.scoreCi.hi - r.scoreCi.lo) / 2).toFixed(3)}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "passAt1",
      header: "pass@1",
      width: "72px",
      align: "right",
      headerTip: "Mean per-scenario pass rate: the chance one attempt passes",
      sortValue: (r) => r.passAt1,
      render: (r) => pct(r.passAt1),
    },
    {
      key: "passPowK",
      header: `pass^${k}`,
      width: "72px",
      align: "right",
      headerTip: `The chance ${k} attempts on the same scenario all pass, averaged over the scenarios with at least ${k} graded attempts. A dash means no scenario has that many yet.`,
      sortValue: (r) => r.passPowK,
      titleText: (r) =>
        r.passPowK === null
          ? `No scenario has ${k} graded attempts yet`
          : `Over ${r.passPowKScenarios} of ${r.scenarios.covered} scenarios`,
      render: (r) =>
        r.passPowK === null ? (
          <span className="dim">—</span>
        ) : (
          <span>
            {pct(r.passPowK)}
            {r.passPowKScenarios < r.scenarios.covered ? <span className="dim">*</span> : null}
          </span>
        ),
    },
    {
      key: "cost",
      header: "$/attempt",
      width: "84px",
      align: "right",
      headerTip: "Mean agent cost per attempt. Judge cost is separate.",
      sortValue: (r) => r.avgCostUsd,
      titleText: (r) =>
        `Agent ${fmtCost(r.avgCostUsd)}, judge ${fmtCost(r.avgJudgeCostUsd)} per attempt`,
      render: (r) => fmtCost(r.avgCostUsd),
    },
    {
      key: "time",
      header: "p50 time",
      width: "80px",
      align: "right",
      headerTip: "Median agent time per attempt, sandbox boot excluded",
      sortValue: (r) => r.medianAgentMs,
      render: (r) => fmtDuration(r.medianAgentMs),
    },
    {
      key: "tokens",
      header: "Tokens",
      width: "72px",
      align: "right",
      headerTip: "Mean total tokens per attempt",
      sortValue: (r) => r.avgTotalTokens,
      render: (r) => fmtTokens(r.avgTotalTokens === null ? null : Math.round(r.avgTotalTokens)),
    },
    {
      key: "attempts",
      header: "Attempts",
      width: "150px",
      align: "right",
      headerTip:
        "Graded attempts, and how many suite scenarios they cover. Fewer than 3 per scenario is flagged low n.",
      sortValue: (r) => r.attempts,
      titleText: (r) =>
        `${r.attempts} graded attempts over ${r.scenarios.covered} of ${r.scenarios.expected} scenarios${r.errors > 0 ? `, ${r.errors} errored (not scored)` : ""}`,
      render: (r) => (
        <span className="lb-attempts">
          {r.attempts}
          <span className={r.fullCoverage ? "dim" : "tone-accent"}>
            {" "}
            · {r.scenarios.covered}/{r.scenarios.expected}
          </span>
          {r.lowN ? <span className="lb-badge">low n</span> : null}
        </span>
      ),
    },
  );
  return cols;
}

// ---- pieces ----

/**
 * The line drawn on the chart. `suite`: the API's frontier, full-coverage
 * configs only. `shown`: the frontier of every plotted config, used when the
 * API has no frontier to draw.
 */
interface FrontierLine {
  scope: "suite" | "shown";
  dots: FrontierDot[];
}

function LegendMarker(props: { shape: DotShape; hollow?: boolean }): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <Marker
        shape={props.shape}
        cx={7}
        cy={7}
        r={4.5}
        className={props.hollow ? "frontier-dot hollow" : "frontier-dot"}
        color="var(--dim)"
      />
    </svg>
  );
}

function ChartLegend(props: {
  dots: FrontierDot[];
  line: FrontierLine | null;
  anyDim: boolean;
}): ReactNode {
  const harnesses = [...new Set(props.dots.map((d) => d.harness))];
  const shapes = SHAPE_LEGEND.filter((s) => props.dots.some((d) => d.shape === s.shape));
  const groups: { key: string; node: ReactNode }[] = [];
  if (harnesses.length > 0) {
    groups.push({
      key: "harness",
      node: (
        <span className="lb-legend-group">
          {harnesses.map((h) => (
            <span className="lb-legend-item" key={h}>
              <span className="chart-dot" style={{ background: harnessColor(h) }} />
              {h}
            </span>
          ))}
        </span>
      ),
    });
  }
  if (shapes.length > 1) {
    groups.push({
      key: "shape",
      node: (
        <span className="lb-legend-group">
          {shapes.map((s) => (
            <span className="lb-legend-item" key={s.shape}>
              <LegendMarker shape={s.shape} />
              {s.label}
            </span>
          ))}
        </span>
      ),
    });
  }
  const marks: ReactNode[] = [];
  if (props.dots.some((d) => d.hollow)) {
    marks.push(
      <span
        className="lb-legend-item"
        key="hollow"
        title="Partial suite coverage, under 3 attempts on some scenario, or a missing price or timing"
      >
        <LegendMarker shape="circle" hollow />
        not eligible for the frontier
      </span>,
    );
  }
  if (props.line !== null) {
    const suite = props.line.scope === "suite";
    marks.push(
      <span
        className="lb-legend-item"
        key="line"
        title={
          suite
            ? "No config beats these on both axes"
            : "No config plotted here beats these on both axes. Drawn from the shown configs, hollow ones included, so it is not the full-suite frontier."
        }
      >
        <svg width="26" height="10" viewBox="0 0 26 10" aria-hidden="true">
          <line className="frontier-line" x1="1" x2="25" y1="5" y2="5" />
        </svg>
        {suite ? "frontier" : "frontier of the shown configs"}
      </span>,
    );
  }
  if (props.anyDim) {
    marks.push(
      <span className="dim" key="dim">
        faded: outside the table track
      </span>,
    );
  }
  if (marks.length > 0) {
    groups.push({
      key: "marks",
      node: <span className="lb-legend-group">{marks}</span>,
    });
  }
  return (
    <div className="lb-legend">
      {groups.map((g, i) => (
        <Fragment key={g.key}>
          {i > 0 ? <span className="lb-legend-sep" /> : null}
          {g.node}
        </Fragment>
      ))}
    </div>
  );
}

function DotTip(props: { dot: FrontierDot; axis: FrontierAxis }): ReactNode {
  const { dot } = props;
  const p = dot.point;
  return (
    <>
      <div className="chart-tip-title">{p.configId}</div>
      <div className="chart-tip-row">
        <span>Model</span>
        <span className="chart-tip-value">{p.resolvedModel}</span>
      </div>
      <div className="chart-tip-row">
        <span>Harness</span>
        <span className="chart-tip-value">{p.harness}</span>
      </div>
      <div className="chart-tip-row">
        <span>Effort</span>
        <span className="chart-tip-value">{effortLabel(dot.efforts)}</span>
      </div>
      <div className="chart-tip-row">
        <span>Score</span>
        <span className="chart-tip-value">
          {dot.ciLo !== null && dot.ciHi !== null
            ? `${p.score.toFixed(3)} (${dot.ciLo.toFixed(2)}–${dot.ciHi.toFixed(2)})`
            : p.score.toFixed(3)}
        </span>
      </div>
      <div className="chart-tip-row">
        <span>{props.axis === "cost" ? "$/attempt" : "Agent time"}</span>
        <span className="chart-tip-value">
          {props.axis === "cost" ? fmtCost(p.avgCostUsd) : fmtDuration(p.medianAgentMs)}
        </span>
      </div>
      <div className="chart-tip-row">
        <span>n</span>
        <span className="chart-tip-value">
          {p.attempts} attempts · {p.scenarios.covered}/{p.scenarios.expected} scenarios
        </span>
      </div>
      {dot.onFrontier ? <div className="lb-tip-note tone-green">On the frontier</div> : null}
      {dot.hollowReasons.length > 0 ? (
        <div className="lb-tip-note tone-accent">Hollow: {dot.hollowReasons.join("; ")}</div>
      ) : null}
      <div className="lb-tip-note dim">Click to open its runs</div>
    </>
  );
}

function PickCard(props: {
  label: string;
  point: FrontierResponse["points"][number];
  axis: FrontierAxis;
}): ReactNode {
  const p = props.point;
  return (
    <button type="button" className="lb-pick" onClick={() => openRuns(p.configId)}>
      <span className="lb-pick-label">{props.label}</span>
      <span className="lb-pick-config">
        <ConfigChip configId={p.configId} />
      </span>
      <span className="lb-pick-stats">
        <strong>{p.score.toFixed(3)}</strong>
        <span className="dim">
          {props.axis === "cost" ? fmtCost(p.avgCostUsd) : fmtDuration(p.medianAgentMs)}
          {" · "}
          {props.axis === "cost" ? fmtDuration(p.medianAgentMs) : fmtCost(p.avgCostUsd)}
        </span>
      </span>
    </button>
  );
}

// ---- view state kept in the hash query ----

function oneOf<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === raw) ?? fallback;
}

function RankingView(): ReactNode {
  const route = useHashRoute();
  const { query } = route;
  const [suiteChoice, setSuiteChoice] = useState<string | null>(() => query.get("suite"));
  const [axis, setAxis] = useState<FrontierAxis>(() =>
    oneOf(query.get("x"), ["cost", "time"], "cost"),
  );
  const [track, setTrack] = useState<Track>(() =>
    oneOf(query.get("track"), ["fixed", "free"], "fixed"),
  );
  const [harnessChoice, setHarnessChoice] = useState<string | null>(() => query.get("harness"));

  // A real navigation (a nav link, a pasted URL) resets the view to what its query says.
  // `replaceHashQuery` below fires no hashchange, so it never loops back through here.
  useEffect(() => {
    setSuiteChoice(route.query.get("suite"));
    setAxis(oneOf<FrontierAxis>(route.query.get("x"), ["cost", "time"], "cost"));
    setTrack(oneOf<Track>(route.query.get("track"), ["fixed", "free"], "fixed"));
    setHarnessChoice(route.query.get("harness"));
  }, [route]);

  const suites = usePoll(getSuites, null, []);
  const suite = suiteChoice ?? suites.data?.current ?? null;

  const data = usePoll<[FrontierResponse, LeaderboardResponse] | null>(
    () =>
      suite === null
        ? Promise.resolve(null)
        : Promise.all([getFrontier(suite), getLeaderboard(suite)]),
    null,
    [suite],
  );

  // Keep the view shareable: suite, x axis, track and harness live in the hash query.
  useEffect(() => {
    replaceHashQuery({
      suite: suiteChoice,
      x: axis === "cost" ? null : axis,
      track: track === "fixed" ? null : track,
      harness: track === "fixed" ? harnessChoice : null,
    });
  }, [suiteChoice, axis, track, harnessChoice]);

  const frontier: FrontierResponse | null = data.data?.[0] ?? null;
  const board: LeaderboardResponse | null = data.data?.[1] ?? null;

  const harnesses = board?.tracks.fixedHarness.map((g) => g.harness) ?? [];
  const harness =
    harnessChoice !== null && harnesses.includes(harnessChoice)
      ? harnessChoice
      : board === null
        ? null
        : defaultHarness(board);

  const rows: LeaderboardRow[] = useMemo(() => {
    if (board === null) return [];
    return track === "free"
      ? board.tracks.bestHarnessPerModel.rows
      : (board.tracks.fixedHarness.find((g) => g.harness === harness)?.rows ?? []);
  }, [board, track, harness]);

  const dotsResult = useMemo(() => {
    if (frontier === null || board === null) return null;
    const built = buildFrontierDots(
      frontier,
      axis,
      effortsByConfig(board),
      trackConfigIds(board, track, harness),
    );
    const ids = axis === "cost" ? frontier.frontier.cost : frontier.frontier.time;
    const suiteLine = frontier.status === "ok" ? frontierLine(built.dots, ids) : [];
    // The full-suite frontier when the API has one to draw. Otherwise a line is
    // still drawn, from every plotted config, and the legend says it covers
    // only the shown configs.
    const line: FrontierLine =
      suiteLine.length > 1
        ? { scope: "suite", dots: suiteLine }
        : {
            scope: "shown",
            dots: paretoFrontier(
              built.dots,
              (d) => d.x,
              (d) => d.y,
            ),
          };
    return { ...built, line };
  }, [frontier, board, axis, track, harness]);

  const columns = useMemo(
    () => leaderboardColumns(board?.k ?? 3, track === "free"),
    [board?.k, track],
  );

  const header = (
    <div className="lb-head">
      <h2 className="an-title">Leaderboard</h2>
      <SuiteSelect suites={suites.data} value={suite} onChange={setSuiteChoice} />
      <div className="lb-field">
        <span className="dim">
          Track{" "}
          <InfoTip text="Fixed harness: models compared on one harness. Best harness per model: each model on the harness that scores it best." />
        </span>
        <Seg options={TRACKS} value={track} onChange={setTrack} />
      </div>
      <span className="an-meta dim" title={frontier?.generatedAt}>
        {data.loading && data.data !== null ? "updating… · " : ""}
        {frontier === null
          ? ""
          : frontier.status === "empty"
            ? `no graded attempts · generated ${fmtAgo(frontier.generatedAt)}`
            : `${frontier.points.reduce((n, p) => n + p.attempts, 0)} graded attempts · ${frontier.points.length} configs · ${frontier.expectedScenarios.length} scenarios · generated ${fmtAgo(frontier.generatedAt)}`}
      </span>
      <button type="button" className="btn" onClick={data.refresh}>
        ↻ Refresh
      </button>
    </div>
  );

  if (suite === null || data.data === null || frontier === null || board === null) {
    const err = suites.error ?? data.error;
    return (
      <>
        {header}
        {err !== null ? (
          <div className="panel an-error">Failed to load the leaderboard: {err}</div>
        ) : (
          <div className="panel">
            <Spinner label="Loading the leaderboard…" />
          </div>
        )}
      </>
    );
  }

  const picks = frontier.status === "ok" ? frontierPicks(frontier) : [];
  const dots = dotsResult?.dots ?? [];
  const line = dotsResult !== null && dotsResult.line.dots.length > 1 ? dotsResult.line : null;

  return (
    <>
      {header}
      {data.error !== null ? (
        <div className="panel an-error">Refresh failed, showing the last data: {data.error}</div>
      ) : null}

      {frontier.status !== "ok" ? (
        <div className="panel lb-banner">
          <strong>
            {frontier.status === "empty"
              ? `No graded attempts in suite ${suite} yet.`
              : frontier.status === "low-n"
                ? "Too few attempts for a frontier."
                : "No frontier yet."}
          </strong>{" "}
          {frontier.status === "empty"
            ? "Pick another suite above, or start a run of this one."
            : `${frontier.warnings.join(" ")} Hollow markers are not trusted yet.${line !== null ? " The dashed line is the frontier of the configs shown only, not a full-suite frontier." : ""}`}
        </div>
      ) : null}

      {picks.length > 0 ? (
        <div className="lb-picks">
          {picks.map((p) => (
            <PickCard key={p.label} label={p.label} point={p.point} axis={axis} />
          ))}
        </div>
      ) : null}

      {frontier.status === "empty" ? null : (
        <div className="panel">
          <div className="an-panel-head">
            <h3 className="panel-title">
              Best setups{" "}
              <InfoTip text="Each marker is one config. Up is a higher score, left is cheaper (or faster). The dashed line joins the configs nothing beats on both axes." />
            </h3>
            <div className="an-controls">
              <span className="an-seg-label dim">X axis</span>
              <Seg options={AXES} value={axis} onChange={setAxis} />
            </div>
          </div>
          <FrontierChart
            dots={dots}
            line={line?.dots ?? []}
            colorOf={(d) => harnessColor(d.harness)}
            xLabel={
              axis === "cost"
                ? "$ per attempt, log scale (lower is better)"
                : "median agent time, log scale (lower is better)"
            }
            xFormat={axis === "cost" ? fmtAxisCost : fmtAxisTime}
            xTicks={axis === "time" ? timeTicks : undefined}
            renderTip={(d) => <DotTip dot={d} axis={axis} />}
            onSelect={(d) => openRuns(d.configId)}
            emptyText={
              frontier.points.length === 0
                ? "No graded attempts to plot"
                : axis === "cost"
                  ? "No config has a price yet"
                  : "No config has a timing yet"
            }
          />
          <ChartLegend dots={dots} line={line} anyDim={dots.some((d) => d.dim)} />
          {dotsResult !== null && dotsResult.unplotted.length > 0 ? (
            <p className="dim lb-foot">
              Not plotted, no {axis === "cost" ? "price" : "timing"} yet:{" "}
              {dotsResult.unplotted.join(", ")}
            </p>
          ) : null}
        </div>
      )}

      <div className="panel">
        <div className="an-panel-head">
          <h3 className="panel-title">
            {track === "fixed" ? "Ranking, one harness" : "Ranking, best harness per model"}{" "}
            <InfoTip text="Click a row to open that config's runs." />
          </h3>
          {track === "fixed" && harnesses.length > 0 ? (
            <div className="an-controls">
              <span className="an-seg-label dim">Harness</span>
              <Seg
                options={harnesses.map((h) => ({
                  key: h,
                  label: `${h} · ${board.tracks.fixedHarness.find((g) => g.harness === h)?.rows.length ?? 0}`,
                }))}
                value={harness ?? harnesses[0] ?? ""}
                onChange={setHarnessChoice}
              />
            </div>
          ) : null}
        </div>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => `${r.harness}/${r.configId}`}
          onRowClick={(r) => openRuns(r.configId)}
          defaultSort={{ key: "rank", dir: "asc" }}
          searchable={rows.length > 10}
          searchPlaceholder="Search configs…"
          emptyText={`No graded attempts in suite ${suite} yet`}
        />
      </div>
    </>
  );
}

export type LeaderboardTab = "ranking" | "heatmap" | "reliability" | "analytics";

const TABS: readonly { key: LeaderboardTab; label: string; href: string }[] = [
  { key: "ranking", label: "Frontier & ranking", href: "#/leaderboard" },
  { key: "heatmap", label: "Scenario heatmap", href: "#/leaderboard/heatmap" },
  { key: "reliability", label: "Reliability", href: "#/leaderboard/reliability" },
  { key: "analytics", label: "Trends, cost & models", href: "#/leaderboard/analytics" },
];

/** The tab a hash path selects: `#/leaderboard/<tab>`; anything else is the ranking. */
export function leaderboardTab(parts: readonly string[]): LeaderboardTab {
  const seg = parts[0] === "analytics" ? "analytics" : parts[1];
  return TABS.find((t) => t.key === seg)?.key ?? "ranking";
}

/**
 * Home page: the Pareto chart and ranking table (Phase 5), the scenario x config
 * heatmap and the reliability view (Phase 6), and the old Analytics page kept,
 * unchanged, as the last tab.
 */
export default function LeaderboardPage(props: { tab: LeaderboardTab }): ReactNode {
  return (
    <>
      <nav className="lb-tabs" aria-label="Leaderboard views">
        {TABS.map((t) => (
          <a key={t.key} className={props.tab === t.key ? "lb-tab active" : "lb-tab"} href={t.href}>
            {t.label}
          </a>
        ))}
      </nav>
      {props.tab === "analytics" ? (
        <AnalyticsPage />
      ) : props.tab === "heatmap" ? (
        <HeatmapView />
      ) : props.tab === "reliability" ? (
        <ReliabilityView />
      ) : (
        <RankingView />
      )}
    </>
  );
}

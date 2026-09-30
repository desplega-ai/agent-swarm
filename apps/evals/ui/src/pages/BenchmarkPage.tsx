import { type ReactNode, useEffect, useMemo, useState } from "react";
import { getStoredApiKey } from "../api.ts";
import { colorForGroup } from "../components/charts/chart-utils.ts";
import { FrontierChart } from "../components/charts/FrontierChart.tsx";
import { fmtCost, fmtDuration } from "../components/format.ts";
import { Markdown } from "../components/Markdown.tsx";
import { Seg } from "../components/Seg.tsx";
import { Spinner } from "../components/Spinner.tsx";
import {
  type BenchmarkIndex,
  type BenchmarkSnapshot,
  getBenchmarkIndex,
  getBenchmarkSnapshot,
  type PublishedScenario,
  SUPPORTED_SNAPSHOT_SCHEMA,
  type SwarmSoloComparison,
} from "../lib/benchmark.ts";
import {
  buildFrontierDots,
  effortsByConfig,
  type FrontierAxis,
  type FrontierDot,
  frontierLine,
  timeTicks,
} from "../lib/suite-analytics.ts";
import "./benchmark.css";

/**
 * Public benchmark page (`/benchmark`, no login). Renders one frozen snapshot
 * written by `bun src/cli.ts publish`: Pareto chart, ranking, swarm vs solo,
 * scenario cards, disclosure and methodology. Never calls an authenticated API.
 * The version lives in `?v=`; the newest published version is the default.
 */

const HARNESS_HUES: Record<string, string> = {
  claude: "var(--orange)",
  codex: "var(--blue)",
  pi: "var(--green)",
  opencode: "var(--yellow)",
};

const AXES: readonly { key: FrontierAxis; label: string; title: string }[] = [
  { key: "cost", label: "Cost", title: "Mean agent $ per attempt (judge cost excluded)" },
  { key: "time", label: "Agent time", title: "Median agent time, sandbox boot excluded" },
];

const KIND_LABEL: Record<PublishedScenario["kind"], string> = {
  "single-agent": "single agent",
  swarm: "swarm",
  "solo-baseline": "solo baseline",
};

function harnessColor(harness: string): string {
  return colorForGroup(harness, HARNESS_HUES);
}

function fmtScore(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toFixed(2);
}

function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}

function fmtSigned(v: number, digits = 2): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
}

function fmtAxisCost(v: number): string {
  return v >= 1 ? `$${v}` : `$${Number(v.toPrecision(2))}`;
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

function readVersionParam(): string | null {
  return new URLSearchParams(window.location.search).get("v");
}

function DotTip({ dot, axis }: { dot: FrontierDot; axis: FrontierAxis }): ReactNode {
  const p = dot.point;
  return (
    <div className="bm-tip">
      <strong>{p.configId}</strong>
      <div className="dim">
        {p.harness} · {p.resolvedModel}
      </div>
      <div>
        score {fmtScore(p.score)} [{fmtScore(p.scoreCi.lo)}, {fmtScore(p.scoreCi.hi)}]
      </div>
      <div>
        {axis === "cost" ? `${fmtCost(p.avgCostUsd)} / attempt` : fmtDuration(p.medianAgentMs)}
      </div>
      <div className="dim">{p.attempts} graded attempts</div>
    </div>
  );
}

function ParetoSection({ snapshot }: { snapshot: BenchmarkSnapshot }): ReactNode {
  const [axis, setAxis] = useState<FrontierAxis>("cost");
  const { frontier, leaderboard } = snapshot;
  const chart = useMemo(() => {
    const built = buildFrontierDots(frontier, axis, effortsByConfig(leaderboard), null);
    const ids = axis === "cost" ? frontier.frontier.cost : frontier.frontier.time;
    return { ...built, line: frontierLine(built.dots, ids) };
  }, [frontier, leaderboard, axis]);
  const harnesses = [...new Set(frontier.points.map((p) => p.harness))].sort();
  return (
    <section className="panel bm-section" id="pareto">
      <div className="bm-section-head">
        <h2>Score vs {axis === "cost" ? "cost" : "agent time"}</h2>
        <Seg options={AXES} value={axis} onChange={setAxis} />
      </div>
      <p className="dim bm-lede">
        Higher is better on score, lower is better on the x axis. The dashed line joins the setups
        no other setup beats on both. Whiskers are 95% bootstrap intervals.
      </p>
      <FrontierChart
        dots={chart.dots}
        line={chart.line}
        colorOf={(d) => harnessColor(d.harness)}
        xLabel={
          axis === "cost"
            ? "$ per attempt, log scale (lower is better)"
            : "median agent time, log scale (lower is better)"
        }
        xFormat={axis === "cost" ? fmtAxisCost : fmtDuration}
        xTicks={axis === "time" ? timeTicks : undefined}
        renderTip={(d) => <DotTip dot={d} axis={axis} />}
        emptyText="No config has a reading on this axis"
      />
      <div className="bm-legend">
        {harnesses.map((h) => (
          <span key={h} className="bm-legend-item">
            <span className="bm-swatch" style={{ background: harnessColor(h) }} />
            {h}
          </span>
        ))}
      </div>
    </section>
  );
}

function LeaderboardSection({ snapshot }: { snapshot: BenchmarkSnapshot }): ReactNode {
  const { leaderboard } = snapshot;
  const rows = leaderboard.tracks.bestHarnessPerModel.rows;
  return (
    <section className="panel bm-section" id="leaderboard">
      <div className="bm-section-head">
        <h2>Leaderboard</h2>
      </div>
      <p className="dim bm-lede">
        Each model on the harness that scores it best. Score is the mean of per-scenario means; the
        rank range is its 95% bootstrap spread, so overlapping ranges are a tie.
      </p>
      <table className="data bm-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Config</th>
            <th>Model</th>
            <th className="num">Score</th>
            <th className="num">pass@1</th>
            <th className="num">pass^{leaderboard.k}</th>
            <th className="num">$ / attempt</th>
            <th className="num">Agent time</th>
            <th className="num">Attempts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.configId}>
              <td>
                {r.rank ?? "—"}
                {r.rankSpread && r.rankSpread.lo !== r.rankSpread.hi ? (
                  <span className="dim bm-spread">
                    {" "}
                    ({r.rankSpread.lo}-{r.rankSpread.hi})
                  </span>
                ) : null}
              </td>
              <td>
                <span className="bm-swatch" style={{ background: harnessColor(r.harness) }} />
                <span className="mono">{r.configId}</span>
              </td>
              <td className="mono dim">{r.resolvedModel}</td>
              <td className="num">
                {fmtScore(r.score)}
                {r.scoreCi ? (
                  <span className="dim bm-ci">
                    {" "}
                    [{fmtScore(r.scoreCi.lo)}, {fmtScore(r.scoreCi.hi)}]
                  </span>
                ) : null}
              </td>
              <td className="num">{fmtPct(r.passAt1)}</td>
              <td className="num">{fmtPct(r.passPowK)}</td>
              <td className="num">{fmtCost(r.avgCostUsd)}</td>
              <td className="num">{fmtDuration(r.medianAgentMs)}</td>
              <td className="num">{r.attempts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SwarmSoloSection({ snapshot }: { snapshot: BenchmarkSnapshot }): ReactNode {
  const byScenario = new Map<string, SwarmSoloComparison[]>();
  for (const c of snapshot.swarmVsSolo) {
    byScenario.set(c.swarmId, [...(byScenario.get(c.swarmId) ?? []), c]);
  }
  if (byScenario.size === 0) return null;
  const names = new Map(snapshot.scenarios.map((s) => [s.id, s.name]));
  return (
    <section className="panel bm-section" id="swarm-vs-solo">
      <div className="bm-section-head">
        <h2>Swarm vs solo</h2>
      </div>
      <p className="dim bm-lede">
        The same brief handed to a lead and its workers, and to one worker alone at the same budget.
        Δscore is on the dimensions both rubrics share; a negative value means the swarm did worse.
        Bold deltas have a 95% interval that excludes zero.
      </p>
      <table className="data bm-table">
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Config</th>
            <th className="num">Swarm</th>
            <th className="num">Solo</th>
            <th className="num">Δscore</th>
            <th className="num">Tokens</th>
            <th className="num">Δagent time</th>
          </tr>
        </thead>
        <tbody>
          {[...byScenario.entries()].flatMap(([swarmId, list]) =>
            list.map((c, i) => (
              <tr key={`${swarmId}-${c.configId}`}>
                <td>{i === 0 ? (names.get(swarmId) ?? swarmId) : ""}</td>
                <td className="mono">{c.configId}</td>
                <td className="num">{fmtScore(c.swarm.meanScore)}</td>
                <td className="num">{fmtScore(c.solo.meanScore)}</td>
                <td className={`num ${c.deltaScore?.significant ? "bm-sig" : ""}`}>
                  {c.deltaScore ? (
                    <>
                      {fmtSigned(c.deltaScore.diff)}
                      <span className="dim bm-ci">
                        {" "}
                        [{fmtSigned(c.deltaScore.lo)}, {fmtSigned(c.deltaScore.hi)}]
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="num">
                  {c.tokenMultiple === null ? "—" : `×${c.tokenMultiple.toFixed(1)}`}
                </td>
                <td className="num">
                  {c.deltaAgentMs === null
                    ? "—"
                    : `${c.deltaAgentMs >= 0 ? "+" : "−"}${fmtDuration(Math.abs(c.deltaAgentMs))}`}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </section>
  );
}

function ScenariosSection({ snapshot }: { snapshot: BenchmarkSnapshot }): ReactNode {
  return (
    <section className="panel bm-section" id="scenarios">
      <div className="bm-section-head">
        <h2>Scenarios</h2>
      </div>
      <p className="dim bm-lede">
        {snapshot.scenarios.length} public scenarios. {snapshot.heldOutCount} more are run and
        scored but kept private, so tuning to the public set shows up as a gap.
      </p>
      <div className="bm-cards">
        {snapshot.scenarios.map((s) => (
          <article key={s.id} className="bm-card">
            <header>
              <strong>{s.name}</strong>
              <span className={`bm-kind bm-kind-${s.kind}`}>{KIND_LABEL[s.kind]}</span>
            </header>
            <div className="mono dim">
              {s.id} v{s.version}
            </div>
            {s.description ? <p>{s.description}</p> : null}
            <div className="dim bm-card-meta">
              {s.hasLead ? "lead + " : ""}
              {s.workers} worker{s.workers === 1 ? "" : "s"}
              {s.budgetUsd !== null ? ` · budget ${fmtCost(s.budgetUsd)}` : ""}
              {s.timeoutMs !== null ? ` · timeout ${fmtDuration(s.timeoutMs)}` : ""}
            </div>
            <div className="bm-dims">
              {s.dimensions.map((d) => (
                <span key={d.name} title={d.judge?.rubric ?? d.checks.join(", ")}>
                  {d.name} ×{d.weight}
                  {d.judge ? " · judged" : ""}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DisclosureSection({ snapshot }: { snapshot: BenchmarkSnapshot }): ReactNode {
  const { run } = snapshot;
  return (
    <section className="panel bm-section" id="disclosure">
      <div className="bm-section-head">
        <h2>Disclosure</h2>
      </div>
      <dl className="bm-facts">
        <dt>Run</dt>
        <dd className="mono">
          {run.id} · {fmtDay(run.createdAt)} · {run.attemptsPerCell} attempts per cell
        </dd>
        <dt>Judge</dt>
        <dd className="mono">{run.judgeModel}</dd>
        <dt>Harness commit</dt>
        <dd className="mono">{run.harnessCommit ?? "not recorded"}</dd>
      </dl>
      <table className="data bm-table">
        <thead>
          <tr>
            <th>Config</th>
            <th>Harness</th>
            <th>Pinned</th>
            <th>Ran on</th>
            <th>Effort</th>
            <th>Swarm version</th>
            <th>E2B templates</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.configs.map((c) => (
            <tr key={c.configId}>
              <td className="mono">{c.configId}</td>
              <td>{c.harness}</td>
              <td className="mono dim">{c.model ?? c.modelAlias ?? "—"}</td>
              <td className="mono dim">{c.resolvedModels.join(", ") || "—"}</td>
              <td>{c.reasoningEffort ?? "default"}</td>
              <td className="mono dim">
                {[...new Set([...c.apiVersions, ...c.workerVersions])].join(", ") || "—"}
              </td>
              <td className="mono dim">{c.e2bTemplates.join(", ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function PublicHeader(props: {
  index: BenchmarkIndex | null;
  version: string | null;
  onVersion: (v: string) => void;
}): ReactNode {
  const versions = props.index?.versions ?? [];
  // Logged in = the evals app has a stored key; anonymous visitors see no link.
  const [loggedIn] = useState(() => getStoredApiKey() !== null);
  return (
    <header className="app-header bm-header">
      <a className="brand" href="/benchmark">
        <img src="/logo.png" width={22} height={22} alt="swarm logo" />
        <span className="wordmark">
          swarm <span className="accent">evals</span> benchmark
        </span>
      </a>
      <nav className="bm-nav">
        <a href="#pareto">Pareto</a>
        <a href="#leaderboard">Leaderboard</a>
        <a href="#swarm-vs-solo">Swarm vs solo</a>
        <a href="#scenarios">Scenarios</a>
        <a href="#methodology">Methodology</a>
      </nav>
      {versions.length > 0 ? (
        <label className="bm-version">
          <span className="dim">version</span>
          <select value={props.version ?? ""} onChange={(e) => props.onVersion(e.target.value)}>
            {versions.map((v) => (
              <option key={v.suiteVersion} value={v.suiteVersion}>
                v{v.suiteVersion}
                {v.publishedAt ? ` · ${fmtDay(v.publishedAt)}` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {loggedIn ? (
        <a className="bm-app-link" href="/#/leaderboard">
          ← Back to evals
        </a>
      ) : null}
    </header>
  );
}

/** Methodology source of truth; linked from the empty state, before any snapshot exists. */
const METHODOLOGY_URL =
  "https://github.com/desplega-ai/agent-swarm/blob/main/apps/evals/docs/methodology.md";

export default function BenchmarkPage(): ReactNode {
  const [index, setIndex] = useState<BenchmarkIndex | null>(null);
  const [version, setVersion] = useState<string | null>(readVersionParam);
  const [snapshot, setSnapshot] = useState<BenchmarkSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBenchmarkIndex()
      .then((idx) => {
        setIndex(idx);
        setVersion((v) => v ?? idx.latest);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!version) return;
    setSnapshot(null);
    getBenchmarkSnapshot(version)
      .then(setSnapshot)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [version]);

  const pickVersion = (v: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("v", v);
    window.history.replaceState(null, "", url);
    setError(null);
    setVersion(v);
  };

  let body: ReactNode;
  if (error) {
    body = <p className="bm-empty">Could not load the benchmark: {error}</p>;
  } else if (index !== null && index.versions.length === 0) {
    body = (
      <p className="bm-empty">
        No benchmark has been published yet.{" "}
        <a href={METHODOLOGY_URL} target="_blank" rel="noopener">
          Read how the benchmark is run ↗
        </a>
      </p>
    );
  } else if (snapshot === null) {
    body = <Spinner label="loading benchmark" />;
  } else if (snapshot.schema > SUPPORTED_SNAPSHOT_SCHEMA) {
    body = (
      <p className="bm-empty">
        This snapshot uses a newer format (schema {snapshot.schema}) than this page reads.
      </p>
    );
  } else {
    body = (
      <>
        <section className="bm-hero">
          <h1>
            {snapshot.suite.id} <span className="accent">v{snapshot.suite.version}</span>
          </h1>
          <p>
            {snapshot.configs.length} setups × {snapshot.scenarios.length} public scenarios, at
            least {snapshot.minAttemptsPerCell} graded attempts per cell, on persistent lead and
            worker agents doing real swarm work: delegation, recovery, review and asking a human.
          </p>
          <p className="dim">
            Published {fmtDay(snapshot.publishedAt)} from one frozen run. Pass line{" "}
            {snapshot.passThreshold}.
          </p>
        </section>
        <ParetoSection snapshot={snapshot} />
        <LeaderboardSection snapshot={snapshot} />
        <SwarmSoloSection snapshot={snapshot} />
        <ScenariosSection snapshot={snapshot} />
        <DisclosureSection snapshot={snapshot} />
        <section className="panel bm-section" id="limitations">
          <div className="bm-section-head">
            <h2>Limitations</h2>
          </div>
          <ul className="bm-limits">
            {snapshot.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>
        <section className="panel bm-section bm-methodology" id="methodology">
          <Markdown text={snapshot.methodology} />
        </section>
        <footer className="bm-canary dim mono">{snapshot.canary}</footer>
      </>
    );
  }

  return (
    <>
      <PublicHeader index={index} version={version} onVersion={pickVersion} />
      <main className="app-main bm-main">{body}</main>
    </>
  );
}

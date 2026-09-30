import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { getCell, getHeatmap, getSuites, listScenarios } from "../api.ts";
import { ConfigChip } from "../components/ConfigChip.tsx";
import { type Column, DataTable } from "../components/DataTable.tsx";
import { EntityLink } from "../components/EntityLink.tsx";
import { fmtAgo, fmtCost, fmtDuration } from "../components/format.ts";
import { Spinner } from "../components/Spinner.tsx";
import { StatusScore } from "../components/StatusBadge.tsx";
import { SuiteSelect } from "../components/SuiteSelect.tsx";
import { InfoTip, Tooltip } from "../components/Tooltip.tsx";
import { navigate, replaceHashQuery, useHashRoute, usePoll } from "../hooks.ts";
import {
  type CellAttempt,
  type CellResponse,
  cellKey,
  HEALTH_TEXT,
  type HeatmapCell,
  type HeatmapResponse,
  heatmapIndex,
  passRateColor,
  type ScenarioHealth,
  scenarioHealth,
} from "../lib/suite-analytics.ts";
import type { ScenarioJson } from "../types.ts";
import "./heatmap.css";

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/** Break a scenario id at its hyphens so a narrow column wraps on word edges. */
function breakable(id: string): ReactNode {
  return id.split("-").map((part, i, all) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: static split of a fixed id
    <Fragment key={i}>
      {part}
      {i < all.length - 1 ? (
        <>
          -<wbr />
        </>
      ) : null}
    </Fragment>
  ));
}

function cellTitle(cell: HeatmapCell | undefined, scenarioId: string, configId: string): string {
  if (cell === undefined) return `${scenarioId} on ${configId}: no attempts in this suite yet`;
  const parts = [
    cell.graded === 0
      ? "no graded attempts"
      : `${cell.passed} of ${cell.graded} passed (${pct(cell.passRate)})`,
  ];
  if (cell.avgScore !== null) parts.push(`mean score ${cell.avgScore.toFixed(2)}`);
  if (cell.errors > 0) parts.push(`${cell.errors} errored, not scored`);
  if (cell.lowN && cell.graded > 0) parts.push("low n: fewer than 3 graded attempts");
  return `${scenarioId} on ${configId}: ${parts.join(", ")}. Click to list its attempts.`;
}

function HealthFlag(props: { health: ScenarioHealth }): ReactNode {
  if (props.health !== "broken-or-hard" && props.health !== "saturated") return null;
  return (
    <Tooltip text={HEALTH_TEXT[props.health]}>
      <span className={`hm-flag hm-flag-${props.health}`}>
        {props.health === "saturated" ? "saturated" : "broken or hard"}
      </span>
    </Tooltip>
  );
}

function Legend(): ReactNode {
  const stops = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="hm-legend">
      <span className="hm-legend-scale" aria-hidden="true">
        {stops.map((t) => (
          <span key={t} style={{ background: passRateColor(t) }} />
        ))}
      </span>
      <span className="dim">pass rate, 0% to 100%</span>
      <span className="hm-legend-item">
        <span className="hm-swatch hm-swatch-lown" aria-hidden="true" /> low n (under 3 graded)
      </span>
      <span className="hm-legend-item">
        <span className="hm-err-badge" aria-hidden="true">
          ⚠
        </span>{" "}
        errored attempts, not scored
      </span>
      <span className="dim">
        A column that is all red is broken or too hard; one that is all green no longer separates
        setups.
      </span>
    </div>
  );
}

// ---- the cell's attempts ----

function attemptColumns(): Column<CellAttempt>[] {
  return [
    {
      key: "run",
      header: "Run",
      searchText: (a) => `${a.runName ?? ""} ${a.runId}`,
      sortValue: (a) => a.runCreatedAt,
      render: (a) => (
        <span className="hm-run">
          <EntityLink kind="run" id={a.runId} label={a.runName ?? undefined} />
          <span className="dim"> · {fmtAgo(a.runCreatedAt)}</span>
        </span>
      ),
    },
    {
      key: "index",
      header: "#",
      width: "44px",
      align: "right",
      sortValue: (a) => a.attemptIndex,
      render: (a) => a.attemptIndex,
    },
    {
      key: "result",
      header: "Result",
      width: "150px",
      sortValue: (a) => (a.status === "error" ? -1 : (a.score ?? 0)),
      render: (a) =>
        a.status === "error" ? (
          <Tooltip
            text={
              a.error
                ? `Errored, not scored.\n${a.error}`
                : "Errored, not scored. The harness or sandbox failed."
            }
          >
            <span className="hm-errored">⚠ errored, not scored</span>
          </Tooltip>
        ) : (
          <StatusScore status={a.status} score={a.score} />
        ),
    },
    {
      key: "cost",
      header: "Cost",
      width: "84px",
      align: "right",
      sortValue: (a) => a.costUsd,
      render: (a) => fmtCost(a.costUsd),
    },
    {
      key: "time",
      header: "Agent time",
      width: "92px",
      align: "right",
      headerTip: "Time the agent worked, sandbox boot excluded",
      sortValue: (a) => a.agentMs,
      render: (a) => fmtDuration(a.agentMs),
    },
    {
      key: "open",
      header: "Attempt",
      width: "86px",
      sortable: false,
      render: (a) => <EntityLink kind="attempt" id={a.id} runId={a.runId} label="Open →" />,
    },
  ];
}

function CellPanel(props: {
  suite: string;
  scenarioId: string;
  configId: string;
  onClose: () => void;
}): ReactNode {
  const { suite, scenarioId, configId } = props;
  const cell = usePoll<CellResponse>(() => getCell(suite, scenarioId, configId), null, [
    suite,
    scenarioId,
    configId,
  ]);
  const columns = useMemo(() => attemptColumns(), []);
  const data = cell.data;
  return (
    <div className="panel hm-cell">
      <div className="an-panel-head">
        <h3 className="panel-title">
          <EntityLink kind="scenario" id={scenarioId} /> <span className="dim">on</span>{" "}
          <ConfigChip configId={configId} link effort={null} />
        </h3>
        <button type="button" className="btn" onClick={props.onClose}>
          Close
        </button>
      </div>
      {cell.error !== null ? <div className="an-error">Failed to load: {cell.error}</div> : null}
      {data === null && cell.error === null ? <Spinner label="Loading attempts…" /> : null}
      {data !== null ? (
        <>
          <p className="hm-cell-sum">
            <strong>
              {data.passed} of {data.graded}
            </strong>{" "}
            graded attempts passed in suite {data.suiteVersion}
            {data.failed > 0 ? `, ${data.failed} failed` : ""}
            {data.errors > 0 ? (
              <span className="hm-errored">
                {" "}
                · {data.errors} errored, not scored{" "}
                <InfoTip text="A harness or sandbox fault, not a wrong answer. Errored attempts are left out of scores and pass rates." />
              </span>
            ) : null}
            {data.truncated ? <span className="dim"> · newest 100 shown</span> : null}
          </p>
          <DataTable
            rows={data.attempts}
            columns={columns}
            rowKey={(a) => a.id}
            onRowClick={(a) => navigate(`#/runs/${a.runId}/attempts/${a.id}`)}
            searchable={false}
            emptyText="No attempts in this cell"
          />
        </>
      ) : null}
    </div>
  );
}

// ---- the grid ----

function Grid(props: {
  heat: HeatmapResponse;
  scenarios: Map<string, ScenarioJson>;
  selected: { scenarioId: string; configId: string } | null;
  onPick: (scenarioId: string, configId: string) => void;
}): ReactNode {
  const { heat, scenarios, selected } = props;
  const index = useMemo(() => heatmapIndex(heat), [heat]);
  const anyById = useMemo(() => new Map(heat.anyConfig.map((r) => [r.scenarioId, r])), [heat]);
  return (
    <div className="hm-scroll">
      <table className="hm-table">
        <thead>
          <tr>
            <th className="hm-corner" scope="col">
              Config
            </th>
            {heat.scenarioIds.map((id) => {
              const s = scenarios.get(id);
              const summary = s?.card?.summary ?? s?.description ?? id;
              return (
                <th className="hm-col" scope="col" key={id}>
                  <Tooltip text={summary}>
                    <a className="hm-col-name" href={`#/scenarios/${id}`}>
                      {breakable(id)}
                    </a>
                  </Tooltip>
                  <HealthFlag health={scenarioHealth(anyById.get(id))} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          <tr className="hm-any">
            <th className="hm-row" scope="row">
              <span className="hm-any-label">Any config</span>
              <InfoTip text="Every graded attempt of the scenario, pooled over all configs. The small line counts the configs with at least one pass." />
            </th>
            {heat.scenarioIds.map((id) => {
              const row = anyById.get(id);
              const rate = row?.passRate ?? null;
              return (
                <td
                  key={id}
                  className="hm-cell-td hm-any-cell"
                  style={{ background: passRateColor(rate) }}
                  title={
                    row === undefined || row.graded === 0
                      ? "No graded attempts"
                      : `${row.passed} of ${row.graded} attempts passed, ${row.configsPassing} of ${row.configs} configs pass at least once`
                  }
                >
                  {row === undefined || row.graded === 0 ? (
                    <span className="dim">·</span>
                  ) : (
                    <>
                      <span className="hm-frac">{pct(rate)}</span>
                      <span className="hm-sub">
                        {row.configsPassing}/{row.configs} configs
                      </span>
                    </>
                  )}
                </td>
              );
            })}
          </tr>
          {heat.configIds.map((configId) => (
            <tr key={configId}>
              <th className="hm-row" scope="row">
                <ConfigChip configId={configId} effort={null} />
              </th>
              {heat.scenarioIds.map((scenarioId) => {
                const cell = index.get(cellKey(scenarioId, configId));
                const isSel = selected?.scenarioId === scenarioId && selected.configId === configId;
                const cls = [
                  "hm-btn",
                  cell?.lowN && cell.graded > 0 ? "lown" : "",
                  isSel ? "selected" : "",
                  cell === undefined ? "empty" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <td className="hm-cell-td" key={scenarioId}>
                    <button
                      type="button"
                      className={cls}
                      style={{ background: passRateColor(cell?.passRate ?? null) }}
                      title={cellTitle(cell, scenarioId, configId)}
                      aria-label={cellTitle(cell, scenarioId, configId)}
                      aria-pressed={isSel}
                      disabled={cell === undefined}
                      onClick={() => props.onPick(scenarioId, configId)}
                    >
                      {cell === undefined ? (
                        <span className="dim">·</span>
                      ) : (
                        <>
                          <span className="hm-frac">
                            {cell.graded === 0 ? "—" : `${cell.passed}/${cell.graded}`}
                          </span>
                          {cell.errors > 0 ? (
                            <span className="hm-err-badge">⚠{cell.errors}</span>
                          ) : null}
                        </>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Scenario x config heatmap (Phase 6): one cell per pair, coloured by pass rate,
 * with an "any config" row on top. A column that is all red is a scenario that is
 * broken or too hard; all green is saturated. A cell opens the attempts behind it,
 * and each attempt opens its run and transcript.
 */
export default function HeatmapView(): ReactNode {
  const route = useHashRoute();
  const { query } = route;
  const [suiteChoice, setSuiteChoice] = useState<string | null>(() => query.get("suite"));
  const [picked, setPicked] = useState<{ scenarioId: string; configId: string } | null>(() => {
    const s = query.get("scenario");
    const c = query.get("config");
    return s && c ? { scenarioId: s, configId: c } : null;
  });

  useEffect(() => {
    setSuiteChoice(route.query.get("suite"));
    const s = route.query.get("scenario");
    const c = route.query.get("config");
    setPicked(s && c ? { scenarioId: s, configId: c } : null);
  }, [route]);

  const suites = usePoll(getSuites, null, []);
  const suite = suiteChoice ?? suites.data?.current ?? null;
  const heat = usePoll<HeatmapResponse | null>(
    () => (suite === null ? Promise.resolve(null) : getHeatmap(suite)),
    null,
    [suite],
  );
  const scenarioList = usePoll(listScenarios, null, []);
  const scenarios = useMemo(
    () => new Map((scenarioList.data ?? []).map((s) => [s.id, s])),
    [scenarioList.data],
  );

  useEffect(() => {
    replaceHashQuery({
      suite: suiteChoice,
      scenario: picked?.scenarioId ?? null,
      config: picked?.configId ?? null,
    });
  }, [suiteChoice, picked]);

  const data = heat.data;
  const attempts = data === null ? 0 : data.cells.reduce((n, c) => n + c.graded, 0);
  const err = suites.error ?? heat.error;

  return (
    <>
      <div className="lb-head">
        <h2 className="an-title">Heatmap</h2>
        <SuiteSelect
          suites={suites.data}
          value={suite}
          onChange={(v) => {
            setSuiteChoice(v);
            setPicked(null);
          }}
        />
        <span className="an-meta dim" title={data?.generatedAt}>
          {data === null
            ? ""
            : `${attempts} graded attempts · ${data.configIds.length} configs · ${data.scenarioIds.length} scenarios · generated ${fmtAgo(data.generatedAt)}`}
        </span>
        <button type="button" className="btn" onClick={heat.refresh}>
          ↻ Refresh
        </button>
      </div>
      {err !== null && data === null ? (
        <div className="panel an-error">Failed to load the heatmap: {err}</div>
      ) : data === null ? (
        <div className="panel">
          <Spinner label="Loading the heatmap…" />
        </div>
      ) : data.configIds.length === 0 ? (
        <div className="panel lb-banner">
          <strong>No graded attempts in suite {data.suiteVersion} yet.</strong> Pick another suite
          above, or start a run of this one.
        </div>
      ) : (
        <div className="panel">
          <div className="an-panel-head">
            <h3 className="panel-title">
              Pass rate by scenario and config{" "}
              <InfoTip text="Each cell is passed over graded attempts. Click one to list its attempts, then open one to read its transcript. Errored attempts are counted apart and never lower a rate." />
            </h3>
          </div>
          <Grid
            heat={data}
            scenarios={scenarios}
            selected={picked}
            onPick={(scenarioId, configId) =>
              setPicked((cur) =>
                cur?.scenarioId === scenarioId && cur.configId === configId
                  ? null
                  : { scenarioId, configId },
              )
            }
          />
          <Legend />
        </div>
      )}
      {picked !== null && suite !== null ? (
        <CellPanel
          suite={suite}
          scenarioId={picked.scenarioId}
          configId={picked.configId}
          onClose={() => setPicked(null)}
        />
      ) : null}
    </>
  );
}

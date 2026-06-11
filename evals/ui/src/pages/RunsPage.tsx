import { type ReactNode, useMemo, useState } from "react";
import { cancelRun, getModels, getRun, listRuns, resumeRun } from "../api.ts";
import { type Column, DataTable } from "../components/DataTable.tsx";
import { EntityLink } from "../components/EntityLink.tsx";
import { fmtAgo, fmtCost, fmtDate, fmtDuration } from "../components/format.ts";
import { Matrix } from "../components/Matrix.tsx";
import { Elapsed, PulseDot, Spinner } from "../components/Spinner.tsx";
import { CostBadge, StatusBadge } from "../components/StatusBadge.tsx";
import { InfoTip } from "../components/Tooltip.tsx";
import { navigate, usePoll } from "../hooks.ts";
import type { CellJson, RunListItem } from "../types.ts";
import { NewRunDialog } from "./NewRunDialog.tsx";
import "./runs.css";

function distinct(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function runLabel(item: RunListItem): string {
  return item.run.name ?? item.run.id.replace(/^run-/, "");
}

const RUN_COLUMNS: Column<RunListItem>[] = [
  {
    key: "run",
    header: "run",
    searchText: (r) => `${r.run.id} ${r.run.name ?? ""}`,
    sortValue: (r) => runLabel(r),
    render: (r) => runLabel(r),
  },
  {
    key: "status",
    header: "status",
    width: "90px",
    filterOptions: (rows) => {
      const opts = distinct(rows.map((r) => r.run.status));
      if (rows.some((r) => r.active)) opts.push("active");
      return opts;
    },
    filterValue: (r) => (r.active ? [r.run.status, "active"] : [r.run.status]),
    sortValue: (r) => r.run.status,
    render: (r) => (
      <span className="status-cell">
        <StatusBadge status={r.run.status} />
        {r.active && r.run.status !== "running" ? <PulseDot /> : null}
      </span>
    ),
  },
  {
    key: "scenarios",
    header: "scenarios",
    align: "center",
    width: "70px",
    filterOptions: (rows) => distinct(rows.flatMap((r) => r.run.scenarioIds)),
    filterValue: (r) => r.run.scenarioIds,
    searchText: (r) => r.run.scenarioIds.join(" "),
    sortValue: (r) => r.run.scenarioIds.length,
    render: (r) => <span title={r.run.scenarioIds.join(", ")}>{r.run.scenarioIds.length}</span>,
  },
  {
    key: "configs",
    header: "configs",
    align: "center",
    width: "60px",
    filterOptions: (rows) => distinct(rows.flatMap((r) => r.run.configIds)),
    filterValue: (r) => r.run.configIds,
    searchText: (r) => r.run.configIds.join(" "),
    sortValue: (r) => r.run.configIds.length,
    render: (r) => <span title={r.run.configIds.join(", ")}>{r.run.configIds.length}</span>,
  },
  {
    key: "cells",
    header: "cells",
    align: "center",
    width: "60px",
    sortValue: (r) => (r.totals.totalCells > 0 ? r.totals.passedCells / r.totals.totalCells : null),
    render: (r) => `${r.totals.passedCells}/${r.totals.totalCells}`,
  },
  {
    key: "cost",
    header: "cost",
    align: "right",
    width: "75px",
    sortValue: (r) => r.totals.totalCostUsd,
    render: (r) => fmtCost(r.totals.totalCostUsd),
  },
  {
    key: "created",
    header: "created",
    align: "right",
    width: "85px",
    sortValue: (r) => r.run.createdAt,
    render: (r) => <span title={r.run.createdAt}>{fmtAgo(r.run.createdAt)}</span>,
  },
];

interface BreakdownRow {
  id: string;
  passed: number;
  cells: number;
  costUsd: number | null;
  avgDurationMs: number | null;
}

function aggregateBy(
  ids: string[],
  cells: CellJson[],
  key: "scenarioId" | "configId",
): BreakdownRow[] {
  return ids.map((id) => {
    const mine = cells.filter((c) => c[key] === id);
    const costs = mine.map((c) => c.totalCostUsd).filter((v): v is number => v !== null);
    const durations = mine.map((c) => c.avgDurationMs).filter((v): v is number => v !== null);
    return {
      id,
      passed: mine.filter((c) => c.passedAny).length,
      cells: mine.length,
      costUsd: costs.length > 0 ? costs.reduce((s, v) => s + v, 0) : null,
      avgDurationMs:
        durations.length > 0 ? durations.reduce((s, v) => s + v, 0) / durations.length : null,
    };
  });
}

function breakdownColumns(kind: "scenario" | "config"): Column<BreakdownRow>[] {
  return [
    {
      key: "id",
      header: kind,
      sortValue: (r) => r.id,
      render: (r) => <EntityLink kind={kind} id={r.id} />,
    },
    {
      key: "pass",
      header: "pass",
      align: "right",
      width: "60px",
      sortValue: (r) => (r.cells > 0 ? r.passed / r.cells : null),
      render: (r) => `${r.passed}/${r.cells}`,
    },
    {
      key: "cost",
      header: "cost",
      align: "right",
      width: "75px",
      sortValue: (r) => r.costUsd,
      render: (r) => fmtCost(r.costUsd),
    },
    {
      key: "duration",
      header: "avg time",
      align: "right",
      width: "75px",
      sortValue: (r) => r.avgDurationMs,
      render: (r) => fmtDuration(r.avgDurationMs),
    },
  ];
}

const SCENARIO_COLUMNS = breakdownColumns("scenario");
const CONFIG_COLUMNS = breakdownColumns("config");

function Meta(props: { label: string; title?: string; children: ReactNode }): ReactNode {
  return (
    <div title={props.title}>
      <div className="meta-label">{props.label}</div>
      <div className="meta-value">{props.children}</div>
    </div>
  );
}

function RunDetailPane(props: {
  item: RunListItem;
  defaultJudgeModel: string | null;
  onChanged: () => void;
}): ReactNode {
  const id = props.item.run.id;
  const detail = usePoll(() => getRun(id), 4000, [id]);
  const [busy, setBusy] = useState<"cancel" | "resume" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = detail.data?.run ?? props.item.run;
  const cells = detail.data?.cells ?? props.item.cells;
  const totals = detail.data?.totals ?? props.item.totals;
  const active = detail.data?.active ?? props.item.active;
  const attempts = detail.data?.attempts;

  const canResume =
    !active &&
    (attempts ?? []).some(
      (a) =>
        a.status === "pending" ||
        a.status === "running" ||
        a.status === "judging" ||
        a.status === "error",
    );

  const act = async (kind: "cancel" | "resume") => {
    if (kind === "cancel" && !window.confirm("cancel this run?")) return;
    setBusy(kind);
    setActionError(null);
    try {
      if (kind === "cancel") await cancelRun(run.id);
      else await resumeRun(run.id);
      detail.refresh();
      props.onChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const scenarioRows = useMemo(
    () => aggregateBy(run.scenarioIds, cells, "scenarioId"),
    [run.scenarioIds, cells],
  );
  const configRows = useMemo(
    () => aggregateBy(run.configIds, cells, "configId"),
    [run.configIds, cells],
  );

  const wallTime = run.finishedAt ? (
    fmtDuration(new Date(run.finishedAt).getTime() - new Date(run.createdAt).getTime())
  ) : active ? (
    <Elapsed since={run.createdAt} />
  ) : (
    "—"
  );

  return (
    <section className="run-detail">
      <div className="panel">
        <div className="detail-head">
          <h2 className="detail-title">{runLabel(props.item)}</h2>
          <code className="chip" title={run.id}>
            {run.id}
          </code>
          <StatusBadge status={run.status} />
          {active ? <Spinner label="executing" /> : null}
          <div className="detail-actions">
            {active ? (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy !== null}
                onClick={() => void act("cancel")}
              >
                {busy === "cancel" ? "cancelling…" : "cancel"}
              </button>
            ) : null}
            {canResume ? (
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => void act("resume")}
              >
                {busy === "resume" ? "resuming…" : "resume"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => navigate(`#/runs/${run.id}`)}
            >
              open details →
            </button>
          </div>
        </div>
        {actionError ? <div className="form-error">{actionError}</div> : null}
        <div className="meta-grid">
          <Meta label="created" title={run.createdAt}>
            {fmtDate(run.createdAt)} <span className="dim">· {fmtAgo(run.createdAt)}</span>
          </Meta>
          <Meta label="finished" title={run.finishedAt ?? undefined}>
            {fmtDate(run.finishedAt)}
          </Meta>
          <Meta label="wall time">{wallTime}</Meta>
          <Meta label="total cost">
            <CostBadge costUsd={totals.totalCostUsd} source={null} />{" "}
            {totals.unpricedAttempts > 0 ? (
              <InfoTip text={`${totals.unpricedAttempts} attempt(s) unpriced — not in the total`} />
            ) : null}
          </Meta>
          <Meta label="attempts">
            {totals.finished}/{totals.attempts}{" "}
            <span className="dim">
              · {totals.passedAttempts} passed · {totals.errorAttempts} err
            </span>
          </Meta>
          <Meta label={`best@${run.attemptsPerCell}`}>
            {totals.passedCells}/{totals.totalCells} cells
          </Meta>
          <Meta label="concurrency">{run.concurrency}</Meta>
          <Meta label="judge model">
            <code className="chip">{run.judgeModel ?? props.defaultJudgeModel ?? "default"}</code>
            {run.judgeModel === null ? <span className="dim"> (default)</span> : null}
          </Meta>
        </div>
      </div>
      <div className="panel">
        <h3 className="panel-title">matrix</h3>
        <div className="matrix-scroll">
          <Matrix
            scenarioIds={run.scenarioIds}
            configIds={run.configIds}
            cells={cells}
            attempts={attempts}
            cellHref={(s, c) => `#/runs/${run.id}/attempts/${run.id}_${s}_${c}_0`}
          />
        </div>
      </div>
      <div className="breakdown-grid">
        <div className="panel">
          <h3 className="panel-title">by scenario</h3>
          <DataTable
            rows={scenarioRows}
            columns={SCENARIO_COLUMNS}
            rowKey={(r) => r.id}
            searchable={false}
          />
        </div>
        <div className="panel">
          <h3 className="panel-title">by config</h3>
          <DataTable
            rows={configRows}
            columns={CONFIG_COLUMNS}
            rowKey={(r) => r.id}
            searchable={false}
          />
        </div>
      </div>
    </section>
  );
}

export default function RunsPage(): ReactNode {
  const runsPoll = usePoll(listRuns, 4000, []);
  const modelsPoll = usePoll(getModels, null, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const runs = useMemo(() => runsPoll.data ?? [], [runsPoll.data]);
  const newest = useMemo(
    () => [...runs].sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))[0] ?? null,
    [runs],
  );
  const selected =
    (selectedId !== null ? runs.find((r) => r.run.id === selectedId) : undefined) ?? newest;

  let body: ReactNode;
  if (runsPoll.data === null) {
    body = runsPoll.error ? (
      <div className="panel form-error">failed to load runs: {runsPoll.error}</div>
    ) : (
      <div className="panel">
        <Spinner label="loading runs…" />
      </div>
    );
  } else if (runs.length === 0) {
    body = (
      <div className="panel runs-empty">
        <p className="dim">no runs yet — pick a scenario × config matrix and start one.</p>
        <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
          + new run
        </button>
      </div>
    );
  } else {
    body = (
      <div className="layout-30-70">
        <section>
          <div className="runs-head">
            <h2 className="runs-title">
              runs <span className="dim">({runs.length})</span>
            </h2>
            <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
              + new run
            </button>
          </div>
          <div className="panel">
            <DataTable
              rows={runs}
              columns={RUN_COLUMNS}
              rowKey={(r) => r.run.id}
              onRowClick={(r) => setSelectedId(r.run.id)}
              selectedKey={selected?.run.id ?? null}
              searchPlaceholder="search runs…"
              defaultSort={{ key: "created", dir: "desc" }}
              maxHeight="calc(100vh - 180px)"
            />
          </div>
        </section>
        {selected ? (
          <RunDetailPane
            key={selected.run.id}
            item={selected}
            defaultJudgeModel={modelsPoll.data?.defaultJudgeModel ?? null}
            onChanged={runsPoll.refresh}
          />
        ) : null}
      </div>
    );
  }

  return (
    <>
      {body}
      <NewRunDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}

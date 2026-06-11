import { type ReactNode, useEffect, useMemo, useState } from "react";
import { cancelRun, getRun, listRuns, resumeRun } from "../api.ts";
import { ConfigChip } from "../components/ConfigChip.tsx";
import { useConfirm } from "../components/ConfirmDialog.tsx";
import { type Column, DataTable, MultiSelect } from "../components/DataTable.tsx";
import { EntityLink } from "../components/EntityLink.tsx";
import { fmtAgo, fmtCost, fmtDate, fmtDuration } from "../components/format.ts";
import { Matrix } from "../components/Matrix.tsx";
import { ModelChip } from "../components/ModelChip.tsx";
import { Elapsed, Spinner } from "../components/Spinner.tsx";
import {
  CostBadge,
  StatusBadge,
  StatusScore,
  statusGlyphInfo,
} from "../components/StatusBadge.tsx";
import { InfoTip } from "../components/Tooltip.tsx";
import { navigate, useModels, usePoll } from "../hooks.ts";
import type { CellJson, RunListItem } from "../types.ts";
import { NewRunDialog } from "./NewRunDialog.tsx";
import "./runs.css";

function distinct(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function runLabel(item: RunListItem): string {
  return item.run.name ?? item.run.id.replace(/^run-/, "");
}

/** Best score across the run's cells (item 13); null when no cell has one yet. */
function bestScoreOf(item: RunListItem): number | null {
  const scores = item.cells
    .map((c) => c.bestScore)
    .filter((v): v is number => v !== null && !Number.isNaN(v));
  return scores.length > 0 ? Math.max(...scores) : null;
}

// Exactly five columns (item 11): Run (flexible), Status (+ best score), Scenarios, Cost, Created.
const RUN_COLUMNS: Column<RunListItem>[] = [
  {
    key: "run",
    header: "Run",
    searchText: (r) => `${r.run.id} ${r.run.name ?? ""}`,
    // item 4: rich portal tooltip reveals the WHOLE (possibly truncated) name + id
    tooltip: (r) => (r.run.name !== null ? `${r.run.name}\n${r.run.id}` : r.run.id),
    sortValue: (r) => runLabel(r),
    render: (r) => runLabel(r),
  },
  {
    key: "status",
    header: "Status",
    width: "80px",
    sortValue: (r) => r.run.status,
    render: (r) => (
      <StatusScore
        status={r.run.status}
        score={bestScoreOf(r)}
        tip={r.active ? "Executor active" : undefined}
      />
    ),
  },
  {
    key: "scenarios",
    header: "Scenarios",
    align: "center",
    width: "90px",
    searchText: (r) => r.run.scenarioIds.join(" "),
    // item 3: hover = per-scenario × config result-glyph breakdown from run.cells
    tooltip: (r) => (
      <Matrix
        variant="mini"
        scenarioIds={r.run.scenarioIds}
        configIds={r.run.configIds}
        cells={r.cells}
      />
    ),
    sortValue: (r) => r.run.scenarioIds.length,
    render: (r) => r.run.scenarioIds.length,
  },
  {
    key: "cost",
    header: "Cost",
    align: "right",
    width: "72px",
    sortValue: (r) => r.totals.totalCostUsd,
    render: (r) => fmtCost(r.totals.totalCostUsd),
  },
  {
    key: "created",
    header: "Created",
    align: "right",
    width: "90px",
    titleText: (r) => r.run.createdAt,
    sortValue: (r) => r.run.createdAt,
    render: (r) => fmtAgo(r.run.createdAt),
  },
];

/** Glyph + capitalized label for a status filter option (items 2, 8). */
function statusOptionLabel(option: string): ReactNode {
  if (option === "active") {
    return (
      <>
        <span className="status-glyph tone-accent">●</span>
        Active
      </>
    );
  }
  const info = statusGlyphInfo(option);
  return (
    <>
      <span className={`status-glyph tone-${info.tone}`}>{info.glyph || "⠋"}</span>
      {info.label}
    </>
  );
}

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
  // item 13: configs render as a ConfigChip (hover card carries id/label/provider/…).
  const idColumn: Column<BreakdownRow> =
    kind === "scenario"
      ? {
          key: "id",
          header: "Scenario",
          titleText: (r) => r.id,
          sortValue: (r) => r.id,
          render: (r) => <EntityLink kind="scenario" id={r.id} />,
        }
      : {
          key: "id",
          header: "Config",
          sortValue: (r) => r.id,
          render: (r) => <ConfigChip configId={r.id} link />,
        };
  return [
    idColumn,
    {
      key: "pass",
      header: "Pass",
      align: "right",
      width: "60px",
      sortValue: (r) => (r.cells > 0 ? r.passed / r.cells : null),
      render: (r) => `${r.passed}/${r.cells}`,
    },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      width: "75px",
      sortValue: (r) => r.costUsd,
      render: (r) => fmtCost(r.costUsd),
    },
    {
      key: "duration",
      header: "Avg Time",
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
  // item 12: POST /cancel resolved — keep "Cancelling…" until the polled active flips false.
  const [cancelRequested, setCancelRequested] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  const run = detail.data?.run ?? props.item.run;
  const cells = detail.data?.cells ?? props.item.cells;
  const totals = detail.data?.totals ?? props.item.totals;
  const active = detail.data?.active ?? props.item.active;
  const attempts = detail.data?.attempts;

  useEffect(() => {
    if (!active) setCancelRequested(false);
  }, [active]);

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
    // item 12: in-app confirm modal, not the native browser confirm()
    const confirmed = await confirm(
      kind === "cancel"
        ? {
            title: "Cancel This Run?",
            message:
              "In-flight attempts are torn down and go back to Pending — Resume continues them later.",
            confirmLabel: "Cancel Run",
            cancelLabel: "Keep Running",
            danger: true,
          }
        : {
            title: "Resume This Run?",
            message: "Pending and interrupted attempts are picked up and executed again.",
            confirmLabel: "Resume Run",
            cancelLabel: "Back",
          },
    );
    if (!confirmed) return;
    setBusy(kind);
    setActionError(null);
    try {
      if (kind === "cancel") {
        await cancelRun(run.id);
        setCancelRequested(true);
      } else {
        await resumeRun(run.id);
      }
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
          {/* item 7: exactly ONE animated indicator — the badge's spinner doubles as "Executing" */}
          <StatusBadge status={run.status} activeLabel={active ? "Executing" : undefined} />
          <div className="detail-actions">
            {active ? (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy !== null || cancelRequested}
                onClick={() => void act("cancel")}
              >
                {busy === "cancel" || cancelRequested ? "Cancelling…" : "Cancel"}
              </button>
            ) : null}
            {canResume ? (
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => void act("resume")}
              >
                {busy === "resume" ? "Resuming…" : "Resume"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => navigate(`#/runs/${run.id}`)}
            >
              Open Details →
            </button>
          </div>
        </div>
        {actionError ? <div className="form-error">{actionError}</div> : null}
        <div className="meta-grid">
          <Meta label="Created" title={run.createdAt}>
            {fmtDate(run.createdAt)} <span className="dim">· {fmtAgo(run.createdAt)}</span>
          </Meta>
          <Meta label="Finished" title={run.finishedAt ?? undefined}>
            {fmtDate(run.finishedAt)}
          </Meta>
          <Meta label="Wall Time">{wallTime}</Meta>
          <Meta label="Total Cost">
            <CostBadge costUsd={totals.totalCostUsd} source={null} />{" "}
            {totals.unpricedAttempts > 0 ? (
              <InfoTip text={`${totals.unpricedAttempts} attempt(s) unpriced — not in the total`} />
            ) : null}
          </Meta>
          <Meta label="Attempts">
            {totals.finished}/{totals.attempts}{" "}
            <span className="dim">
              · {totals.passedAttempts} Passed · {totals.errorAttempts} Errors
            </span>
          </Meta>
          <Meta label={`Best@${run.attemptsPerCell}`}>
            {totals.passedCells}/{totals.totalCells} Cells
          </Meta>
          <Meta label="Concurrency">{run.concurrency}</Meta>
          <Meta label="Judge Model">
            <ModelChip model={run.judgeModel ?? props.defaultJudgeModel} />
            {run.judgeModel === null ? <span className="dim"> (Default)</span> : null}
          </Meta>
        </div>
      </div>
      <div className="panel">
        <h3 className="panel-title">Matrix</h3>
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
          <h3 className="panel-title">By Scenario</h3>
          <DataTable
            rows={scenarioRows}
            columns={SCENARIO_COLUMNS}
            rowKey={(r) => r.id}
            searchable={false}
          />
        </div>
        <div className="panel">
          <h3 className="panel-title">By Config</h3>
          <DataTable
            rows={configRows}
            columns={CONFIG_COLUMNS}
            rowKey={(r) => r.id}
            searchable={false}
          />
        </div>
      </div>
      {confirmDialog}
    </section>
  );
}

export default function RunsPage(): ReactNode {
  const runsPoll = usePoll(listRuns, 4000, []);
  const models = useModels();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [scenarioFilter, setScenarioFilter] = useState<string[]>([]);
  const [configFilter, setConfigFilter] = useState<string[]>([]);

  const runs = useMemo(() => runsPoll.data ?? [], [runsPoll.data]);

  // Filter options (item 9): status (incl. the synthetic "active"), scenarios, configs.
  const statusOptions = useMemo(() => {
    const opts = distinct(runs.map((r) => r.run.status));
    if (runs.some((r) => r.active)) opts.push("active");
    return opts;
  }, [runs]);
  const scenarioOptions = useMemo(() => distinct(runs.flatMap((r) => r.run.scenarioIds)), [runs]);
  const configOptions = useMemo(() => distinct(runs.flatMap((r) => r.run.configIds)), [runs]);

  const filteredRuns = useMemo(
    () =>
      runs.filter((r) => {
        if (statusFilter.length > 0) {
          const values = r.active ? [r.run.status, "active"] : [r.run.status];
          if (!values.some((v) => statusFilter.includes(v))) return false;
        }
        if (
          scenarioFilter.length > 0 &&
          !r.run.scenarioIds.some((s) => scenarioFilter.includes(s))
        ) {
          return false;
        }
        if (configFilter.length > 0 && !r.run.configIds.some((c) => configFilter.includes(c))) {
          return false;
        }
        return true;
      }),
    [runs, statusFilter, scenarioFilter, configFilter],
  );

  const newest = useMemo(
    () => [...runs].sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))[0] ?? null,
    [runs],
  );
  const selected =
    (selectedId !== null ? runs.find((r) => r.run.id === selectedId) : undefined) ?? newest;

  let body: ReactNode;
  if (runsPoll.data === null) {
    body = runsPoll.error ? (
      <div className="panel form-error">Failed to load runs: {runsPoll.error}</div>
    ) : (
      <div className="panel">
        <Spinner label="Loading runs…" />
      </div>
    );
  } else if (runs.length === 0) {
    body = (
      <div className="panel runs-empty">
        <p className="dim">No runs yet — pick a scenario × config matrix and start one.</p>
        <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
          + New Run
        </button>
      </div>
    );
  } else {
    body = (
      <div className="layout-30-70">
        <section>
          <div className="runs-head">
            <h2 className="runs-title">
              Runs <span className="dim">({runs.length})</span>
            </h2>
            <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
              + New Run
            </button>
          </div>
          <div className="panel">
            {/* Row 1: multi-select filters; row 2: the DataTable's full-width search (item 9). */}
            <div className="runs-filters">
              <MultiSelect
                label="Status"
                options={statusOptions}
                selected={statusFilter}
                onChange={setStatusFilter}
                renderOption={statusOptionLabel}
              />
              <MultiSelect
                label="Scenarios"
                options={scenarioOptions}
                selected={scenarioFilter}
                onChange={setScenarioFilter}
              />
              <MultiSelect
                label="Configs"
                options={configOptions}
                selected={configFilter}
                onChange={setConfigFilter}
                renderOption={(option) => <ConfigChip configId={option} />}
              />
            </div>
            <DataTable
              rows={filteredRuns}
              columns={RUN_COLUMNS}
              rowKey={(r) => r.run.id}
              onRowClick={(r) => setSelectedId(r.run.id)}
              selectedKey={selected?.run.id ?? null}
              toolbarLayout="stacked"
              searchPlaceholder="Search runs…"
              defaultSort={{ key: "created", dir: "desc" }}
              maxHeight="calc(100vh - 260px)"
            />
          </div>
        </section>
        {selected ? (
          <RunDetailPane
            key={selected.run.id}
            item={selected}
            defaultJudgeModel={models.defaultJudgeModel}
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

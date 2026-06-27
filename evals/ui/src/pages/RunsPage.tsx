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
import type { CellJson, RunListItem, RunVersions } from "../types.ts";
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

// Shared column building blocks: the compact (split) set keeps exactly five columns
// (item 11); the wide set reuses run/status/scenarios/cost/created and layers in the
// v5 §4 deep columns.
const COL_RUN: Column<RunListItem> = {
  key: "run",
  header: "Run",
  searchText: (r) => `${r.run.id} ${r.run.name ?? ""}`,
  // item 4: rich portal tooltip reveals the WHOLE (possibly truncated) name + id
  tooltip: (r) => (r.run.name !== null ? `${r.run.name}\n${r.run.id}` : r.run.id),
  sortValue: (r) => runLabel(r),
  render: (r) => runLabel(r),
};

const COL_STATUS: Column<RunListItem> = {
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
};

const COL_SCENARIOS: Column<RunListItem> = {
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
};

const COL_COST: Column<RunListItem> = {
  key: "cost",
  header: "Cost",
  align: "right",
  width: "72px",
  sortValue: (r) => r.totals.totalCostUsd,
  render: (r) => fmtCost(r.totals.totalCostUsd),
};

const COL_CREATED: Column<RunListItem> = {
  key: "created",
  header: "Created",
  align: "right",
  width: "90px",
  titleText: (r) => r.run.createdAt,
  sortValue: (r) => r.run.createdAt,
  render: (r) => fmtAgo(r.run.createdAt),
};

// Exactly five columns in split mode (item 11): Run, Status (+ best score), Scenarios, Cost, Created.
const RUN_COLUMNS: Column<RunListItem>[] = [
  COL_RUN,
  COL_STATUS,
  COL_SCENARIOS,
  COL_COST,
  COL_CREATED,
];

/** Wall time of a run: finished → fixed span; still executing → live; otherwise null. */
function wallMsOf(item: RunListItem): number | null {
  if (item.run.finishedAt !== null) {
    return new Date(item.run.finishedAt).getTime() - new Date(item.run.createdAt).getTime();
  }
  return item.active ? Date.now() - new Date(item.run.createdAt).getTime() : null;
}

/** Worker-version summary (v5 §4 col 10): "1.85.0" | "1.85.0 +n"; null when not captured. */
function workerVersionSummary(versions: RunVersions | undefined): string | null {
  const worker = versions?.worker ?? [];
  if (worker.length === 0) return null;
  return worker.length === 1 ? worker[0] : `${worker[0]} +${worker.length - 1}`;
}

/** Full "API: …\nWorker: …" lists for the Versions tooltip; null when nothing was captured. */
function versionsTip(versions: RunVersions | undefined): string | null {
  if (!versions || (versions.api.length === 0 && versions.worker.length === 0)) return null;
  const list = (values: string[]) => (values.length > 0 ? values.join(", ") : "—");
  return `API: ${list(versions.api)}\nWorker: ${list(versions.worker)}`;
}

/** The wide-mode deep column set (v5 spec §4 — FROZEN order/content). */
function deepRunColumns(defaultJudgeModel: string | null): Column<RunListItem>[] {
  return [
    COL_RUN,
    COL_STATUS,
    { ...COL_SCENARIOS, width: "80px" },
    {
      key: "configs",
      header: "Configs",
      align: "center",
      width: "70px",
      searchText: (r) => r.run.configIds.join(" "),
      // hover = the run's configs as a stacked ConfigChip list
      tooltip: (r) => (
        <div className="runs-configs-tip">
          {r.run.configIds.map((id) => (
            <div key={id}>
              <ConfigChip configId={id} />
            </div>
          ))}
        </div>
      ),
      sortValue: (r) => r.run.configIds.length,
      render: (r) => r.run.configIds.length,
    },
    {
      key: "attempts",
      header: "Attempts",
      align: "center",
      width: "90px",
      tooltip: (r) => {
        const failed = Math.max(
          0,
          r.totals.finished - r.totals.passedAttempts - r.totals.errorAttempts,
        );
        return `${r.totals.passedAttempts} Passed · ${failed} Failed · ${r.totals.errorAttempts} Errors`;
      },
      sortValue: (r) =>
        r.totals.finished > 0 ? r.totals.passedAttempts / r.totals.finished : null,
      render: (r) => (
        <>
          {r.totals.passedAttempts}/{r.totals.finished}
          {r.totals.errorAttempts > 0 ? (
            <span className="dim"> · {r.totals.errorAttempts}⚠</span>
          ) : null}
        </>
      ),
    },
    { ...COL_COST, header: "Task Cost", width: "80px" },
    {
      key: "judgeCost",
      header: "Judge Cost",
      align: "right",
      width: "80px",
      sortValue: (r) => r.totals.judgeCostUsd,
      render: (r) => fmtCost(r.totals.judgeCostUsd),
    },
    {
      key: "duration",
      header: "Duration",
      align: "right",
      width: "80px",
      sortValue: (r) => wallMsOf(r),
      render: (r) => {
        if (r.run.finishedAt !== null) return fmtDuration(wallMsOf(r));
        return r.active ? <Elapsed since={r.run.createdAt} /> : "—";
      },
    },
    {
      key: "judgeModel",
      header: "Judge Model",
      width: "140px",
      sortValue: (r) => r.run.judgeModel ?? defaultJudgeModel,
      render: (r) => <ModelChip model={r.run.judgeModel ?? defaultJudgeModel} />,
    },
    {
      key: "versions",
      header: "Versions",
      align: "center",
      width: "90px",
      searchText: (r) => [...(r.versions?.api ?? []), ...(r.versions?.worker ?? [])].join(" "),
      tooltip: (r) => versionsTip(r.versions),
      sortValue: (r) => workerVersionSummary(r.versions),
      render: (r) => workerVersionSummary(r.versions) ?? <span className="dim">—</span>,
    },
    COL_CREATED,
  ];
}

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

type TableMode = "split" | "wide";

const TABLE_MODE_KEY = "evals-runs-table-mode";

/** Session-persisted table mode (v5 §4) — survives hash navigation within the tab. */
function loadTableMode(): TableMode {
  try {
    return sessionStorage.getItem(TABLE_MODE_KEY) === "wide" ? "wide" : "split";
  } catch {
    return "split";
  }
}

export default function RunsPage(): ReactNode {
  const runsPoll = usePoll(listRuns, 4000, []);
  const models = useModels();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tableMode, setTableMode] = useState<TableMode>(loadTableMode);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [scenarioFilter, setScenarioFilter] = useState<string[]>([]);
  const [configFilter, setConfigFilter] = useState<string[]>([]);

  const toggleTableMode = () => {
    setTableMode((prev) => {
      const next: TableMode = prev === "split" ? "wide" : "split";
      try {
        sessionStorage.setItem(TABLE_MODE_KEY, next);
      } catch {
        // sessionStorage unavailable — the toggle still works, it just won't persist
      }
      return next;
    });
  };

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

  const deepColumns = useMemo(
    () => deepRunColumns(models.defaultJudgeModel),
    [models.defaultJudgeModel],
  );

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
    const head = (
      <div className="runs-head">
        <h2 className="runs-title">
          Runs <span className="dim">({runs.length})</span>
        </h2>
        <div className="runs-head-actions">
          {/* v5 §4: ⛶ expands to the full-width deep table; ⊟ restores the 30/70 split */}
          <button
            type="button"
            className="btn"
            title={
              tableMode === "split"
                ? "Full-width table with detailed columns"
                : "Back to the split view with the detail pane"
            }
            onClick={toggleTableMode}
          >
            {tableMode === "split" ? "⛶ Expand" : "⊟ Collapse"}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
            + New Run
          </button>
        </div>
      </div>
    );
    // Row 1: multi-select filters; row 2: the DataTable's full-width search (item 9).
    // Both table modes share the exact same filter + fuzzy-search toolbar.
    const filters = (
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
    );
    body =
      tableMode === "wide" ? (
        // Wide mode: single full-width section, deep columns, row click opens the details page.
        <section>
          {head}
          <div className="panel">
            {filters}
            <DataTable
              rows={filteredRuns}
              columns={deepColumns}
              rowKey={(r) => r.run.id}
              rowHref={(r) => `#/runs/${r.run.id}`}
              toolbarLayout="stacked"
              searchPlaceholder="Search runs…"
              defaultSort={{ key: "created", dir: "desc" }}
              maxHeight="calc(100vh - 260px)"
            />
          </div>
        </section>
      ) : (
        <div className="layout-30-70">
          <section>
            {head}
            <div className="panel">
              {filters}
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

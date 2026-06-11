import type { ReactNode } from "react";
import { getScenario, listScenarios } from "../api.ts";
import { type Column, DataTable } from "../components/DataTable.tsx";
import { EntityLink } from "../components/EntityLink.tsx";
import { fmtAgo, fmtDuration, fmtScore } from "../components/format.ts";
import { JsonView } from "../components/JsonView.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { CostBadge, StatusBadge } from "../components/StatusBadge.tsx";
import { InfoTip, Tooltip } from "../components/Tooltip.tsx";
import { navigate, usePoll } from "../hooks.ts";
import type { AttemptJson, ScenarioJson } from "../types.ts";
import "./scenarios.css";

const DESC_CLIP = 120;

function judgeNames(s: ScenarioJson): string[] {
  const names: string[] = [];
  if (s.outcome.llmJudge) names.push("llm");
  if (s.outcome.agenticJudge) names.push("agentic");
  return names;
}

const scenarioColumns: Column<ScenarioJson>[] = [
  {
    key: "id",
    header: "id",
    searchText: (s) => s.id,
    render: (s) => <EntityLink kind="scenario" id={s.id} />,
  },
  {
    key: "name",
    header: "name",
    searchText: (s) => s.name,
    render: (s) => s.name,
  },
  {
    key: "tasks",
    header: "tasks",
    align: "right",
    sortValue: (s) => s.tasks.length,
    render: (s) => s.tasks.length,
  },
  {
    key: "checks",
    header: "checks",
    sortValue: (s) => s.outcome.checks.length,
    render: (s) =>
      s.outcome.checks.length === 0 ? (
        <span className="dim">0</span>
      ) : (
        <Tooltip text={s.outcome.checks.join("\n")}>
          <span>{s.outcome.checks.length}</span>
        </Tooltip>
      ),
  },
  {
    key: "judges",
    header: "judges",
    sortValue: (s) => judgeNames(s).join(" ") || null,
    render: (s) => {
      const names = judgeNames(s);
      if (names.length === 0) return <span className="dim">—</span>;
      return (
        <span className="sc-judges">
          {names.map((n) => (
            <span key={n} className="chip">
              {n}
            </span>
          ))}
        </span>
      );
    },
  },
  {
    key: "timeout",
    header: "timeout",
    sortValue: (s) => s.timeoutMs,
    render: (s) => fmtDuration(s.timeoutMs),
  },
  {
    key: "threshold",
    header: "pass ≥",
    sortValue: (s) => s.outcome.passThreshold,
    render: (s) => s.outcome.passThreshold,
  },
  {
    key: "description",
    header: "description",
    sortable: false,
    searchText: (s) => s.description ?? "",
    render: (s) => {
      if (!s.description) return <span className="dim">—</span>;
      const clipped =
        s.description.length > DESC_CLIP ? `${s.description.slice(0, DESC_CLIP)}…` : s.description;
      return (
        <Tooltip text={s.description}>
          <span className="dim sc-desc">{clipped}</span>
        </Tooltip>
      );
    },
  },
];

function ScenarioList(): ReactNode {
  const { data, error, loading } = usePoll(listScenarios, null, []);
  return (
    <div className="panel">
      <h3 className="panel-title">scenarios{data ? ` · ${data.length}` : ""}</h3>
      {error ? <div className="sc-error">{error}</div> : null}
      {loading && !data ? <Spinner label="loading scenarios…" /> : null}
      {data ? (
        <DataTable
          rows={data}
          columns={scenarioColumns}
          rowKey={(s) => s.id}
          onRowClick={(s) => navigate(`#/scenarios/${s.id}`)}
          defaultSort={{ key: "id", dir: "asc" }}
          searchPlaceholder="search scenarios…"
          emptyText="no scenarios registered"
        />
      ) : null}
    </div>
  );
}

const attemptColumns: Column<AttemptJson>[] = [
  {
    key: "started",
    header: "started",
    sortValue: (a) => a.startedAt,
    render: (a) => <span title={a.startedAt ?? undefined}>{fmtAgo(a.startedAt)}</span>,
  },
  {
    key: "run",
    header: "run",
    searchText: (a) => a.runId,
    render: (a) => <EntityLink kind="run" id={a.runId} />,
  },
  {
    key: "config",
    header: "config",
    filterOptions: (rows) => [...new Set(rows.map((a) => a.configId))].sort(),
    filterValue: (a) => a.configId,
    searchText: (a) => a.configId,
    render: (a) => <span className="chip">{a.configId}</span>,
  },
  {
    key: "status",
    header: "status",
    filterOptions: (rows) => [...new Set(rows.map((a) => a.status))].sort(),
    filterValue: (a) => a.status,
    sortValue: (a) => a.status,
    render: (a) => <StatusBadge status={a.status} />,
  },
  {
    key: "score",
    header: "score",
    align: "right",
    sortValue: (a) => a.score,
    render: (a) => fmtScore(a.score),
  },
  {
    key: "cost",
    header: "cost",
    align: "right",
    sortValue: (a) => a.costUsd,
    render: (a) => <CostBadge costUsd={a.costUsd} source={a.costSource} />,
  },
  {
    key: "duration",
    header: "duration",
    sortValue: (a) => a.durationMs,
    render: (a) => fmtDuration(a.durationMs),
  },
  {
    key: "attempt",
    header: "attempt",
    sortable: false,
    render: (a) => <EntityLink kind="attempt" id={a.id} runId={a.runId} label="open →" />,
  },
];

function ScenarioDetail(props: { scenarioId: string }): ReactNode {
  const { data, error, loading } = usePoll(() => getScenario(props.scenarioId), null, [
    props.scenarioId,
  ]);

  if (!data) {
    return (
      <div className="panel">
        <a className="entity-link" href="#/scenarios">
          ← scenarios
        </a>
        {loading ? (
          <div className="sc-loading">
            <Spinner label="loading scenario…" />
          </div>
        ) : null}
        {error ? <div className="sc-error">{error}</div> : null}
      </div>
    );
  }

  const { scenario, recentAttempts } = data;
  return (
    <>
      <div className="panel sc-header">
        <a className="entity-link" href="#/scenarios">
          ← scenarios
        </a>
        <h2 className="sc-title">{scenario.name}</h2>
        <span className="chip">{scenario.id}</span>
        {judgeNames(scenario).map((n) => (
          <span key={n} className="chip">
            {n}
          </span>
        ))}
        {error ? <span className="sc-error">{error}</span> : null}
      </div>
      <div className="panel">
        <h3 className="panel-title">
          definition <InfoTip text="checks always include the implicit tasks-completed check" />
        </h3>
        <JsonView value={scenario} collapseDepth={3} />
      </div>
      <div className="panel">
        <h3 className="panel-title">
          recent attempts{recentAttempts.length > 0 ? ` · ${recentAttempts.length}` : ""}
        </h3>
        <DataTable
          rows={recentAttempts}
          columns={attemptColumns}
          rowKey={(a) => a.id}
          defaultSort={{ key: "started", dir: "desc" }}
          searchPlaceholder="search attempts…"
          emptyText="no attempts yet for this scenario"
        />
      </div>
    </>
  );
}

export default function ScenariosPage(props: { scenarioId: string | null }): ReactNode {
  return props.scenarioId === null ? (
    <ScenarioList />
  ) : (
    <ScenarioDetail scenarioId={props.scenarioId} />
  );
}

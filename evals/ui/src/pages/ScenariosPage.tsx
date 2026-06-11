import type { ReactNode } from "react";
import { getScenario, listScenarios } from "../api.ts";
import { ConfigChip } from "../components/ConfigChip.tsx";
import { type Column, DataTable } from "../components/DataTable.tsx";
import { EntityLink } from "../components/EntityLink.tsx";
import { fmtAgo, fmtDuration } from "../components/format.ts";
import { ModelChip } from "../components/ModelChip.tsx";
import { PrettyView } from "../components/PrettyView.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { CostBadge, StatusScore, statusGlyphInfo } from "../components/StatusBadge.tsx";
import { InfoTip, Tooltip } from "../components/Tooltip.tsx";
import { navigate, usePoll } from "../hooks.ts";
import type { AttemptJson, ScenarioJson } from "../types.ts";
import "./scenarios.css";

type JudgeKind = "llm" | "agentic";

// Judge-kind glyphs — keep consistent with the run-details checks tab (llm/agentic ✶).
const JUDGE_GLYPHS: Record<JudgeKind, { glyph: string; label: string }> = {
  llm: { glyph: "✶", label: "LLM Judge" },
  agentic: { glyph: "✶✶", label: "Agentic Judge" },
};

function judgeKinds(s: ScenarioJson): JudgeKind[] {
  const kinds: JudgeKind[] = [];
  if (s.outcome.llmJudge) kinds.push("llm");
  if (s.outcome.agenticJudge) kinds.push("agentic");
  return kinds;
}

function JudgeGlyph(props: { kind: JudgeKind }): ReactNode {
  const info = JUDGE_GLYPHS[props.kind];
  return (
    <Tooltip text={info.label}>
      <span className="sc-judge" role="img" aria-label={info.label}>
        {info.glyph}
      </span>
    </Tooltip>
  );
}

const scenarioColumns: Column<ScenarioJson>[] = [
  {
    key: "id",
    header: "Id",
    width: "150px",
    searchText: (s) => s.id,
    render: (s) => <EntityLink kind="scenario" id={s.id} />,
  },
  {
    key: "name",
    header: "Name",
    searchText: (s) => s.name,
    render: (s) => s.name,
  },
  {
    key: "tasks",
    header: "Tasks",
    width: "58px",
    align: "right",
    sortValue: (s) => s.tasks.length,
    render: (s) => s.tasks.length,
  },
  {
    key: "checks",
    header: "Checks",
    width: "64px",
    align: "right",
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
    header: "Judges",
    width: "70px",
    sortValue: (s) => judgeKinds(s).join(" ") || null,
    render: (s) => {
      const kinds = judgeKinds(s);
      if (kinds.length === 0) return <span className="dim">—</span>;
      return (
        <span className="sc-judges">
          {kinds.map((kind) => (
            <JudgeGlyph key={kind} kind={kind} />
          ))}
        </span>
      );
    },
  },
  {
    key: "timeout",
    header: "Timeout",
    width: "76px",
    sortValue: (s) => s.timeoutMs,
    render: (s) => fmtDuration(s.timeoutMs),
  },
  {
    key: "threshold",
    header: "Pass ≥",
    width: "62px",
    align: "right",
    sortValue: (s) => s.outcome.passThreshold,
    render: (s) => s.outcome.passThreshold,
  },
  {
    key: "description",
    header: "Description",
    width: "32%",
    sortable: false,
    searchText: (s) => s.description ?? "",
    render: (s) =>
      s.description ? <span className="dim">{s.description}</span> : <span className="dim">—</span>,
  },
];

function ScenarioList(): ReactNode {
  const { data, error, loading } = usePoll(listScenarios, null, []);
  return (
    <div className="panel">
      <h3 className="panel-title">Scenarios{data ? ` · ${data.length}` : ""}</h3>
      {error ? <div className="sc-error">{error}</div> : null}
      {loading && !data ? <Spinner label="Loading scenarios…" /> : null}
      {data ? (
        <DataTable
          rows={data}
          columns={scenarioColumns}
          rowKey={(s) => s.id}
          onRowClick={(s) => navigate(`#/scenarios/${s.id}`)}
          defaultSort={{ key: "id", dir: "asc" }}
          searchPlaceholder="Search scenarios…"
          emptyText="No scenarios registered"
        />
      ) : null}
    </div>
  );
}

const attemptColumns: Column<AttemptJson>[] = [
  {
    key: "started",
    header: "Started",
    width: "86px",
    sortValue: (a) => a.startedAt,
    titleText: (a) => a.startedAt ?? "—",
    render: (a) => fmtAgo(a.startedAt),
  },
  {
    key: "run",
    header: "Run",
    width: "110px",
    searchText: (a) => a.runId,
    render: (a) => <EntityLink kind="run" id={a.runId} />,
  },
  {
    key: "config",
    header: "Config",
    filterOptions: (rows) => [...new Set(rows.map((a) => a.configId))].sort(),
    filterValue: (a) => a.configId,
    // item 13 (v4): ConfigChip everywhere configs appear — hover card carries the id
    filterRender: (option) => <ConfigChip configId={option} />,
    searchText: (a) => a.configId,
    render: (a) => <ConfigChip configId={a.configId} link />,
  },
  {
    key: "result",
    header: "Result",
    width: "84px",
    filterOptions: (rows) => [...new Set(rows.map((a) => a.status))].sort(),
    filterValue: (a) => a.status,
    filterRender: (option) => statusGlyphInfo(option).label,
    sortValue: (a) => a.score,
    render: (a) => <StatusScore status={a.status} score={a.score} />,
  },
  {
    key: "cost",
    header: "Cost",
    width: "88px",
    align: "right",
    sortValue: (a) => a.costUsd,
    render: (a) => <CostBadge costUsd={a.costUsd} source={a.costSource} />,
  },
  {
    key: "duration",
    header: "Duration",
    width: "78px",
    align: "right",
    sortValue: (a) => a.durationMs,
    render: (a) => fmtDuration(a.durationMs),
  },
  {
    key: "attempt",
    header: "Attempt",
    width: "78px",
    sortable: false,
    render: (a) => <EntityLink kind="attempt" id={a.id} runId={a.runId} label="Open →" />,
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
          ← Scenarios
        </a>
        {loading ? (
          <div className="sc-loading">
            <Spinner label="Loading scenario…" />
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
          ← Scenarios
        </a>
        <h2 className="sc-title">{scenario.name}</h2>
        <span className="chip">{scenario.id}</span>
        {judgeKinds(scenario).length > 0 ? (
          <span className="sc-judges">
            {judgeKinds(scenario).map((kind) => (
              <JudgeGlyph key={kind} kind={kind} />
            ))}
          </span>
        ) : null}
        {error ? <span className="sc-error">{error}</span> : null}
      </div>
      <div className="panel">
        <h3 className="panel-title">
          Definition <InfoTip text="Checks always include the implicit tasks-completed check" />
        </h3>
        <PrettyView
          value={scenario}
          rawLabel="scenario"
          renderers={{
            model: (v) => <ModelChip model={typeof v === "string" ? v : null} />,
          }}
        />
      </div>
      <div className="panel">
        <h3 className="panel-title">
          Recent Attempts{recentAttempts.length > 0 ? ` · ${recentAttempts.length}` : ""}
        </h3>
        <DataTable
          rows={recentAttempts}
          columns={attemptColumns}
          rowKey={(a) => a.id}
          defaultSort={{ key: "started", dir: "desc" }}
          searchPlaceholder="Search attempts…"
          emptyText="No attempts yet for this scenario"
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

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { getScenario, listScenarios } from "../api.ts";
import { ConfigChip } from "../components/ConfigChip.tsx";
import { type Column, DataTable } from "../components/DataTable.tsx";
import { EntityLink } from "../components/EntityLink.tsx";
import { fmtAgo, fmtDuration, humanizeKey } from "../components/format.ts";
import { Markdown } from "../components/Markdown.tsx";
import { ModelChip } from "../components/ModelChip.tsx";
import { PrettyView } from "../components/PrettyView.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { CostBadge, StatusScore, statusGlyphInfo } from "../components/StatusBadge.tsx";
import { InfoTip, Tooltip } from "../components/Tooltip.tsx";
import { navigate, usePoll } from "../hooks.ts";
import { explainCheck } from "../lib/check-descriptions.ts";
import type { AttemptJson, ScenarioJson, WorkerSpecJson } from "../types.ts";
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
        <Tooltip text={s.outcome.checks.map(checkTooltipText).join("\n\n")}>
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

function AttemptsPanel(props: { attempts: AttemptJson[] }): ReactNode {
  return (
    <div className="panel">
      <h3 className="panel-title">
        Recent Attempts{props.attempts.length > 0 ? ` · ${props.attempts.length}` : ""}
      </h3>
      <DataTable
        rows={props.attempts}
        columns={attemptColumns}
        rowKey={(a) => a.id}
        defaultSort={{ key: "started", dir: "desc" }}
        searchPlaceholder="Search attempts…"
        emptyText="No attempts yet for this scenario"
      />
    </div>
  );
}

// ---- §3 clamp (v7 — frozen classes .sc-clamp / .sc-clamp.expanded / .sc-clamp-toggle) ----

/** v7 §3 frozen threshold: blocks taller than this clamp with a fade + toggle. */
const CLAMP_MAX_PX = 320;

/**
 * Auto-expanded prose container: renders children full-width; when the rendered
 * height exceeds CLAMP_MAX_PX it clamps (max-height + hidden overflow) with a
 * bottom fade and a Show more / Show less toggle.
 */
function ClampBox(props: { children: ReactNode }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [clampable, setClampable] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // scrollHeight reports the full content height even while max-height clamps
  // the box, so one measurement rule works in both states. Re-measure on
  // content change and on resize (re-wrapping changes the height).
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setClampable(el.scrollHeight > CLAMP_MAX_PX + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cls = `sc-clamp${expanded ? " expanded" : ""}${clampable ? " clampable" : ""}`;
  return (
    <div className="sc-clampwrap">
      <div ref={boxRef} className={cls}>
        {props.children}
      </div>
      {clampable ? (
        <button
          type="button"
          className="sc-clamp-toggle"
          onClick={() => setExpanded((e) => !e)}
          title={expanded ? "Collapse this block" : "Expand the full block"}
        >
          {expanded ? "▴ Show less" : "▾ Show more"}
        </button>
      ) : null}
    </div>
  );
}

// ---- §9.4 member chips (workerSpecs / lead) ----

interface MemberInfo {
  role: "worker" | "lead";
  index: number;
  spec: WorkerSpecJson;
}

/** Lead first (mirrors run-details ordering), then workers in index order. */
function scenarioMembers(s: ScenarioJson): MemberInfo[] {
  const members: MemberInfo[] = [];
  if (s.lead) members.push({ role: "lead", index: s.workers, spec: s.lead });
  if (s.workerSpecs) {
    s.workerSpecs.forEach((spec, index) => {
      members.push({ role: "worker", index, spec });
    });
  }
  return members;
}

function memberOverrideText(spec: WorkerSpecJson): string | null {
  if (spec.configId === null && spec.model === null) return null;
  return `${spec.configId ?? ""}${spec.model !== null ? `:${spec.model}` : ""}`;
}

function MemberCard(props: { member: MemberInfo }): ReactNode {
  const { role, index, spec } = props.member;
  return (
    <div className="tip-card">
      <div className="tip-card-title">{role === "lead" ? "lead" : `worker ${index}`}</div>
      <div className="tip-card-row">
        <span className="tip-card-label">Template</span>
        <span className="tip-card-value">
          {spec.template !== null ? <code>{spec.template}</code> : <span className="dim">—</span>}
        </span>
      </div>
      <div className="tip-card-row">
        <span className="tip-card-label">Name</span>
        <span className="tip-card-value">{spec.name ?? <span className="dim">—</span>}</span>
      </div>
      <div className="tip-card-row">
        <span className="tip-card-label">Config</span>
        <span className="tip-card-value">
          {spec.configId !== null ? (
            <code>{spec.configId}</code>
          ) : (
            <span className="dim">cell config</span>
          )}
        </span>
      </div>
      <div className="tip-card-row">
        <span className="tip-card-label">Model</span>
        <span className="tip-card-value">
          {spec.model !== null ? (
            <code>{spec.model}</code>
          ) : (
            <span className="dim">cell model</span>
          )}
        </span>
      </div>
      <div className="tip-card-row">
        <span className="tip-card-label">System Prompt</span>
        <span className="tip-card-value">
          {spec.systemPrompt !== null ? "✓ custom" : <span className="dim">—</span>}
        </span>
      </div>
      <div className="tip-card-row">
        <span className="tip-card-label">Env Keys</span>
        <span className="tip-card-value">
          {spec.envKeys.length > 0 ? spec.envKeys.join(", ") : <span className="dim">—</span>}
        </span>
      </div>
    </div>
  );
}

function MemberChip(props: { member: MemberInfo }): ReactNode {
  const { role, index, spec } = props.member;
  const override = memberOverrideText(spec);
  return (
    <Tooltip wide text={<MemberCard member={props.member} />}>
      <span className="sc-member">
        <span className={role === "lead" ? "sc-member-role sc-member-role-lead" : "sc-member-role"}>
          {role === "lead" ? "lead" : `worker ${index}`}
        </span>
        {spec.template !== null ? (
          <span className="sc-member-template">{spec.template}</span>
        ) : null}
        {spec.name !== null ? <span className="sc-member-name">{spec.name}</span> : null}
        {override !== null ? <span className="sc-member-override">{override}</span> : null}
      </span>
    </Tooltip>
  );
}

// ---- §3 two-column detail ----

function Fact(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="sc-fact">
      <div className="sc-fact-label">{props.label}</div>
      <div className="sc-fact-value">{props.children}</div>
    </div>
  );
}

function ProseBlock(props: { title: string; meta?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <section className="sc-block">
      <div className="sc-block-head">
        <span className="sc-block-title">{props.title}</span>
        {props.meta !== undefined ? <span className="sc-block-meta">{props.meta}</span> : null}
      </div>
      {props.children}
    </section>
  );
}

function FactsColumn(props: { scenario: ScenarioJson }): ReactNode {
  const s = props.scenario;
  const members = scenarioMembers(s);
  const seed = s.seed;
  // v8.0 OutcomeSpec v2 — absent on pre-v2 payloads (render nothing below).
  const { gates, dimensions } = s.outcome;
  return (
    <div className="sc-facts">
      <Fact label="Id">
        <span className="chip">{s.id}</span>
      </Fact>
      <Fact label="Judges">
        {judgeKinds(s).length === 0 ? (
          <span className="dim">deterministic only</span>
        ) : (
          <div className="sc-judge-facts">
            {s.outcome.llmJudge ? (
              <div className="sc-judge-fact">
                <JudgeGlyph kind="llm" />
                <span>LLM Judge</span>
                <span className="dim">{s.outcome.llmJudge.model ?? "default model"}</span>
              </div>
            ) : null}
            {s.outcome.agenticJudge ? (
              <div className="sc-judge-fact">
                <JudgeGlyph kind="agentic" />
                <span>Agentic Judge</span>
                <span className="dim">
                  {s.outcome.agenticJudge.model ?? "default model"}
                  {s.outcome.agenticJudge.maxSteps !== null
                    ? ` · ≤${s.outcome.agenticJudge.maxSteps} steps`
                    : ""}
                </span>
              </div>
            ) : null}
          </div>
        )}
      </Fact>
      <Fact label="Workers">
        <span>
          {s.workers}
          {s.lead ? " + lead" : ""}
        </span>
        {members.length > 0 ? (
          <div className="sc-members">
            {members.map((m) => (
              <MemberChip key={`${m.role}-${String(m.index)}`} member={m} />
            ))}
          </div>
        ) : null}
      </Fact>
      <Fact label="Timeout">{fmtDuration(s.timeoutMs)}</Fact>
      <Fact label="Pass Threshold">≥ {s.outcome.passThreshold}</Fact>
      {/* v8.0 OutcomeSpec v2: weighted dimensions. NULL/absent (pre-v2) → omit
          the whole Fact so legacy scenarios render exactly as before. */}
      {dimensions !== undefined && dimensions.length > 0 ? (
        <Fact label={`Dimensions · ${dimensions.length}`}>
          <div className="sc-dims">
            {dimensions.map((d) => (
              <Tooltip
                key={d.name}
                text={
                  d.judge
                    ? "Scored by a judge rubric"
                    : d.checks.length > 0
                      ? `Fed by checks:\n${d.checks.map(checkTooltipText).join("\n\n")}`
                      : "Fed by checks"
                }
              >
                <span className="sc-dim">
                  <span className="sc-dim-name">{d.name}</span>
                  <span className="sc-dim-weight">×{d.weight}</span>
                  <span className={d.judge ? "sc-dim-src sc-dim-src-judge" : "sc-dim-src"}>
                    {d.judge
                      ? "judge"
                      : `${d.checks.length} ${d.checks.length === 1 ? "check" : "checks"}`}
                  </span>
                </span>
              </Tooltip>
            ))}
          </div>
        </Fact>
      ) : null}
      {/* v8.0 OutcomeSpec v2: pass/fail gates. NULL/absent (pre-v2) → omit. */}
      {gates !== undefined && gates.length > 0 ? (
        <Fact label={`Gates · ${gates.length}`}>
          <div className="sc-checks">
            {gates.map((gate) => (
              <CheckChip key={gate} name={gate} gate />
            ))}
          </div>
        </Fact>
      ) : null}
      <Fact label={`Checks · ${s.outcome.checks.length}`}>
        {s.outcome.checks.length === 0 ? (
          <span className="dim">—</span>
        ) : (
          <div className="sc-checks">
            {s.outcome.checks.map((check) => (
              <CheckChip key={check} name={check} />
            ))}
          </div>
        )}
      </Fact>
      <Fact label="Seed">
        {!seed ? (
          <span className="dim">—</span>
        ) : (
          <div className="sc-seed">
            {seed.sqlDump !== null ? (
              <div>
                SQL dump <code className="sc-check">{seed.sqlDump}</code>
              </div>
            ) : null}
            {seed.memories.length > 0 ? (
              <Tooltip text={seed.memories.join("\n\n")}>
                <div>
                  {seed.memories.length} {seed.memories.length === 1 ? "memory" : "memories"}
                </div>
              </Tooltip>
            ) : null}
            {seed.exec.length > 0 ? (
              <div>
                {seed.exec.length} exec {seed.exec.length === 1 ? "command" : "commands"}
              </div>
            ) : null}
          </div>
        )}
      </Fact>
    </div>
  );
}

function TaskWorkerBadge(props: { worker: number | "lead" }): ReactNode {
  if (props.worker === "lead") {
    return <span className="sc-task-worker sc-task-worker-lead">LEAD</span>;
  }
  return <span className="sc-task-worker">worker {props.worker}</span>;
}

function ProseColumn(props: { scenario: ScenarioJson }): ReactNode {
  const s = props.scenario;
  const llm = s.outcome.llmJudge;
  const agentic = s.outcome.agenticJudge;
  return (
    <div className="sc-prose">
      {s.description ? (
        <ProseBlock title="Description">
          <ClampBox>
            <Markdown text={s.description} />
          </ClampBox>
        </ProseBlock>
      ) : null}
      {llm ? (
        <ProseBlock
          title="LLM Judge Rubric"
          meta={llm.model !== null ? <ModelChip model={llm.model} dim /> : "default judge model"}
        >
          <ClampBox>
            <Markdown text={llm.rubric} />
          </ClampBox>
        </ProseBlock>
      ) : null}
      {agentic ? (
        <ProseBlock
          title="Agentic Judge Rubric"
          meta={
            <>
              {agentic.model !== null ? (
                <ModelChip model={agentic.model} dim />
              ) : (
                "default judge model"
              )}
              {agentic.maxSteps !== null ? ` · ≤${agentic.maxSteps} steps` : null}
            </>
          }
        >
          <ClampBox>
            <Markdown text={agentic.rubric} />
          </ClampBox>
        </ProseBlock>
      ) : null}
      <ProseBlock title="Checks">
        <ScenarioChecks scenario={s} />
      </ProseBlock>
      <ProseBlock title={`Tasks · ${s.tasks.length}`}>
        <div className="sc-tasks">
          {s.tasks.map((task, i) => (
            <div className="sc-task" key={`${String(i)}-${task.title}`}>
              <div className="sc-task-head">
                <span className="sc-task-idx">#{i}</span>
                <span className="sc-task-title">{task.title}</span>
                <TaskWorkerBadge worker={task.worker} />
                {task.dependsOn.length > 0 ? (
                  <span className="dim sc-task-deps">
                    after {task.dependsOn.map((d) => `#${d}`).join(", ")}
                  </span>
                ) : null}
              </div>
              <div className="sc-task-desc">
                <Markdown text={task.description} />
              </div>
            </div>
          ))}
        </div>
      </ProseBlock>
      {s.seed !== null && s.seed.exec.length > 0 ? (
        <ProseBlock title={`Seed Exec · ${s.seed.exec.length}`}>
          <div className="sc-exec">
            {s.seed.exec.map((cmd) => (
              <pre key={cmd}>
                <code>{cmd}</code>
              </pre>
            ))}
          </div>
        </ProseBlock>
      ) : null}
    </div>
  );
}

function checkTooltipText(name: string): string {
  const explanation = explainCheck(name);
  return `${explanation.title}\n${explanation.verifies}`;
}

function CheckChip(props: { name: string; gate?: boolean }): ReactNode {
  const explanation = explainCheck(props.name);
  return (
    <Tooltip wide text={<CheckTip name={props.name} />}>
      <code className={props.gate ? "sc-check sc-gate" : "sc-check"}>{explanation.title}</code>
    </Tooltip>
  );
}

function CheckTip(props: { name: string }): ReactNode {
  const explanation = explainCheck(props.name);
  return (
    <div className="tip-card">
      <div className="tip-card-title">{explanation.title}</div>
      <div className="tip-card-row">
        <span className="tip-card-label">Check</span>
        <span className="tip-card-value">
          <code>{props.name}</code>
        </span>
      </div>
      <div className="tip-card-row">
        <span className="tip-card-label">Verifies</span>
        <span className="tip-card-value">{explanation.verifies}</span>
      </div>
    </div>
  );
}

function ScenarioChecks(props: { scenario: ScenarioJson }): ReactNode {
  const { outcome } = props.scenario;
  const rows: Array<{ kind: string; name: string; dimension?: string }> = [
    ...(outcome.gates ?? []).map((name) => ({ kind: "Gate", name })),
    ...(outcome.dimensions ?? []).flatMap((d) =>
      d.checks.map((name) => ({ kind: "Dimension", name, dimension: d.name })),
    ),
  ];
  if (rows.length === 0) return <span className="dim">No deterministic checks.</span>;
  return (
    <div className="sc-check-list">
      {rows.map((row) => {
        const explanation = explainCheck(row.name);
        return (
          <div className="sc-check-row" key={`${row.kind}-${row.dimension ?? ""}-${row.name}`}>
            <div className="sc-check-row-head">
              <span className="sc-check-kind">{row.kind}</span>
              {row.dimension ? <span className="dim">{humanizeKey(row.dimension)}</span> : null}
              <code>{row.name}</code>
            </div>
            <div className="sc-check-row-title">{explanation.title}</div>
            <div className="sc-check-row-desc">{explanation.verifies}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * v7 §5.2 — WP-AAPI7 changes `GET /api/scenarios/:id` for unregistered ids to
 * 200 `{ scenario: null, scenarioId, recentAttempts }`. This local shape keeps
 * the page compiling against both the pre- and post-AAPI7 `getScenario` types;
 * the cast becomes an identity once api.ts declares the union.
 */
interface ScenarioDetailData {
  scenario: ScenarioJson | null;
  scenarioId?: string;
  recentAttempts: AttemptJson[];
}

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

  const detail = data as ScenarioDetailData;
  const { scenario, recentAttempts } = detail;

  // §5.2 graceful fallback: scenario removed from the registry — historical
  // attempts still render; no Definition panel.
  if (!scenario) {
    const bareId = detail.scenarioId ?? props.scenarioId;
    return (
      <>
        <div className="panel sc-header">
          <a className="entity-link" href="#/scenarios">
            ← Scenarios
          </a>
          <span className="chip">{bareId}</span>
          <span className="sc-unregistered">
            Unregistered scenario (removed from the registry — historical attempts below)
          </span>
          {error ? <span className="sc-error">{error}</span> : null}
        </div>
        <AttemptsPanel attempts={recentAttempts} />
      </>
    );
  }

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
        <div className="sc-def">
          <FactsColumn scenario={scenario} />
          <ProseColumn scenario={scenario} />
        </div>
        <details className="sc-raw">
          <summary className="sc-raw-summary">Raw JSON</summary>
          <div className="sc-raw-body">
            <PrettyView
              value={scenario}
              rawLabel="scenario"
              defaultRaw
              renderers={{
                model: (v) => <ModelChip model={typeof v === "string" ? v : null} />,
              }}
            />
          </div>
        </details>
      </div>
      <AttemptsPanel attempts={recentAttempts} />
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

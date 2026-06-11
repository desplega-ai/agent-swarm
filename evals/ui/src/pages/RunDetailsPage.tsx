import { type ReactNode, useMemo, useState } from "react";
import { artifactUrl, cancelRun, getAttempt, getRun, resumeRun } from "../api.ts";
import { type Column, DataTable } from "../components/DataTable.tsx";
import { fmtAgo, fmtBytes, fmtDate, fmtDuration, fmtScore } from "../components/format.ts";
import { JsonView } from "../components/JsonView.tsx";
import { Matrix } from "../components/Matrix.tsx";
import { Elapsed, Spinner } from "../components/Spinner.tsx";
import { CostBadge, StatusBadge } from "../components/StatusBadge.tsx";
import { InfoTip } from "../components/Tooltip.tsx";
import { navigate, usePoll } from "../hooks.ts";
import type {
  ArtifactMetaJson,
  AttemptDetail,
  AttemptJson,
  JudgmentJson,
  PhaseTimingsJson,
  RunDetail,
  SandboxInfoJson,
} from "../types.ts";
import Transcript from "./Transcript.tsx";
import "./run-details.css";

function isUnfinished(status: string | null): boolean {
  return status === "pending" || status === "running" || status === "judging";
}

/** First attempt of the first cell (scenario-major), falling back to the first attempt. */
function defaultAttemptId(run: RunDetail | null): string | null {
  if (!run || run.attempts.length === 0) return null;
  for (const scenarioId of run.run.scenarioIds) {
    for (const configId of run.run.configIds) {
      const cellAttempts = run.attempts
        .filter((a) => a.scenarioId === scenarioId && a.configId === configId)
        .sort((a, b) => a.attemptIndex - b.attemptIndex);
      if (cellAttempts.length > 0) return cellAttempts[0].id;
    }
  }
  return run.attempts[0].id;
}

function safeDelta(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return to - from;
}

function dotTone(status: string): string {
  if (status === "passed") return "green";
  if (status === "failed" || status === "error") return "red";
  if (status === "running" || status === "judging") return "accent";
  return "dim";
}

const ASSET_COLUMNS: Column<ArtifactMetaJson>[] = [
  {
    key: "kind",
    header: "kind",
    filterOptions: (rows) => Array.from(new Set(rows.map((r) => r.kind))).sort(),
    filterValue: (r) => r.kind,
    searchText: (r) => r.kind,
    render: (r) => <span className="chip">{r.kind}</span>,
  },
  {
    key: "name",
    header: "name",
    searchText: (r) => r.name ?? "",
    render: (r) => <code className="rd-mono">{r.name ?? r.id}</code>,
  },
  {
    key: "size",
    header: "size",
    align: "right",
    sortValue: (r) => r.size,
    render: (r) => fmtBytes(r.size),
  },
  {
    key: "created",
    header: "created",
    sortValue: (r) => r.createdAt,
    render: (r) => <span title={r.createdAt}>{fmtAgo(r.createdAt)}</span>,
  },
  {
    key: "actions",
    header: "actions",
    sortable: false,
    render: (r) => (
      <span className="rd-asset-actions">
        <a className="entity-link" href={artifactUrl(r.id)} target="_blank" rel="noreferrer">
          open
        </a>
        <a className="entity-link" href={artifactUrl(r.id, { download: true })}>
          download
        </a>
      </span>
    ),
  },
];

export default function RunDetailsPage(props: {
  runId: string;
  attemptId: string | null;
}): ReactNode {
  const { runId } = props;

  // Poll cadence follows `active` from the response itself (3s live, 15s settled).
  const [active, setActive] = useState(false);
  const runPoll = usePoll(
    async () => {
      const result = await getRun(runId);
      setActive(result.active);
      return result;
    },
    active ? 3000 : 15_000,
    [runId],
  );
  const run = runPoll.data && runPoll.data.run.id === runId ? runPoll.data : null;
  const attempts = useMemo(() => run?.attempts ?? [], [run]);

  const selId = props.attemptId ?? defaultAttemptId(run);
  const runAttempt = selId ? (attempts.find((a) => a.id === selId) ?? null) : null;

  const attemptPoll = usePoll<AttemptDetail | null>(
    () => (selId ? getAttempt(selId) : Promise.resolve(null)),
    selId && isUnfinished(runAttempt?.status ?? null) ? 4000 : null,
    [selId],
  );
  const detail =
    attemptPoll.data && attemptPoll.data.attempt.id === selId ? attemptPoll.data : null;
  const attempt = detail?.attempt ?? runAttempt;
  const attemptUnfinished = attempt !== null && isUnfinished(attempt.status);

  const [tab, setTab] = useState<"transcript" | "assets">("transcript");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!run) {
    return (
      <div className="panel">
        {runPoll.error ? (
          <span className="rd-load-error">failed to load run: {runPoll.error}</span>
        ) : (
          <Spinner label="loading run…" />
        )}
      </div>
    );
  }

  const r = run.run;
  const totals = run.totals;
  const canCancel = run.active;
  const canResume =
    !run.active && attempts.some((a) => isUnfinished(a.status) || a.status === "error");

  const act = (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    fn()
      .then(() => runPoll.refresh())
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const wallTime: ReactNode = r.finishedAt ? (
    fmtDuration(safeDelta(r.createdAt, r.finishedAt))
  ) : run.active ? (
    <Elapsed since={r.createdAt} />
  ) : (
    "—"
  );

  const cellAttempts = attempt
    ? attempts
        .filter((a) => a.scenarioId === attempt.scenarioId && a.configId === attempt.configId)
        .sort((a, b) => a.attemptIndex - b.attemptIndex)
    : [];

  const artifacts = detail?.artifacts ?? [];

  return (
    <>
      <div className="panel rd-top">
        <div className="rd-title-row">
          <a className="rd-back" href="#/runs">
            ← runs
          </a>
          <h2 className="rd-name">{r.name ?? r.id}</h2>
          {r.name ? <span className="chip rd-mono">{r.id}</span> : null}
          <StatusBadge status={r.status} />
          {run.active ? <Spinner label="live" /> : null}
          <span className="rd-spacer" />
          {canCancel ? (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm("cancel this run?")) act(() => cancelRun(runId));
              }}
            >
              cancel
            </button>
          ) : null}
          {canResume ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => act(() => resumeRun(runId))}
            >
              resume
            </button>
          ) : null}
        </div>
        {actionError ? <div className="rd-load-error">{actionError}</div> : null}
        <div className="meta-grid">
          <Meta label="created" title={r.createdAt}>
            {fmtDate(r.createdAt)} · {fmtAgo(r.createdAt)}
          </Meta>
          <Meta label="finished" title={r.finishedAt ?? undefined}>
            {fmtDate(r.finishedAt)}
          </Meta>
          <Meta label="wall time">{wallTime}</Meta>
          <Meta label="total cost">
            <CostBadge costUsd={totals.totalCostUsd} source={null} />
            {totals.unpricedAttempts > 0 ? (
              <InfoTip text={`${totals.unpricedAttempts} unpriced attempt(s) not included`} />
            ) : null}
          </Meta>
          <Meta label="attempts">
            {totals.finished}/{totals.attempts} · {totals.passedAttempts} passed ·{" "}
            {totals.errorAttempts} err
          </Meta>
          <Meta label={`best@${r.attemptsPerCell}`}>
            {totals.passedCells}/{totals.totalCells} cells
          </Meta>
          <Meta label="concurrency">{r.concurrency}</Meta>
          <Meta label="judge model">
            {r.judgeModel ? (
              <code className="rd-mono">{r.judgeModel}</code>
            ) : (
              <span className="dim">default</span>
            )}
          </Meta>
          <Meta label="matrix">
            {r.scenarioIds.length} scenarios × {r.configIds.length} configs
          </Meta>
        </div>
      </div>

      <div className="layout-30-70 rd-body">
        <div className="rd-left">
          <div className="panel">
            <div className="panel-title">matrix</div>
            <div className="rd-matrix-wrap">
              <Matrix
                scenarioIds={r.scenarioIds}
                configIds={r.configIds}
                cells={run.cells}
                attempts={attempts}
                cellHref={(scenarioId, configId) =>
                  `#/runs/${runId}/attempts/${runId}_${scenarioId}_${configId}_0`
                }
                selected={
                  attempt ? { scenarioId: attempt.scenarioId, configId: attempt.configId } : null
                }
              />
            </div>
            {cellAttempts.length > 1 ? (
              <div className="rd-attempt-picker">
                {cellAttempts.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    className={a.id === selId ? "btn rd-att-btn selected" : "btn rd-att-btn"}
                    onClick={() => navigate(`#/runs/${runId}/attempts/${a.id}`)}
                  >
                    <span className={`rd-dot ${dotTone(a.status)}`} />#{a.attemptIndex}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <AttemptSummary attempt={attempt} selId={selId} error={attemptPoll.error} />
          <TimingsPanel attempt={attempt} />
          <SandboxPanel attempt={attempt} />
          <JudgmentsPanel attempt={attempt} judgments={detail?.judgments ?? []} />
        </div>

        <div className="rd-right panel">
          <div className="tabs">
            <button
              type="button"
              className={tab === "transcript" ? "tab active" : "tab"}
              onClick={() => setTab("transcript")}
            >
              transcript
            </button>
            <button
              type="button"
              className={tab === "assets" ? "tab active" : "tab"}
              onClick={() => setTab("assets")}
            >
              assets
            </button>
          </div>
          {tab === "transcript" ? (
            selId ? (
              <Transcript key={selId} attemptId={selId} live={attemptUnfinished} />
            ) : (
              <div className="dim">no attempt selected</div>
            )
          ) : (
            <>
              <DataTable
                rows={artifacts}
                columns={ASSET_COLUMNS}
                rowKey={(row) => row.id}
                emptyText="no artifacts yet"
                searchPlaceholder="search artifacts…"
                maxHeight="70vh"
              />
              {artifacts.length === 0 && attemptUnfinished ? (
                <div className="rd-stage">
                  <Spinner label="artifacts land as the attempt progresses…" />
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Meta(props: { label: string; title?: string; children: ReactNode }): ReactNode {
  return (
    <div>
      <div className="meta-label">{props.label}</div>
      <div className="meta-value" title={props.title}>
        {props.children}
      </div>
    </div>
  );
}

function AttemptSummary(props: {
  attempt: AttemptJson | null;
  selId: string | null;
  error: string | null;
}): ReactNode {
  const { attempt } = props;
  if (!attempt) {
    return (
      <div className="panel">
        <div className="panel-title">attempt</div>
        {props.selId && props.error ? (
          <div className="rd-load-error">failed to load attempt: {props.error}</div>
        ) : (
          <div className="dim">no attempts yet</div>
        )}
      </div>
    );
  }
  const live = attempt.status === "running" || attempt.status === "judging";
  return (
    <div className="panel">
      <div className="panel-title">
        attempt #{attempt.attemptIndex}
        <span className="dim rd-attempt-id"> {attempt.id}</span>
      </div>
      {attempt.status === "pending" ? (
        <div className="rd-stage">
          <Spinner label="waiting for a pool slot…" />
        </div>
      ) : null}
      {attempt.status === "running" && !attempt.sandbox ? (
        <div className="rd-stage">
          <Spinner label="booting sandboxes…" />
        </div>
      ) : null}
      <div className="meta-grid">
        <Meta label="status">
          <StatusBadge status={attempt.status} />
        </Meta>
        <Meta label="score">{fmtScore(attempt.score)}</Meta>
        <Meta label="cost">
          <CostBadge costUsd={attempt.costUsd} source={attempt.costSource} />
        </Meta>
        <Meta label="duration">
          {live ? <Elapsed since={attempt.startedAt} /> : fmtDuration(attempt.durationMs)}
        </Meta>
        <Meta label="retries">{attempt.retries}</Meta>
        <Meta label="started" title={attempt.startedAt ?? undefined}>
          {fmtDate(attempt.startedAt)}
        </Meta>
        <Meta label="finished" title={attempt.finishedAt ?? undefined}>
          {fmtDate(attempt.finishedAt)}
        </Meta>
        {attempt.tokens ? (
          <Meta label="model">
            {attempt.tokens.model ? <code className="rd-mono">{attempt.tokens.model}</code> : "—"}
          </Meta>
        ) : null}
      </div>
      {attempt.taskIds.length > 0 ? (
        <div className="rd-tasks">
          <span className="meta-label">tasks</span>
          {attempt.taskIds.map((taskId) => (
            <code className="chip rd-mono" key={taskId}>
              {taskId}
            </code>
          ))}
        </div>
      ) : null}
      {attempt.error ? <div className="rd-attempt-error">{attempt.error}</div> : null}
    </div>
  );
}

const TIMING_PHASES: { key: Exclude<keyof PhaseTimingsJson, "perTask">; label: string }[] = [
  { key: "bootMs", label: "boot" },
  { key: "seedMs", label: "seed" },
  { key: "tasksMs", label: "tasks" },
  { key: "logCaptureMs", label: "log capture" },
  { key: "costMs", label: "cost wait" },
  { key: "checksMs", label: "checks" },
  { key: "llmJudgeMs", label: "llm judge" },
  { key: "agenticJudgeMs", label: "agentic judge" },
  { key: "artifactsMs", label: "artifacts" },
];

function TimingsPanel(props: { attempt: AttemptJson | null }): ReactNode {
  const timings = props.attempt?.timings ?? null;
  return (
    <div className="panel">
      <div className="panel-title">phase timings</div>
      {timings ? (
        <table className="rd-timings">
          <tbody>
            {TIMING_PHASES.map((phase) => {
              const rows: ReactNode[] = [
                <tr key={phase.key}>
                  <td>{phase.label}</td>
                  <td>{fmtDuration(timings[phase.key])}</td>
                </tr>,
              ];
              if (phase.key === "tasksMs") {
                for (const t of timings.perTask) {
                  rows.push(
                    <tr className="sub" key={`task-${t.taskId}`}>
                      <td>task {t.taskId}</td>
                      <td>{fmtDuration(t.ms)}</td>
                    </tr>,
                  );
                }
              }
              return rows;
            })}
          </tbody>
        </table>
      ) : props.attempt && isUnfinished(props.attempt.status) ? (
        <div className="dim rd-not-captured">timings land when the attempt finishes</div>
      ) : (
        <div className="dim rd-not-captured">timings not captured (older run)</div>
      )}
    </div>
  );
}

function SandboxPanel(props: { attempt: AttemptJson | null }): ReactNode {
  const sandbox = props.attempt?.sandbox ?? null;
  return (
    <div className="panel">
      <div className="panel-title">sandbox</div>
      {sandbox ? (
        <SandboxGrid sandbox={sandbox} />
      ) : props.attempt && isUnfinished(props.attempt.status) ? (
        <div className="dim rd-not-captured">sandbox not booted yet</div>
      ) : (
        <div className="dim rd-not-captured">sandbox info not captured (older run)</div>
      )}
    </div>
  );
}

function SandboxGrid(props: { sandbox: SandboxInfoJson }): ReactNode {
  const sb = props.sandbox;
  return (
    <div className="meta-grid">
      <Meta label="worker sandbox">
        <code className="rd-mono">{sb.workerSandboxId}</code>
      </Meta>
      <Meta label="api sandbox">
        <code className="rd-mono">{sb.apiSandboxId}</code>
      </Meta>
      <Meta label="worker template">{sb.workerTemplate}</Meta>
      <Meta label="api template">{sb.apiTemplate}</Meta>
      <Meta label="api url">
        <a href={sb.apiUrl} target="_blank" rel="noreferrer">
          {sb.apiUrl}
        </a>{" "}
        <InfoTip text="dead after sandbox teardown" />
      </Meta>
      <Meta label="swarm api key">
        <CopyCode text={sb.swarmKey} />
      </Meta>
      <Meta label="worker agent">
        <code className="rd-mono">{sb.workerAgentId}</code>
      </Meta>
      <Meta label="domain">{sb.domain ?? "—"}</Meta>
      <Meta label="api started" title={sb.apiStartedAt ?? undefined}>
        {fmtDate(sb.apiStartedAt)}
      </Meta>
      <Meta label="worker started" title={sb.workerStartedAt ?? undefined}>
        {fmtDate(sb.workerStartedAt)}
      </Meta>
      <Meta label="expires" title={sb.expiresAt ?? undefined}>
        {fmtDate(sb.expiresAt)}
      </Meta>
    </div>
  );
}

function CopyCode(props: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rd-copy"
      title="click to copy"
      onClick={() => {
        void navigator.clipboard.writeText(props.text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      <code>{props.text}</code>
      {copied ? <span className="accent"> copied</span> : null}
    </button>
  );
}

function JudgmentsPanel(props: {
  attempt: AttemptJson | null;
  judgments: JudgmentJson[];
}): ReactNode {
  const { attempt, judgments } = props;
  const judging = attempt?.status === "judging";
  return (
    <div className="panel">
      <div className="panel-title">checks &amp; judgments</div>
      {judging ? (
        <div className="rd-stage">
          <Spinner label="judging…" />
        </div>
      ) : null}
      {judgments.length === 0 && !judging ? (
        <div className="dim">
          {attempt && isUnfinished(attempt.status) ? "no judgments yet" : "no judgments"}
        </div>
      ) : null}
      {judgments.map((j) => (
        <JudgmentBlock judgment={j} key={j.id} />
      ))}
    </div>
  );
}

function JudgmentBlock(props: { judgment: JudgmentJson }): ReactNode {
  const j = props.judgment;
  return (
    <div className={`rd-judgment ${j.pass ? "pass" : "fail"}`}>
      <div className="rd-judgment-head">
        <span className="rd-judgment-name">{j.name}</span>
        <span className="chip">{j.kind}</span>
        <span className={j.pass ? "rd-pf pass" : "rd-pf fail"}>{j.pass ? "✓ pass" : "✗ fail"}</span>
        {j.score !== null ? <span className="rd-mono">{fmtScore(j.score)}</span> : null}
        <span className="dim" title={j.createdAt}>
          {fmtAgo(j.createdAt)}
        </span>
      </div>
      {j.reasoning ? <div className="rd-judgment-reason">{j.reasoning}</div> : null}
      {j.raw !== null ? <RawJson raw={j.raw} /> : null}
    </div>
  );
}

function RawJson(props: { raw: string }): ReactNode {
  const parsed = useMemo<{ ok: true; value: unknown } | { ok: false }>(() => {
    try {
      return { ok: true, value: JSON.parse(props.raw) as unknown };
    } catch {
      return { ok: false };
    }
  }, [props.raw]);
  if (!parsed.ok) return <pre className="rd-raw">{props.raw}</pre>;
  return (
    <div className="rd-judgment-raw">
      <JsonView value={parsed.value} collapseDepth={1} label="raw" />
    </div>
  );
}

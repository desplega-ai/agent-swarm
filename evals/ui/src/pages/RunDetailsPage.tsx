import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  artifactUrl,
  cancelRun,
  getAttempt,
  getAttemptProgress,
  getJudgeLive,
  getRun,
  resumeRun,
} from "../api.ts";
import { ConfigChip } from "../components/ConfigChip.tsx";
import { useConfirm } from "../components/ConfirmDialog.tsx";
import { type Column, DataTable } from "../components/DataTable.tsx";
import { EntityLink } from "../components/EntityLink.tsx";
import {
  fmtAgo,
  fmtBytes,
  fmtCost,
  fmtDate,
  fmtDuration,
  fmtScore,
  humanizeKey,
} from "../components/format.ts";
import { Matrix } from "../components/Matrix.tsx";
import { ModelChip } from "../components/ModelChip.tsx";
import { PrettyView } from "../components/PrettyView.tsx";
import { Elapsed, Spinner } from "../components/Spinner.tsx";
import {
  CostBadge,
  StatusBadge,
  StatusScore,
  statusGlyphInfo,
} from "../components/StatusBadge.tsx";
import { InfoTip, Tooltip } from "../components/Tooltip.tsx";
import { navigate, useConfigs, usePoll } from "../hooks.ts";
import type {
  ArtifactMetaJson,
  AttemptDetail,
  AttemptJson,
  AttemptProgressResponse,
  ConfigJson,
  JudgeLiveResponse,
  JudgeTraceJson,
  JudgmentJson,
  PhaseTimingsJson,
  ProgressLogLevelJson,
  RunDetail,
  SandboxInfoJson,
} from "../types.ts";
import JudgeTrace from "./JudgeTrace.tsx";
import Transcript from "./Transcript.tsx";
import Waterfall from "./Waterfall.tsx";
import "./run-details.css";

type RdTab = "transcript" | "checks" | "timings" | "logs" | "assets";

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

// ---- assets tab (item 16: kind → glyph with hover info, names truncated) ----

const ASSET_KIND_GLYPHS: Record<string, string> = {
  "raw-session-logs": "≋",
  transcript: "☰",
  "harness-session": "⌂",
  meta: "ⓘ",
  "sandbox-log": "▤",
  log: "≣",
};

function assetKindGlyph(kind: string): string {
  return ASSET_KIND_GLYPHS[kind] ?? "▢";
}

const ASSET_COLUMNS: Column<ArtifactMetaJson>[] = [
  {
    key: "kind",
    header: "Kind",
    width: "52px",
    align: "center",
    filterOptions: (rows) => Array.from(new Set(rows.map((r) => r.kind))).sort(),
    filterValue: (r) => r.kind,
    filterRender: (option) => (
      <>
        <span className="rd-kind-glyph">{assetKindGlyph(option)}</span> {humanizeKey(option)}
      </>
    ),
    searchText: (r) => r.kind,
    titleText: (r) => humanizeKey(r.kind),
    render: (r) => (
      <Tooltip text={humanizeKey(r.kind)}>
        <span className="rd-kind-glyph" role="img" aria-label={humanizeKey(r.kind)}>
          {assetKindGlyph(r.kind)}
        </span>
      </Tooltip>
    ),
  },
  {
    key: "name",
    header: "Name",
    searchText: (r) => r.name ?? r.id,
    render: (r) => <code className="rd-mono">{r.name ?? r.id}</code>,
  },
  {
    key: "size",
    header: "Size",
    width: "76px",
    align: "right",
    sortValue: (r) => r.size,
    searchText: (r) => fmtBytes(r.size),
    render: (r) => fmtBytes(r.size),
  },
  {
    key: "created",
    header: "Created",
    width: "92px",
    sortValue: (r) => r.createdAt,
    titleText: (r) => r.createdAt,
    render: (r) => fmtAgo(r.createdAt),
  },
  {
    key: "actions",
    header: "Actions",
    width: "130px",
    sortable: false,
    render: (r) => (
      <span className="rd-asset-actions">
        <a className="entity-link" href={artifactUrl(r.id)} target="_blank" rel="noreferrer">
          Open
        </a>
        <a className="entity-link" href={artifactUrl(r.id, { download: true })}>
          Download
        </a>
      </span>
    ),
  },
];

// ---- checks tab label (item 11: count + one ✶ per judge, ONE spinner while judging) ----

function checksTabInfo(
  judgments: JudgmentJson[],
  judging: boolean,
): { node: ReactNode; title: string } {
  const checks = judgments.filter((j) => j.kind === "deterministic");
  const judges = judgments.filter((j) => j.kind !== "deterministic");
  const passed = checks.filter((j) => j.pass).length;
  const label = checks.length > 0 ? `Checks ${passed}/${checks.length}` : "Checks";
  const titleParts: string[] = [
    checks.length > 0
      ? `${passed} of ${checks.length} checks passed`
      : judgments.length === 0 && !judging
        ? "Deterministic checks & judge verdicts"
        : "No deterministic checks",
  ];
  let suffix: ReactNode = null;
  if (judging) {
    // Single-animation rule: this spinner is the ONLY animated element in the tab bar.
    suffix = <Spinner />;
    titleParts.push("Judging…");
  } else if (judges.length > 0) {
    suffix = judges.map((j) => (
      <span
        key={j.id}
        className={j.pass ? "tone-green" : "tone-red"}
        role="img"
        aria-label={j.name}
      >
        ✶
      </span>
    ));
    for (const j of judges) {
      const score = j.score !== null ? ` (${fmtScore(j.score)})` : "";
      titleParts.push(`${j.name} — ${j.pass ? "Passed" : "Failed"}${score}`);
    }
  }
  return {
    node: (
      <>
        {label}
        {suffix !== null ? <span className="rd-tab-judges">{suffix}</span> : null}
      </>
    ),
    title: titleParts.join("\n"),
  };
}

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

  // Config catalog (cached per session) — model fallback for the attempt summary.
  const configs = useConfigs();

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

  // Live judge traces while the attempt is in its judging phase (v3 spec §8.2).
  const judging = attempt?.status === "judging";
  const judgeLivePoll = usePoll<JudgeLiveResponse | null>(
    () => (selId && judging ? getJudgeLive(selId) : Promise.resolve(null)),
    judging ? 2000 : null,
    [selId, judging],
  );
  const judgeLive = judging ? judgeLivePoll.data : null;

  // Live runner progress (v4 items 6 + 14) — shared by the Timings + Logs tabs.
  const progressPoll = usePoll<AttemptProgressResponse | null>(
    () => (selId !== null && attemptUnfinished ? getAttemptProgress(selId) : Promise.resolve(null)),
    selId !== null && attemptUnfinished ? 2000 : null,
    [selId, attemptUnfinished],
  );
  const progress = attemptUnfinished ? (progressPoll.data ?? null) : null;

  const [tab, setTab] = useState<RdTab>("transcript");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Cancel flow (item 12): in-app confirm + "Cancelling…" until `active` flips false.
  const { confirm, confirmDialog } = useConfirm();
  const [cancelRequested, setCancelRequested] = useState(false);
  useEffect(() => {
    if (!active) setCancelRequested(false);
  }, [active]);

  if (!run) {
    return (
      <div className="panel">
        {runPoll.error ? (
          <span className="rd-load-error">Failed to load run: {runPoll.error}</span>
        ) : (
          <Spinner label="Loading run…" />
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

  const onCancelClick = () => {
    void (async () => {
      const ok = await confirm({
        title: "Cancel This Run?",
        message:
          "In-flight attempts are torn down and go back to Pending — Resume continues them later.",
        confirmLabel: "Cancel Run",
        cancelLabel: "Keep Running",
        danger: true,
      });
      if (!ok) return;
      setBusy(true);
      setActionError(null);
      try {
        await cancelRun(runId);
        setCancelRequested(true);
        runPoll.refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
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
  const judgments = detail?.judgments ?? [];
  const checksTab = checksTabInfo(judgments, judging);

  return (
    <>
      {confirmDialog}
      <div className="panel rd-top">
        <div className="rd-title-row">
          <a className="rd-back" href="#/runs">
            ← Runs
          </a>
          <h2 className="rd-name">{r.name ?? r.id}</h2>
          {r.name ? <span className="chip rd-mono">{r.id}</span> : null}
          {/* Single-animation rule (item 7): status + live affordance are ONE element. */}
          <StatusBadge status={r.status} activeLabel={run.active ? "Live" : undefined} />
          <span className="rd-spacer" />
          {canCancel ? (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || cancelRequested}
              onClick={onCancelClick}
            >
              {cancelRequested ? "Cancelling…" : "Cancel"}
            </button>
          ) : null}
          {canResume ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => act(() => resumeRun(runId))}
            >
              Resume
            </button>
          ) : null}
        </div>
        {actionError ? <div className="rd-load-error">{actionError}</div> : null}
        <div className="meta-grid">
          <Meta label="Created" title={r.createdAt}>
            {fmtDate(r.createdAt)} · {fmtAgo(r.createdAt)}
          </Meta>
          <Meta label="Finished" title={r.finishedAt ?? undefined}>
            {fmtDate(r.finishedAt)}
          </Meta>
          <Meta label="Wall Time">{wallTime}</Meta>
          <Meta label="Total Cost">
            <CostBadge costUsd={totals.totalCostUsd} source={null} />
            {totals.unpricedAttempts > 0 ? (
              <InfoTip text={`${totals.unpricedAttempts} unpriced attempt(s) not included`} />
            ) : null}
          </Meta>
          <Meta label="Judge Cost">
            <span className={totals.judgeCostUsd === null ? "cost-badge dim" : "cost-badge"}>
              {fmtCost(totals.judgeCostUsd)}
            </span>{" "}
            <InfoTip text="Judge LLM cost — not included in Total Cost" />
          </Meta>
          <Meta label="Attempts">
            {totals.finished}/{totals.attempts} · {totals.passedAttempts} Passed ·{" "}
            {totals.errorAttempts} Errors
          </Meta>
          <Meta label={`Best@${r.attemptsPerCell}`}>
            {totals.passedCells}/{totals.totalCells} Cells
          </Meta>
          <Meta label="Concurrency">{r.concurrency}</Meta>
          <Meta label="Judge Model">
            {r.judgeModel ? (
              <ModelChip model={r.judgeModel} />
            ) : (
              <span className="dim">Default</span>
            )}
          </Meta>
          <Meta label="Matrix">
            {r.scenarioIds.length} Scenarios × {r.configIds.length} Configs
          </Meta>
        </div>
      </div>

      <div className="layout-30-70 rd-body">
        <div className="rd-left scroll-col">
          <div className="panel">
            <div className="panel-title">Matrix</div>
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
                {cellAttempts.map((a) => {
                  const info = statusGlyphInfo(a.status);
                  return (
                    <button
                      type="button"
                      key={a.id}
                      className={a.id === selId ? "btn rd-att-btn selected" : "btn rd-att-btn"}
                      title={`Attempt #${a.attemptIndex} · ${info.label}`}
                      onClick={() => navigate(`#/runs/${runId}/attempts/${a.id}`)}
                    >
                      <span className={`rd-dot ${info.tone}`} />#{a.attemptIndex}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <AttemptSummary
            attempt={attempt}
            selId={selId}
            error={attemptPoll.error}
            config={attempt ? configs.byId(attempt.configId) : null}
          />
          <SandboxPanel attempt={attempt} />
        </div>

        {/* Item 5: the tab bar pins at the very top of the pane; only the content scrolls. */}
        <div className="rd-right panel">
          <div className="tabs rd-tabs">
            <button
              type="button"
              className={tab === "transcript" ? "tab active" : "tab"}
              onClick={() => setTab("transcript")}
            >
              Transcript
            </button>
            <button
              type="button"
              className={tab === "checks" ? "tab active" : "tab"}
              title={checksTab.title}
              onClick={() => setTab("checks")}
            >
              {checksTab.node}
            </button>
            <button
              type="button"
              className={tab === "timings" ? "tab active" : "tab"}
              onClick={() => setTab("timings")}
            >
              Timings
            </button>
            <button
              type="button"
              className={tab === "logs" ? "tab active" : "tab"}
              onClick={() => setTab("logs")}
            >
              Logs
            </button>
            <button
              type="button"
              className={tab === "assets" ? "tab active" : "tab"}
              onClick={() => setTab("assets")}
            >
              Assets
            </button>
          </div>
          <div className="rd-tab-content">
            {tab === "transcript" ? (
              selId ? (
                <Transcript key={selId} attemptId={selId} live={attemptUnfinished} />
              ) : (
                <div className="dim">No attempt selected</div>
              )
            ) : tab === "checks" ? (
              <ChecksTab attempt={attempt} judgments={judgments} live={judgeLive} />
            ) : tab === "timings" ? (
              <TimingsTab attempt={attempt} progress={progress} />
            ) : tab === "logs" ? (
              <LogsTab attempt={attempt} artifacts={artifacts} progress={progress} />
            ) : (
              <>
                <DataTable
                  rows={artifacts}
                  columns={ASSET_COLUMNS}
                  rowKey={(row) => row.id}
                  emptyText="No artifacts yet"
                  searchPlaceholder="Search artifacts…"
                />
                {artifacts.length === 0 && attemptUnfinished ? (
                  <div className="rd-stage">
                    <Spinner label="Artifacts land as the attempt progresses…" />
                  </div>
                ) : null}
              </>
            )}
          </div>
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
  config: ConfigJson | null;
}): ReactNode {
  const { attempt, config } = props;
  if (!attempt) {
    return (
      <div className="panel">
        <div className="panel-title">Attempt</div>
        {props.selId && props.error ? (
          <div className="rd-load-error">Failed to load attempt: {props.error}</div>
        ) : (
          <div className="dim">No attempts yet</div>
        )}
      </div>
    );
  }
  const live = attempt.status === "running" || attempt.status === "judging";
  return (
    <div className="panel">
      <div className="panel-title">
        Attempt #{attempt.attemptIndex}
        <span className="dim rd-attempt-id"> {attempt.id}</span>
      </div>
      {attempt.status === "pending" ? (
        <div className="rd-stage">
          <Spinner label="Waiting for a pool slot…" />
        </div>
      ) : null}
      {attempt.status === "running" && !attempt.sandbox ? (
        <div className="rd-stage">
          <Spinner label="Booting sandboxes…" />
        </div>
      ) : null}
      <div className="meta-grid">
        <Meta label="Status">
          <StatusScore status={attempt.status} score={attempt.score} />
        </Meta>
        <Meta label="Cost">
          <CostBadge costUsd={attempt.costUsd} source={attempt.costSource} />
        </Meta>
        <Meta label="Judge Cost">
          <span className={attempt.judgeCostUsd === null ? "cost-badge dim" : "cost-badge"}>
            {fmtCost(attempt.judgeCostUsd)}
          </span>{" "}
          <InfoTip text="Judge LLM cost — not included in Total Cost" />
        </Meta>
        <Meta label="Duration">
          {live ? <Elapsed since={attempt.startedAt} /> : fmtDuration(attempt.durationMs)}
        </Meta>
        <Meta label="Retries">{attempt.retries}</Meta>
        <Meta label="Started" title={attempt.startedAt ?? undefined}>
          {fmtDate(attempt.startedAt)}
        </Meta>
        <Meta label="Finished" title={attempt.finishedAt ?? undefined}>
          {fmtDate(attempt.finishedAt)}
        </Meta>
        <Meta label="Model">
          <ModelChip model={attempt.tokens?.model ?? config?.model ?? null} />
        </Meta>
        <Meta label="Scenario">
          <EntityLink kind="scenario" id={attempt.scenarioId} />
        </Meta>
        <Meta label="Config">
          <ConfigChip configId={attempt.configId} link />
        </Meta>
      </div>
      {attempt.taskIds.length > 0 ? (
        <div className="rd-tasks">
          <span className="meta-label">Tasks</span>
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

// ---- timings tab (item 7 + v4 item 6: live waterfall while the attempt runs) ----

const EMPTY_TIMINGS: PhaseTimingsJson = {
  bootMs: null,
  seedMs: null,
  tasksMs: null,
  perTask: [],
  logCaptureMs: null,
  costMs: null,
  checksMs: null,
  llmJudgeMs: null,
  agenticJudgeMs: null,
  artifactsMs: null,
};

function TimingsTab(props: {
  attempt: AttemptJson | null;
  progress: AttemptProgressResponse | null;
}): ReactNode {
  const { attempt, progress } = props;
  if (!attempt) return <div className="dim">No attempt selected</div>;
  if (isUnfinished(attempt.status) && progress !== null && progress.active) {
    const timings: PhaseTimingsJson = { ...EMPTY_TIMINGS, ...progress.phases };
    return (
      <Waterfall
        timings={timings}
        totalMs={null}
        live={{
          currentPhase: progress.currentPhase,
          currentPhaseStartedAt: progress.currentPhaseStartedAt,
        }}
      />
    );
  }
  if (attempt.timings) {
    return <Waterfall timings={attempt.timings} totalMs={attempt.durationMs} />;
  }
  if (isUnfinished(attempt.status)) {
    return <div className="dim rd-not-captured">Timings land when the attempt finishes</div>;
  }
  return <div className="dim rd-not-captured">Timings not captured (older run)</div>;
}

// ---- sandbox panel (item 14: PrettyView with Raw JSON toggle) ----

const SANDBOX_LABELS: Record<string, string> = {
  swarmKey: "Swarm API Key",
  apiSandboxId: "API Sandbox",
  workerSandboxId: "Worker Sandbox",
  workerAgentId: "Worker Agent",
  apiVersion: "API Version",
  workerVersion: "Worker Version",
};

function monoRenderer(value: unknown): ReactNode {
  return <code className="rd-mono">{String(value)}</code>;
}

function SandboxPanel(props: { attempt: AttemptJson | null }): ReactNode {
  const sandbox = props.attempt?.sandbox ?? null;
  return (
    <div className="panel">
      <div className="panel-title">Sandbox</div>
      {sandbox ? (
        <SandboxView sandbox={sandbox} />
      ) : props.attempt && isUnfinished(props.attempt.status) ? (
        <div className="dim rd-not-captured">Sandbox not booted yet</div>
      ) : (
        <div className="dim rd-not-captured">Sandbox info not captured (older run)</div>
      )}
    </div>
  );
}

function SandboxView(props: { sandbox: SandboxInfoJson }): ReactNode {
  return (
    <PrettyView
      value={props.sandbox}
      rawLabel="Sandbox"
      labels={SANDBOX_LABELS}
      renderers={{
        swarmKey: (v) => <CopyCode text={String(v)} />,
        apiSandboxId: monoRenderer,
        workerSandboxId: monoRenderer,
        workerAgentId: monoRenderer,
        apiUrl: (v) => (
          <>
            <a className="entity-link" href={String(v)} target="_blank" rel="noreferrer">
              {String(v)}
            </a>{" "}
            <InfoTip text="Dead after sandbox teardown" />
          </>
        ),
      }}
    />
  );
}

function CopyCode(props: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rd-copy"
      title="Click to copy"
      onClick={() => {
        void navigator.clipboard.writeText(props.text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      <code>{props.text}</code>
      {copied ? <span className="accent"> Copied</span> : null}
    </button>
  );
}

// ---- checks & judgments tab (item 9: expandable table; live traces unchanged) ----

/** Judgment kind as a glyph (item 2): deterministic ≡, llm/agentic ✶ — tooltip carries the word. */
function judgmentKindInfo(kind: string): { glyph: string; label: string } {
  if (kind === "deterministic") return { glyph: "≡", label: "Deterministic Check" };
  if (kind === "agentic") return { glyph: "✶", label: "Agentic Judge" };
  if (kind === "llm") return { glyph: "✶", label: "LLM Judge" };
  return { glyph: "✶", label: humanizeKey(kind) };
}

/** Persisted judgment → trace shape for the JudgeTrace showcase (v3 spec §8.2, frozen). */
function judgmentToTrace(j: JudgmentJson): JudgeTraceJson {
  return {
    judge: j.name.startsWith("agentic") ? "agentic" : "llm",
    model: j.tokens?.model ?? null,
    startedAt: j.createdAt,
    finishedAt: j.createdAt,
    durationMs: j.durationMs,
    costUsd: j.costUsd,
    tokens: j.tokens,
    error: null,
    steps: j.steps ?? [],
  };
}

const JUDGE_COST_TIP = "Judge LLM cost — not included in attempt cost";

const JUDGMENT_COLUMNS: Column<JudgmentJson>[] = [
  {
    key: "kind",
    header: "Kind",
    width: "40px",
    align: "center",
    sortValue: (j) => j.kind,
    render: (j) => {
      const info = judgmentKindInfo(j.kind);
      return (
        <Tooltip text={info.label}>
          <span className="rd-judgment-kind" role="img" aria-label={info.label}>
            {info.glyph}
          </span>
        </Tooltip>
      );
    },
  },
  {
    key: "name",
    header: "Name",
    sortValue: (j) => j.name,
    titleText: (j) => j.name,
    render: (j) => <span className="rd-judgment-name">{j.name}</span>,
  },
  {
    key: "verdict",
    header: "Verdict",
    width: "84px",
    sortValue: (j) => j.score ?? (j.pass ? 1 : 0),
    render: (j) => <StatusScore status={j.pass ? "pass" : "fail"} score={j.score} />,
  },
  {
    key: "duration",
    header: "Duration",
    width: "90px",
    align: "right",
    sortValue: (j) => j.durationMs,
    titleText: (j) => (j.kind === "deterministic" ? "Check elapsed" : "Judge duration"),
    render: (j) => (
      <span className={j.durationMs === null ? "rd-judgment-ms dim" : "rd-judgment-ms"}>
        {fmtDuration(j.durationMs)}
      </span>
    ),
  },
  {
    key: "cost",
    header: "Cost",
    width: "90px",
    align: "right",
    sortValue: (j) => j.costUsd,
    tooltip: (j) => (j.kind === "deterministic" ? null : JUDGE_COST_TIP),
    render: (j) =>
      j.kind === "deterministic" || j.costUsd === null ? (
        <span className="cost-badge dim">—</span>
      ) : (
        <span className="cost-badge">{fmtCost(j.costUsd)}</span>
      ),
  },
  {
    key: "age",
    header: "Age",
    width: "80px",
    sortValue: (j) => j.createdAt,
    titleText: (j) => j.createdAt,
    render: (j) => fmtAgo(j.createdAt),
  },
];

function ChecksTab(props: {
  attempt: AttemptJson | null;
  judgments: JudgmentJson[];
  live: JudgeLiveResponse | null;
}): ReactNode {
  const { attempt, judgments, live } = props;
  const judging = attempt?.status === "judging";
  // While judging with live traces available, the live stream IS the view — the
  // deterministic trace covers the checks (no double-display of persisted rows).
  if (judging && live && live.traces.length > 0) {
    return (
      <div className="rd-checks">
        {live.traces.map((t, i) => (
          <JudgeTrace trace={t} live key={`${t.judge}-${t.startedAt}-${String(i)}`} />
        ))}
      </div>
    );
  }
  return (
    <div className="rd-checks">
      {judging ? (
        <div className="rd-stage">
          <Spinner label="Judging…" />
        </div>
      ) : null}
      {judgments.length === 0 && !judging ? (
        <div className="dim">
          {attempt && isUnfinished(attempt.status) ? "No judgments yet" : "No judgments"}
        </div>
      ) : null}
      {judgments.length > 0 ? (
        <DataTable
          rows={judgments}
          columns={JUDGMENT_COLUMNS}
          rowKey={(j) => j.id}
          searchable={false}
          emptyText="No judgments"
          renderExpanded={(j) => <JudgmentDetail judgment={j} />}
        />
      ) : null}
    </div>
  );
}

/** Expanded judgment row (item 9): reasoning + full JudgeTrace + raw toggle. */
function JudgmentDetail(props: { judgment: JudgmentJson }): ReactNode {
  const j = props.judgment;
  const isLlmKind = j.kind !== "deterministic";
  const hasTrace = j.steps !== null;
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="rd-judgment-detail">
      {j.reasoning ? <div className="rd-judgment-reason">{j.reasoning}</div> : null}
      {hasTrace ? (
        <>
          <div className="rd-judgment-trace">
            <JudgeTrace trace={judgmentToTrace(j)} />
          </div>
          {j.raw !== null ? (
            <div className="rd-judgment-raw-toggle">
              <button type="button" className="pv-toggle" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? "▾ Hide Raw" : "▸ Raw"}
              </button>
              {showRaw ? <JudgmentRaw raw={j.raw} /> : null}
            </div>
          ) : null}
        </>
      ) : (
        <>
          {j.raw !== null ? <JudgmentRaw raw={j.raw} /> : null}
          {isLlmKind ? (
            <div className="dim rd-not-captured">Trace not captured (older run)</div>
          ) : null}
        </>
      )}
    </div>
  );
}

function JudgmentRaw(props: { raw: string }): ReactNode {
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
      <PrettyView value={parsed.value} rawLabel="Raw" />
    </div>
  );
}

// ---- logs tab (items 10 + 14: runner/worker/api logs, live runner stream) ----

type LogSource = "runner" | "worker" | "api";

const LOG_SOURCE_LABELS: Record<LogSource, string> = {
  runner: "Runner",
  worker: "Worker",
  api: "API",
};

interface LogRow {
  ts: string | null;
  level: ProgressLogLevelJson;
  message: string;
}

/** runner.log line shape (v4 spec §2.2): "ISO [level] line". */
const RUNNER_LINE_RE = /^(\S+) \[(info|warn|error)\] (.*)$/;

/** Pino-ish JSON log line → leveled row; null when the line is not JSON. */
function jsonLogRow(line: string): LogRow | null {
  if (!line.startsWith("{")) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  let level: ProgressLogLevelJson = "info";
  const rawLevel = obj.level;
  if (typeof rawLevel === "number") {
    level = rawLevel >= 50 ? "error" : rawLevel >= 40 ? "warn" : "info";
  } else if (rawLevel === "error" || rawLevel === "fatal") {
    level = "error";
  } else if (rawLevel === "warn" || rawLevel === "warning") {
    level = "warn";
  }
  const time = obj.time ?? obj.ts ?? obj.timestamp;
  const ts =
    typeof time === "number"
      ? new Date(time).toISOString()
      : typeof time === "string"
        ? time
        : null;
  const msg = obj.msg ?? obj.message;
  return { ts, level, message: typeof msg === "string" && msg.length > 0 ? msg : line };
}

function parseLogLine(line: string): LogRow {
  const m = RUNNER_LINE_RE.exec(line);
  if (m) return { ts: m[1], level: m[2] as ProgressLogLevelJson, message: m[3] };
  return jsonLogRow(line) ?? { ts: null, level: "info", message: line };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtLogTs(ts: string | null): string {
  if (ts === null) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const LOG_LEVEL_GLYPHS: Record<ProgressLogLevelJson, string> = {
  info: "·",
  warn: "⚠",
  error: "✗",
};

/** Artifact text cache — artifacts are immutable blobs, fetch each at most once. */
const artifactTextCache = new Map<string, string>();

function useArtifactText(id: string | null): {
  text: string | null;
  error: string | null;
  loading: boolean;
} {
  const [state, setState] = useState<{
    id: string | null;
    text: string | null;
    error: string | null;
    loading: boolean;
  }>({ id: null, text: null, error: null, loading: false });

  useEffect(() => {
    if (id === null) {
      setState({ id: null, text: null, error: null, loading: false });
      return;
    }
    const cached = artifactTextCache.get(id);
    if (cached !== undefined) {
      setState({ id, text: cached, error: null, loading: false });
      return;
    }
    let cancelled = false;
    setState({ id, text: null, error: null, loading: true });
    fetch(artifactUrl(id))
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })
      .then((text) => {
        artifactTextCache.set(id, text);
        if (!cancelled) setState({ id, text, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            id,
            text: null,
            error: e instanceof Error ? e.message : String(e),
            loading: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return state.id === id ? state : { text: null, error: null, loading: id !== null };
}

function findLogArtifact(
  artifacts: ArtifactMetaJson[],
  source: LogSource,
): ArtifactMetaJson | null {
  if (source === "runner") {
    return (
      artifacts.find((a) => a.kind === "log" && a.name === "runner.log") ??
      artifacts.find((a) => a.kind === "log") ??
      null
    );
  }
  const name = source === "worker" ? "worker.log" : "api.log";
  return artifacts.find((a) => a.kind === "sandbox-log" && a.name === name) ?? null;
}

function LogsTab(props: {
  attempt: AttemptJson | null;
  artifacts: ArtifactMetaJson[];
  progress: AttemptProgressResponse | null;
}): ReactNode {
  const { attempt, artifacts, progress } = props;
  const [source, setSource] = useState<LogSource>("runner");

  const unfinished = attempt !== null && isUnfinished(attempt.status);
  // Live runner stream (item 14) while the registry has the attempt; the
  // persisted runner.log artifact takes over once the attempt finishes.
  const liveRunner = source === "runner" && unfinished && progress?.active === true;
  const artifact = attempt !== null && !liveRunner ? findLogArtifact(artifacts, source) : null;
  const fetched = useArtifactText(artifact?.id ?? null);

  const liveLog = liveRunner ? (progress?.log ?? []) : null;
  const rows = useMemo<LogRow[]>(() => {
    if (liveLog !== null) {
      return liveLog.map((l) => ({ ts: l.ts, level: l.level, message: l.line }));
    }
    if (fetched.text === null) return [];
    const lines = fetched.text.split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.map(parseLogLine);
  }, [liveLog, fetched.text]);

  // Auto-scroll pinned to the bottom while live — only when already at the bottom.
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const onScroll = () => {
    const el = bodyRef.current;
    if (el) pinnedRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  };
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null || !liveRunner || rows.length === 0) return;
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [rows, liveRunner]);

  if (!attempt) return <div className="dim">No attempt selected</div>;

  let body: ReactNode;
  if (liveRunner) {
    body =
      rows.length === 0 ? (
        <div className="rd-stage">
          <Spinner label="Waiting for runner output…" />
        </div>
      ) : (
        <div className="rd-log-body" ref={bodyRef} onScroll={onScroll}>
          {rows.map((row, i) => (
            <LogLineRow row={row} key={`${String(i)}:${row.ts ?? ""}`} />
          ))}
        </div>
      );
  } else if (artifact !== null) {
    body = fetched.loading ? (
      <div className="rd-stage">
        <Spinner label="Loading log…" />
      </div>
    ) : fetched.error !== null ? (
      <div className="rd-load-error">Failed to load log: {fetched.error}</div>
    ) : rows.length === 0 ? (
      <div className="dim rd-not-captured">Empty log</div>
    ) : (
      <div className="rd-log-body" ref={bodyRef} onScroll={onScroll}>
        {rows.map((row, i) => (
          <LogLineRow row={row} key={`${String(i)}:${row.ts ?? ""}`} />
        ))}
      </div>
    );
  } else if (unfinished) {
    body = (
      <div className="rd-stage">
        <Spinner label="Logs land as the attempt progresses…" />
      </div>
    );
  } else {
    body = (
      <div className="dim rd-not-captured">
        {source === "runner"
          ? "Runner log not captured (older run)"
          : source === "worker"
            ? "Worker log not captured"
            : "API log not captured"}
      </div>
    );
  }

  return (
    <div className="rd-logs">
      <div className="rd-log-sources">
        {(["runner", "worker", "api"] as const).map((s) => (
          <button
            type="button"
            key={s}
            className={source === s ? "btn rd-log-src selected" : "btn rd-log-src"}
            onClick={() => setSource(s)}
          >
            {LOG_SOURCE_LABELS[s]}
          </button>
        ))}
      </div>
      {body}
    </div>
  );
}

function LogLineRow(props: { row: LogRow }): ReactNode {
  const { row } = props;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`rd-log-row level-${row.level}`}>
      <span className="rd-log-ts">{fmtLogTs(row.ts)}</span>
      <span
        className={`rd-log-glyph level-${row.level}`}
        role="img"
        aria-label={row.level === "info" ? "Info" : row.level === "warn" ? "Warning" : "Error"}
      >
        {LOG_LEVEL_GLYPHS[row.level]}
      </span>
      <button
        type="button"
        className={expanded ? "rd-log-msg expanded" : "rd-log-msg"}
        title={expanded ? undefined : row.message}
        onClick={() => setExpanded((v) => !v)}
      >
        {row.message}
      </button>
    </div>
  );
}

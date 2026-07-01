import {
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  artifactUrl,
  cancelRun,
  getArtifactText,
  getAttempt,
  getAttemptProgress,
  getAttemptTasks,
  getJudgeLive,
  getRun,
  resumeRun,
} from "../api.ts";
import { ConfigChip } from "../components/ConfigChip.tsx";
import { useConfirm } from "../components/ConfirmDialog.tsx";
import { CrownIcon } from "../components/CrownIcon.tsx";
import { type Column, DataTable } from "../components/DataTable.tsx";
import { EntityLink } from "../components/EntityLink.tsx";
import {
  fmtAgo,
  fmtBytes,
  fmtCost,
  fmtDate,
  fmtDuration,
  fmtScore,
  fmtTokens,
  humanizeKey,
} from "../components/format.ts";
import { JsonView } from "../components/JsonView.tsx";
import { LogLines, type ParsedLogRow, parseLogText, stripAnsi } from "../components/LogLines.tsx";
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
import { type ConfigLookup, navigate, useConfigs, usePoll } from "../hooks.ts";
import {
  memberLabel,
  type NormalizedSandboxInfo,
  type NormalizedWorker,
  normalizeSandboxInfo,
  workerLabel,
} from "../lib/sandbox.ts";
import type {
  ArtifactMetaJson,
  AttemptDetail,
  AttemptJson,
  AttemptProgressResponse,
  AttemptTaskJson,
  AttemptTasksResponse,
  CellJson,
  ConfigJson,
  JudgeLiveResponse,
  JudgeTraceJson,
  JudgmentJson,
  PhaseTimingsJson,
  RunDetail,
  SandboxInfoJson,
  TaskArtifactJson,
  TokenTotalsJson,
  WorkerRosterEntryJson,
} from "../types.ts";
import JudgeTrace from "./JudgeTrace.tsx";
import Transcript, {
  TaskMemberChip,
  type TaskMemberInfo,
  type TranscriptTaskStatus,
} from "./Transcript.tsx";
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
  // Tri-state derived from ALL checks (deterministic + judge + agentic), not just
  // judges: ✓ all passed, ✗ any failed, ! mixed/pending (incl. while judging).
  let stateIcon: ReactNode = null;
  if (judgments.length > 0 || judging) {
    const anyFail = judgments.some((j) => !j.pass);
    const allPass = judgments.length > 0 && judgments.every((j) => j.pass);
    const [glyph, tone, word] = anyFail
      ? ["✗", "tone-red", "failed"]
      : allPass && !judging
        ? ["✓", "tone-green", "passed"]
        : ["!", "tone-yellow", "pending"];
    stateIcon = (
      <span className={`rd-tab-checkstate ${tone}`} role="img" aria-label={`checks ${word}`}>
        {glyph}
      </span>
    );
  }
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
        {stateIcon}
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

  // v7.5 items 2/5/6: per-task records (status, outcome/error, dependsOn,
  // cost) from GET /api/attempts/:id/tasks — polled live alongside the
  // attempt (4s while unfinished), then ONE final non-live fetch once the
  // status flips terminal (the deps change re-runs the poll with live:false).
  // A fetch error (e.g. a server without the endpoint yet) degrades to null
  // → the pre-v7.5 artifact-parse UI below renders exactly as before.
  const tasksPoll = usePoll<{ attemptId: string; res: AttemptTasksResponse } | null>(
    () =>
      selId === null
        ? Promise.resolve(null)
        : getAttemptTasks(selId, { live: attemptUnfinished }).then((res) => ({
            attemptId: selId,
            res,
          })),
    selId !== null && attemptUnfinished ? 4000 : null,
    [selId, attemptUnfinished],
  );
  const taskRes =
    tasksPoll.data !== null && tasksPoll.data.attemptId === selId ? tasksPoll.data.res : null;
  // taskId → record map for the transcript's per-task sub-tab headers.
  const taskRecords = useMemo<Record<string, AttemptTaskJson> | null>(() => {
    if (taskRes === null) return null;
    const out: Record<string, AttemptTaskJson> = {};
    for (const t of taskRes.tasks) out[t.id] = t;
    return out;
  }, [taskRes]);

  // tasks.json artifact → per-task title/status/skip flags (v6 §9.5 + v7 §1).
  // FALLBACK ONLY since v7.5: fetched when the tasks endpoint yielded nothing,
  // so older servers keep exactly the previous behavior (the artifact text
  // cache makes refetches free anyway).
  const artifacts = useMemo(() => detail?.artifacts ?? [], [detail]);
  const tasksArtifact =
    artifacts.find((a) => a.kind === "task" && a.name === "tasks.json") ??
    artifacts.find((a) => a.kind === "task") ??
    null;
  const tasksFetched = useArtifactText(taskRes === null ? (tasksArtifact?.id ?? null) : null);
  const taskFlags = useMemo(() => parseTaskFlags(tasksFetched.text), [tasksFetched.text]);
  const taskTitles = useMemo(() => {
    const out: Record<string, string> = {};
    if (taskRes !== null) {
      for (const t of taskRes.tasks) if (t.title !== null) out[t.id] = t.title;
      return out;
    }
    for (const [id, flag] of taskFlags) if (flag.title !== null) out[id] = flag.title;
    return out;
  }, [taskRes, taskFlags]);
  const taskStatuses = useMemo(() => {
    const out: Record<string, TranscriptTaskStatus> = {};
    if (taskRes !== null) {
      for (const t of taskRes.tasks) out[t.id] = { status: t.status, skipped: t.skipped };
      return out;
    }
    for (const [id, flag] of taskFlags) out[id] = { status: flag.status, skipped: flag.skipped };
    return out;
  }, [taskRes, taskFlags]);

  // Round-10 item 2: agentId → executing-member attribution for the left-bar
  // task rows + the transcript's sub-tab headers/hovers. Null ⇒ absent.
  const memberLookup = useMemo<Record<string, TaskMemberInfo> | null>(
    () => buildMemberLookup(attempt, configs),
    [attempt, configs],
  );

  // v7 §10.3: Workers-panel task chips jump into the transcript's sub-tab.
  // Requests carry the attempt id so a stale one never crosses attempts.
  const [focusTask, setFocusTask] = useState<{
    taskId: string;
    nonce: number;
    attemptId: string;
  } | null>(null);
  const openTaskInTranscript = (taskId: string) => {
    if (selId === null) return;
    setTab("transcript");
    setFocusTask((prev) => ({ taskId, nonce: (prev?.nonce ?? 0) + 1, attemptId: selId }));
  };

  // Cancel flow (item 12): in-app confirm + "Cancelling…" until `active` flips false.
  const { confirm, confirmDialog } = useConfirm();
  const [cancelRequested, setCancelRequested] = useState(false);
  useEffect(() => {
    if (!active) setCancelRequested(false);
  }, [active]);

  // v7.6 §B1 advisory: .rd-top's height varies (cell band, long names, action
  // errors) — measure it into --rd-top-h on .rd-body so CSS can size both
  // columns to always fit the viewport below the sticky header, keeping the
  // right panel's tab row + transcript sticky stack fully in view (the old
  // fixed calc assumed a 240px header budget). Re-runs once `run` loads
  // (the refs only attach then); the observer tracks growth afterwards.
  const topRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const runLoaded = run !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach once `run` loads — the refs only exist after the early-return stops rendering the loading panel
  useLayoutEffect(() => {
    const top = topRef.current;
    const body = bodyRef.current;
    if (top === null || body === null) return undefined;
    const apply = () => {
      body.style.setProperty("--rd-top-h", `${String(top.offsetHeight)}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(top);
    return () => observer.disconnect();
  }, [runLoaded]);

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

  const judgments = detail?.judgments ?? [];
  const checksTab = checksTabInfo(judgments, judging);

  return (
    <>
      {confirmDialog}
      <div className="panel rd-top" ref={topRef}>
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
        {r.attemptsPerCell > 1 ? (
          <CellSummaryBand runId={runId} attemptsPerCell={r.attemptsPerCell} cells={run.cells} />
        ) : null}
      </div>

      <div className="layout-30-70 rd-body" ref={bodyRef}>
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
            taskFlags={taskFlags}
            tasks={taskRes !== null && taskRes.tasks.length > 0 ? taskRes.tasks : null}
            members={memberLookup}
            onOpenTask={openTaskInTranscript}
          />
          <WorkersPanel attempt={attempt} onOpenTask={openTaskInTranscript} />
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
            {/* v7.6 §B1: the transcript renders bare — it owns its 10px top gap
                so its sticky stack starts at the scrollport top; every other
                tab body gets the spacing back via the .rd-tab-pad wrapper. */}
            {tab === "transcript" ? (
              selId ? (
                <Transcript
                  key={selId}
                  attemptId={selId}
                  live={attemptUnfinished}
                  taskIds={attempt?.taskIds}
                  taskTitles={taskTitles}
                  taskStatuses={taskStatuses}
                  taskRecords={taskRecords}
                  members={memberLookup}
                  totals={
                    attempt
                      ? {
                          costUsd: attempt.costUsd,
                          durationMs: attempt.durationMs,
                          tokens: attempt.tokens,
                        }
                      : null
                  }
                  focusTask={focusTask !== null && focusTask.attemptId === selId ? focusTask : null}
                />
              ) : (
                <div className="dim rd-tab-pad">No attempt selected</div>
              )
            ) : (
              <div className="rd-tab-pad">
                {tab === "checks" ? (
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

// ---- cell summary band (v7 §2.2: per-cell aggregates across N attempts) ----

/**
 * Rendered only when attemptsPerCell > 1 — `run.cells` already aggregates
 * across the cell's attempts, so no extra fetch is needed. Rows link to the
 * cell's first attempt (same href scheme as the Matrix). `passed` /
 * `avgCostUsd` are v7 server fields — absent on cached pre-v7 payloads,
 * rendered as "—" (never NaN).
 */
function CellSummaryBand(props: {
  runId: string;
  attemptsPerCell: number;
  cells: CellJson[];
}): ReactNode {
  const rows = useMemo(
    () =>
      props.cells
        .filter((c) => c.attempts > 0)
        .sort(
          (a, b) =>
            a.scenarioId.localeCompare(b.scenarioId) || a.configId.localeCompare(b.configId),
        ),
    [props.cells],
  );
  // Default collapsed only when the band would be tall (> 8 cells).
  const [open, setOpen] = useState(rows.length <= 8);
  if (rows.length === 0) return null;
  return (
    <div className="rd-cellsum">
      <button
        type="button"
        className="rd-cellsum-toggle"
        title="Per-cell aggregates across this run's attempts"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▾" : "▸"} Cell Summary{" "}
        <span className="dim">
          · {rows.length} {rows.length === 1 ? "Cell" : "Cells"} × {props.attemptsPerCell} Attempts
        </span>
      </button>
      {open ? (
        <div className="rd-cellsum-table">
          <div className="rd-cellsum-row rd-cellsum-head" aria-hidden="true">
            <span>Cell</span>
            <span>Passed</span>
            <span>Best</span>
            <span>Avg Score</span>
            <span>Σ Cost</span>
            <span>Avg Cost</span>
            <span>Avg Dur</span>
          </div>
          {rows.map((c) => (
            <a
              key={`${c.scenarioId}|${c.configId}`}
              className="rd-cellsum-row"
              href={`#/runs/${props.runId}/attempts/${props.runId}_${c.scenarioId}_${c.configId}_0`}
              title={`${c.scenarioId} × ${c.configId} — open the first attempt`}
            >
              <span className="rd-cellsum-cell">
                {c.scenarioId} <span className="dim">×</span> {c.configId}
              </span>
              <span>
                {typeof c.passed === "number" ? c.passed : "—"}/{c.attempts}
              </span>
              <span>{fmtScore(c.bestScore)}</span>
              <span>{fmtScore(c.avgScore)}</span>
              <span>{fmtCost(c.totalCostUsd)}</span>
              <span>{c.avgCostUsd === undefined ? "—" : fmtCost(c.avgCostUsd)}</span>
              <span>{fmtDuration(c.avgDurationMs)}</span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Duplicates evals/src/types.ts CASCADE_SKIP_RE (v6 spec §0.12 — FROZEN source
 * string). Fallback skip classification for tasks.json rows predating the
 * runner-computed `skipped` flag.
 */
const CASCADE_SKIP_RE = /^Blocked dependency [0-9a-f]{8} was /;

interface TaskFlag {
  title: string | null;
  status: string | null;
  skipped: boolean;
  failureReason: string | null;
}

/** tasks.json artifact text → taskId → title/status/skip info (v6 §9.5 + v7 §1). */
function parseTaskFlags(text: string | null): Map<string, TaskFlag> {
  const map = new Map<string, TaskFlag>();
  if (text === null) return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return map;
  }
  if (!Array.isArray(parsed)) return map;
  for (const entry of parsed as TaskArtifactJson[]) {
    if (typeof entry !== "object" || entry === null || typeof entry.id !== "string") continue;
    const failureReason = typeof entry.failureReason === "string" ? entry.failureReason : null;
    const skipped =
      entry.skipped === true ||
      (entry.skipped === undefined &&
        entry.status === "failed" &&
        CASCADE_SKIP_RE.test(failureReason ?? ""));
    map.set(entry.id, {
      title: typeof entry.title === "string" && entry.title.length > 0 ? entry.title : null,
      status: typeof entry.status === "string" ? entry.status : null,
      skipped,
      failureReason,
    });
  }
  return map;
}

// ---- task → member attribution (round-10 item 2) ----

/**
 * agentId → resolved executing member — the FROZEN pure client-side join:
 * AttemptTaskJson.agentId ↔ WorkerRosterEntryJson.agentId (attempt.workers,
 * v7 §10), falling back to normalizeSandboxInfo(attempt.sandbox) workers
 * (LIVE attempts — workersJson is only written at attempt end — and
 * roster-fetch-failed attempts). The roster wins per agentId once captured.
 * Null (no joinable member at all) ⇒ attribution UI entirely absent, so
 * v1-era attempts render bit-for-bit unchanged.
 */
function buildMemberLookup(
  attempt: AttemptJson | null,
  configs: ConfigLookup,
): Record<string, TaskMemberInfo> | null {
  if (attempt === null) return null;
  const out: Record<string, TaskMemberInfo> = {};

  // (2) sandbox fallback first — roster entries overwrite per agentId below.
  const info = normalizeSandboxInfo(attempt.sandbox);
  if (info !== null) {
    const cfg = configs.byId(attempt.configId);
    const workerCount = info.workers.filter((w) => w.role !== "lead").length;
    for (const w of info.workers) {
      if (w.agentId === null) continue;
      out[w.agentId] = {
        agentId: w.agentId,
        name: memberLabel(w, workerCount),
        isLead: w.role === "lead",
        memberRole: w.role === "lead" ? "lead" : "worker",
        index: w.index,
        provider: cfg?.provider ?? null,
        configId: attempt.configId,
        model: cfg?.model ?? null,
        overridden: false,
        status: null,
      };
    }
  }

  // (1) the roster — same display rules as MemberSection (name fallback,
  // §12.3 cell-config-with-override resolution, lead by memberRole).
  const roster = attempt.workers ?? null;
  if (roster !== null && roster.length > 0) {
    const workerCount = roster.filter((m) => m.memberRole === "worker").length;
    for (const e of roster) {
      if (e.agentId === "") continue;
      const isLead = e.memberRole === "lead" || e.isLead;
      const effConfigId = e.configId ?? attempt.configId;
      const cfg = configs.byId(effConfigId);
      out[e.agentId] = {
        agentId: e.agentId,
        name: e.name ?? (isLead ? "Lead" : workerLabel(e.index, workerCount)),
        isLead,
        memberRole: e.memberRole,
        index: e.index,
        provider: e.provider ?? cfg?.provider ?? null,
        configId: effConfigId,
        model: e.model ?? cfg?.model ?? null,
        overridden: e.configId !== null || e.model !== null,
        status: e.status ?? null,
      };
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

function AttemptSummary(props: {
  attempt: AttemptJson | null;
  selId: string | null;
  error: string | null;
  config: ConfigJson | null;
  /** Parsed tasks.json flags — the pre-v7.5 fallback path (v6 §9.5). */
  taskFlags: Map<string, TaskFlag>;
  /**
   * v7.5 items 2/5/6: per-task records in render order (tasks endpoint).
   * Null (endpoint missing / fetch error / nothing known) → the legacy chips.
   */
  tasks: AttemptTaskJson[] | null;
  /** Round-10 item 2: agentId → executing member; null ⇒ attribution absent. */
  members: Record<string, TaskMemberInfo> | null;
  onOpenTask: (taskId: string) => void;
}): ReactNode {
  const { attempt, config, taskFlags } = props;
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
        <Meta label="Tokens">
          <TokensValue tokens={attempt.tokens} />
        </Meta>
        <Meta label="Scenario">
          <EntityLink kind="scenario" id={attempt.scenarioId} />
        </Meta>
        <Meta label="Config">
          <ConfigChip configId={attempt.configId} link />
        </Meta>
      </div>
      {props.tasks !== null ? (
        <TaskRows tasks={props.tasks} members={props.members} onOpenTask={props.onOpenTask} />
      ) : attempt.taskIds.length > 0 ? (
        <div className="rd-tasks">
          <span className="meta-label">Tasks</span>
          {attempt.taskIds.map((taskId) => {
            const flag = taskFlags.get(taskId);
            return (
              <Fragment key={taskId}>
                {/* Item 1: long ids truncate (CSS ellipsis); the title carries the full id. */}
                <code className="chip rd-mono" title={taskId}>
                  {taskId}
                </code>
                {/* Cascade-failed dependent (v6 §9.5): dim tag, tooltip = raw failureReason. */}
                {flag?.skipped === true ? (
                  <Tooltip text={flag.failureReason ?? "Skipped (failed dependency)"}>
                    <span className="chip dim">skipped</span>
                  </Tooltip>
                ) : null}
              </Fragment>
            );
          })}
        </div>
      ) : null}
      {attempt.error ? <div className="rd-attempt-error">{attempt.error}</div> : null}
    </div>
  );
}

/**
 * Attempt token totals (v7 §11.2): `total (in X · out Y · cacheR Z · cacheW W)`
 * compact-formatted; the title carries the exact numbers + the dominant model.
 * Null totals AND all-zero totals (legacy rows) render as "—".
 */
function TokensValue(props: { tokens: TokenTotalsJson | null }): ReactNode {
  const t = props.tokens;
  const total =
    t === null ? 0 : t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  if (t === null || total === 0) return <span className="dim">—</span>;
  const title = [
    `input ${t.inputTokens.toLocaleString()}`,
    `output ${t.outputTokens.toLocaleString()}`,
    `cache read ${t.cacheReadTokens.toLocaleString()}`,
    `cache write ${t.cacheWriteTokens.toLocaleString()}`,
    t.model !== null ? `model ${t.model}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return (
    <span className="rd-tokens" title={title}>
      {fmtTokens(total)}{" "}
      <span className="dim">
        (in {fmtTokens(t.inputTokens)} · out {fmtTokens(t.outputTokens)} · cacheR{" "}
        {fmtTokens(t.cacheReadTokens)} · cacheW {fmtTokens(t.cacheWriteTokens)})
      </span>
    </span>
  );
}

// ---- left-panel task rows (v7.5 items 1/2/5/6) ----

/**
 * Glyph-status conventions for swarm task statuses — mirrors Transcript's
 * taskTabGlyph (TRANSCRIPT-owned file, not exported). Static glyphs only:
 * the single-animation rule forbids per-row spinners.
 */
function taskRowGlyph(
  status: string | null,
  skipped: boolean,
): { glyph: string; tone: string; label: string } {
  if (skipped) return { glyph: "⊘", tone: "dim", label: "Skipped (failed dependency)" };
  const s = (status ?? "").toLowerCase();
  if (s === "completed" || s === "done") return { glyph: "✓", tone: "green", label: "Completed" };
  if (s === "failed" || s === "error") return { glyph: "✗", tone: "red", label: "Failed" };
  if (s === "in_progress" || s === "running") {
    return { glyph: "◔", tone: "accent", label: "In Progress" };
  }
  if (s === "pending" || s === "created" || s === "assigned") {
    return { glyph: "○", tone: "dim", label: "Pending" };
  }
  if (s === "") return { glyph: "•", tone: "neutral", label: "Status unknown" };
  return { glyph: "•", tone: "neutral", label: s };
}

/** Dependency reference: "Task n · title" by row position; short id when unknown. */
function taskRefLabel(depId: string, tasks: AttemptTaskJson[]): string {
  const idx = tasks.findIndex((t) => t.id === depId);
  if (idx === -1) return depId.slice(0, 8);
  const title = tasks[idx].title;
  return title !== null ? `Task ${String(idx + 1)} · ${title}` : `Task ${String(idx + 1)}`;
}

/**
 * Item 5: one row per task — status glyph, clickable label (focuses the
 * task's transcript sub-tab), dependency indicator, per-task cost (item 6)
 * and an expandable outcome/error block (item 2). Every field degrades to
 * "—"/absent on all-null records (v1-era "task-ids" source).
 */
function TaskRows(props: {
  tasks: AttemptTaskJson[];
  members: Record<string, TaskMemberInfo> | null;
  onOpenTask: (taskId: string) => void;
}): ReactNode {
  // Seed segregation: a scenario may seed reference-data tasks into the same swarm
  // DB the run uses (e.g. delegation-probe's 20 audit-history rows). The runner tags
  // each task run-vs-seed (origin); absent ⇒ "run" (pre-tag artifacts show every row
  // as before). Render RUN activity front-and-center; tuck SEED rows behind a toggle.
  const [showSeed, setShowSeed] = useState(false);
  const runTasks = props.tasks.filter((t) => (t.origin ?? "run") !== "seed");
  const seedTasks = props.tasks.filter((t) => (t.origin ?? "run") === "seed");
  // Indices stay stable against the FULL list so "Task N" labels + dependency
  // refs (taskRefLabel resolves by position in props.tasks) never shift.
  return (
    <div className="rd-taskrows">
      <span className="rd-taskrows-label">Tasks</span>
      {runTasks.map((t) => (
        <TaskRow
          key={t.id}
          task={t}
          index={props.tasks.indexOf(t)}
          tasks={props.tasks}
          members={props.members}
          onOpenTask={props.onOpenTask}
        />
      ))}
      {seedTasks.length > 0 ? (
        <>
          <button
            type="button"
            className="rd-taskrows-seed-toggle"
            aria-expanded={showSeed}
            title={
              showSeed
                ? "Hide the scenario's seeded reference-data tasks"
                : "Show the scenario's seeded reference-data tasks (not run activity)"
            }
            onClick={() => setShowSeed((v) => !v)}
          >
            {showSeed ? "▾" : "▸"} Seeded history ({seedTasks.length})
          </button>
          {showSeed
            ? seedTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  index={props.tasks.indexOf(t)}
                  tasks={props.tasks}
                  members={props.members}
                  onOpenTask={props.onOpenTask}
                />
              ))
            : null}
        </>
      ) : null}
    </div>
  );
}

function TaskRow(props: {
  task: AttemptTaskJson;
  index: number;
  tasks: AttemptTaskJson[];
  members: Record<string, TaskMemberInfo> | null;
  onOpenTask: (taskId: string) => void;
}): ReactNode {
  const t = props.task;
  const [open, setOpen] = useState(false);
  const info = taskRowGlyph(t.status, t.skipped);
  const hasDetail = t.outcome !== null || t.error !== null;
  // Round-10 item 2: null agentId / no roster ⇒ no attribution chip (sacred).
  const member = t.agentId !== null ? (props.members?.[t.agentId] ?? null) : null;

  const labelTip = [
    t.id,
    info.label,
    t.agentId !== null ? `Agent ${t.agentId}` : null,
    "Click to open in the transcript",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  // Cascade-skipped reads distinctly from real errors (v6 §9 semantics).
  const depTip = [
    t.skipped ? "Cascade-skipped — a dependency failed" : null,
    ...t.dependsOn.map((d) => `Depends on ${taskRefLabel(d, props.tasks)}`),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const tokenTotal =
    t.tokens === null
      ? 0
      : t.tokens.inputTokens +
        t.tokens.outputTokens +
        t.tokens.cacheReadTokens +
        t.tokens.cacheWriteTokens;
  const costTip =
    t.costUsd === null
      ? "Per-task cost not captured"
      : `Σ session cost for this task${tokenTotal > 0 ? ` · ${fmtTokens(tokenTotal)} tokens` : ""}`;

  // v7.6 §B2: compact per-task token total — hover carries the breakdown in
  // the attempt-Tokens-row format. Null/zero (live source, v1-era rows) ⇒ "—".
  const tokensTip =
    t.tokens === null || tokenTotal === 0
      ? "Per-task tokens not captured (live attempts report them once finished)"
      : `${fmtTokens(tokenTotal)} (in ${fmtTokens(t.tokens.inputTokens)} · out ${fmtTokens(
          t.tokens.outputTokens,
        )} · cacheR ${fmtTokens(t.tokens.cacheReadTokens)} · cacheW ${fmtTokens(
          t.tokens.cacheWriteTokens,
        )})`;

  return (
    <>
      <div className={t.skipped ? "rd-taskrow skipped" : "rd-taskrow"}>
        <span className={`rd-taskrow-glyph tone-${info.tone}`} role="img" aria-label={info.label}>
          {info.glyph}
        </span>
        <Tooltip block text={labelTip}>
          <button type="button" className="rd-taskrow-label" onClick={() => props.onOpenTask(t.id)}>
            Task {props.index + 1}
            {t.title !== null ? <span className="rd-taskrow-title"> · {t.title}</span> : null}
          </button>
        </Tooltip>
        {member !== null ? (
          <span className="rd-taskrow-member">
            <TaskMemberChip member={member} />
          </span>
        ) : null}
        {t.dependsOn.length > 0 ? (
          <Tooltip text={depTip}>
            <span className="rd-taskrow-dep" role="img" aria-label={depTip}>
              ↳{t.dependsOn.length > 1 ? t.dependsOn.length : ""}
            </span>
          </Tooltip>
        ) : null}
        <Tooltip text={tokensTip}>
          <span
            className={
              t.tokens === null || tokenTotal === 0 ? "rd-taskrow-tokens dim" : "rd-taskrow-tokens"
            }
          >
            {t.tokens === null || tokenTotal === 0 ? "—" : fmtTokens(tokenTotal)}
          </span>
        </Tooltip>
        <Tooltip text={costTip}>
          <span className={t.costUsd === null ? "rd-taskrow-cost dim" : "rd-taskrow-cost"}>
            {fmtCost(t.costUsd)}
          </span>
        </Tooltip>
        {hasDetail ? (
          <button
            type="button"
            className="rd-taskrow-toggle"
            title={open ? "Hide the outcome/error" : "Show the outcome/error"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : null}
      </div>
      {open && hasDetail ? (
        <div className="rd-task-detail">
          {/* v7.6 §B2: expand shows the FULL stored text (the server's 4000-char
              clip stands); the copy button takes the whole block verbatim. */}
          {t.error !== null ? (
            <div className="rd-task-blockwrap">
              <RdCopy text={t.error} what={t.skipped ? "skip reason" : "error"} />
              <RdClamp>
                <div className={t.skipped ? "rd-task-skip" : "rd-task-error"}>{t.error}</div>
              </RdClamp>
            </div>
          ) : null}
          {t.outcome !== null ? (
            <div className="rd-task-blockwrap">
              <RdCopy text={t.outcome} what="outcome" />
              <RdClamp>
                <div className="rd-task-outcome">{t.outcome}</div>
              </RdClamp>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** v7.6 §B2: copies a task's full stored outcome/error text (hover-revealed). */
function RdCopy(props: { text: string; what: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={copied ? "rd-task-copy copied" : "rd-task-copy"}
      title={`Copy the full ${props.what} text`}
      onClick={() => {
        void navigator.clipboard.writeText(props.text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "✓ Copied" : "⧉ Copy"}
    </button>
  );
}

/** v7.5 item 2: left-panel clamp threshold (the .sc-clamp pattern, rd- classes). */
const TASK_CLAMP_MAX_PX = 160;

/**
 * Clamp + expand — copies ScenariosPage's ClampBox measurement pattern
 * (scenarios.css is read-only, so the classes live in run-details.css).
 */
function RdClamp(props: { children: ReactNode }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [clampable, setClampable] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // scrollHeight reports the full content height even while max-height clamps
  // the box — one measurement rule works in both states.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setClampable(el.scrollHeight > TASK_CLAMP_MAX_PX + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cls = `rd-clamp${expanded ? " expanded" : ""}${clampable ? " clampable" : ""}`;
  return (
    <div className="rd-clampwrap">
      <div ref={boxRef} className={cls}>
        {props.children}
      </div>
      {clampable ? (
        <button
          type="button"
          className="rd-clamp-toggle"
          onClick={() => setExpanded((e) => !e)}
          title={expanded ? "Collapse this block" : "Expand the full block"}
        >
          {expanded ? "▴ Show less" : "▾ Show more"}
        </button>
      ) : null}
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

// ---- workers & sandboxes panel (item 14 + v6 §3.4 + v7 §10.3/§12.6: roster
//      blocks with per-member config/cost/tokens, override + LEAD badges;
//      pre-v7 attempts (workers == null) fall back to the sandbox view) ----

function WorkersPanel(props: {
  attempt: AttemptJson | null;
  onOpenTask: (taskId: string) => void;
}): ReactNode {
  const attempt = props.attempt;
  const sandbox = attempt?.sandbox ?? null;
  const info = useMemo(() => normalizeSandboxInfo(sandbox), [sandbox]);
  // Lead first when present, then workers by index (§10.3).
  const roster = useMemo<WorkerRosterEntryJson[] | null>(() => {
    const entries = attempt?.workers ?? null;
    if (entries === null || entries.length === 0) return null;
    return [...entries].sort((a, b) =>
      a.memberRole === b.memberRole ? a.index - b.index : a.memberRole === "lead" ? -1 : 1,
    );
  }, [attempt]);

  if (attempt !== null && roster !== null) {
    return (
      <div className="panel">
        <div className="panel-title">Workers &amp; Sandboxes</div>
        <RosterView
          attempt={attempt}
          roster={roster}
          sandbox={sandbox}
          info={info}
          onOpenTask={props.onOpenTask}
        />
      </div>
    );
  }
  // Pre-v7 fallback — today's sandbox blocks, unchanged.
  return (
    <div className="panel">
      <div className="panel-title">Sandbox</div>
      {sandbox !== null && info !== null ? (
        <SandboxView raw={sandbox} info={info} />
      ) : attempt && isUnfinished(attempt.status) ? (
        <div className="dim rd-not-captured">Sandbox not booted yet</div>
      ) : (
        <div className="dim rd-not-captured">Sandbox info not captured (older run)</div>
      )}
    </div>
  );
}

function RosterView(props: {
  attempt: AttemptJson;
  roster: WorkerRosterEntryJson[];
  sandbox: SandboxInfoJson | null;
  info: NormalizedSandboxInfo | null;
  onOpenTask: (taskId: string) => void;
}): ReactNode {
  const { roster, info } = props;
  const [showRaw, setShowRaw] = useState(false);
  const workerCount = roster.filter((m) => m.memberRole === "worker").length;
  return (
    <div className="pv">
      <div className="pv-bar">
        <button
          type="button"
          className="pv-toggle"
          onClick={() => setShowRaw((v) => !v)}
          title={showRaw ? "Switch to the humanized view" : "Show the stored blobs verbatim"}
        >
          {showRaw ? "≡ Pretty" : "{ } Raw"}
        </button>
      </div>
      {showRaw ? (
        <div className="pv-rows">
          {props.sandbox !== null ? (
            <JsonView value={props.sandbox} collapseDepth={2} label="Sandbox" />
          ) : null}
          <JsonView value={roster} collapseDepth={2} label="Roster" />
        </div>
      ) : (
        <div className="pv-rows">
          {info !== null ? <ApiSection info={info} /> : null}
          {roster.map((entry) => (
            <MemberSection
              key={`${entry.memberRole}-${String(entry.index)}`}
              entry={entry}
              sandboxWorker={info?.workers.find((w) => w.index === entry.index) ?? null}
              cellConfigId={props.attempt.configId}
              workerCount={workerCount}
              onOpenTask={props.onOpenTask}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** v7 §10.3 — one roster member block (per-member config, cost, tasks, sandbox). */
function MemberSection(props: {
  entry: WorkerRosterEntryJson;
  sandboxWorker: NormalizedWorker | null;
  cellConfigId: string;
  workerCount: number;
  onOpenTask: (taskId: string) => void;
}): ReactNode {
  const configs = useConfigs();
  const e = props.entry;
  const sw = props.sandboxWorker;
  const isLead = e.memberRole === "lead";
  const name = e.name ?? (isLead ? "Lead" : workerLabel(e.index, props.workerCount));
  // §12.3: the cell config stays the primary axis — members that overrode it
  // (configId/model non-null on the roster entry) get an explicit marker.
  const overridden = e.configId !== null || e.model !== null;
  const effConfigId = e.configId ?? props.cellConfigId;
  const effModel = e.model ?? configs.byId(effConfigId)?.model ?? null;
  return (
    <div className="pv-section">
      <div className="pv-section-title rd-member-title">
        <span className="rd-member-name">{name}</span>
        {isLead ? (
          <Tooltip text="Lead agent — tasks created without a member route here">
            {/* Round-10 item 2: crown AUGMENTS the LEAD badge (dashboard
                convention — lucide Crown next to the lead's name). */}
            <span className="rd-member-lead">
              <CrownIcon size={10} className="tm-crown" />
              LEAD
            </span>
          </Tooltip>
        ) : null}
        {e.agentTemplate !== null ? (
          <Tooltip text="Agent template (registry slug)">
            <span className="chip rd-member-template">{e.agentTemplate}</span>
          </Tooltip>
        ) : null}
        {e.role !== null ? <span className="dim rd-member-role">{e.role}</span> : null}
        {(e.status ?? null) !== null ? (
          <Tooltip text="Agent status at roster capture (v7 §10.3)">
            <span className="chip rd-member-status">{e.status}</span>
          </Tooltip>
        ) : null}
      </div>
      <div className="pv-section-body">
        <div className="pv-rows">
          <SbRow label="Config">
            <span className="rd-member-config">
              <ConfigChip configId={effConfigId} link />
              <ModelChip model={effModel} />
              {overridden ? (
                <Tooltip
                  text={`Overrides the cell config (${props.cellConfigId})${
                    e.configId !== null ? ` · config ${e.configId}` : ""
                  }${e.model !== null ? ` · model ${e.model}` : ""}`}
                >
                  <span className="rd-member-override">override</span>
                </Tooltip>
              ) : null}
            </span>
          </SbRow>
          <SbRow label="Cost">
            <Tooltip text="Harness-reported Σ over this member's tasks — a recomputed attempt cost may differ">
              <span>
                <CostBadge costUsd={e.costUsd} source={null} />
              </span>
            </Tooltip>{" "}
            <MemberTokens tokens={e.tokens} />
          </SbRow>
          <SbRow label={`Tasks (${String(e.taskIds.length)})`}>
            {e.taskIds.length > 0 ? (
              <span className="rd-member-tasks">
                {/* Item 1: chips ellipsize (no left-panel overflow); the portal
                    tooltip carries the full id. */}
                {e.taskIds.map((taskId) => (
                  <Tooltip key={taskId} text={`${taskId}\nOpen this task in the transcript`}>
                    <button
                      type="button"
                      className="chip rd-task-chip"
                      onClick={() => props.onOpenTask(taskId)}
                    >
                      {taskId}
                    </button>
                  </Tooltip>
                ))}
              </span>
            ) : (
              <span className="dim">—</span>
            )}
          </SbRow>
          <SbRow label="Sandbox">
            {e.sandboxId !== "" ? <CopyCode text={e.sandboxId} /> : <SbMono value={null} />}
          </SbRow>
          <SbRow label="Agent">
            <SbMono value={e.agentId !== "" ? e.agentId : null} />
          </SbRow>
          <SbRow label="Version">
            <SbMono value={e.version ?? sw?.version ?? null} />
          </SbRow>
          <SbRow label="Started">
            <SbDate value={sw?.startedAt ?? null} />
          </SbRow>
          <SbRow label="Expires">
            <SbDate value={sw?.expiresAt ?? null} />
          </SbRow>
          {e.capabilities.length > 0 ? (
            <SbRow label="Capabilities">
              <span className="dim rd-member-caps" title={e.capabilities.join(", ")}>
                {e.capabilities.join(", ")}
              </span>
            </SbRow>
          ) : null}
          {e.maxTasks !== null ? (
            <SbRow label="Max Tasks">
              <SbMono value={String(e.maxTasks)} />
            </SbRow>
          ) : null}
          {e.lastActivityAt !== null ? (
            <SbRow label="Last Active">
              <SbDate value={e.lastActivityAt} />
            </SbRow>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Compact per-member token total (v7 §10.3); the title carries the breakdown. */
function MemberTokens(props: { tokens: TokenTotalsJson | null }): ReactNode {
  const t = props.tokens;
  const total =
    t === null ? 0 : t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  if (t === null || total === 0) {
    return <span className="rd-member-tokens">· — tokens</span>;
  }
  const title = [
    `input ${t.inputTokens.toLocaleString()}`,
    `output ${t.outputTokens.toLocaleString()}`,
    `cache read ${t.cacheReadTokens.toLocaleString()}`,
    `cache write ${t.cacheWriteTokens.toLocaleString()}`,
  ].join("\n");
  return (
    <span className="rd-member-tokens" title={title}>
      · {fmtTokens(total)} tokens
    </span>
  );
}

function SandboxView(props: { raw: SandboxInfoJson; info: NormalizedSandboxInfo }): ReactNode {
  const { info } = props;
  const [showRaw, setShowRaw] = useState(false);
  // Lead is identified by role, never by count (v7 §12.6) — and excluded from
  // the worker count so a 1-worker + lead roster still shows plain "Worker".
  const workerCount = info.workers.filter((w) => w.role !== "lead").length;
  return (
    <div className="pv">
      <div className="pv-bar">
        <button
          type="button"
          className="pv-toggle"
          onClick={() => setShowRaw((v) => !v)}
          title={showRaw ? "Switch to the humanized view" : "Show the stored blob verbatim"}
        >
          {showRaw ? "≡ Pretty" : "{ } Raw"}
        </button>
      </div>
      {showRaw ? (
        <JsonView value={props.raw} collapseDepth={2} label="Sandbox" />
      ) : (
        <div className="pv-rows">
          <ApiSection info={info} />
          {info.workers.map((w) => (
            <div className="pv-section" key={w.index}>
              <div className="pv-section-title">{memberLabel(w, workerCount)}</div>
              <div className="pv-section-body">
                <div className="pv-rows">
                  <SbRow label="Sandbox">
                    <SbMono value={w.sandboxId} />
                  </SbRow>
                  <SbRow label="Agent">
                    <SbMono value={w.agentId} />
                  </SbRow>
                  <SbRow label="Template">
                    <SbMono value={w.template} />
                  </SbRow>
                  <SbRow label="Version">
                    <SbMono value={w.version} />
                  </SbRow>
                  <SbRow label="Started">
                    <SbDate value={w.startedAt} />
                  </SbRow>
                  <SbRow label="Expires">
                    <SbDate value={w.expiresAt} />
                  </SbRow>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** API sandbox block — shared by the roster view and the pre-v7 fallback. */
function ApiSection(props: { info: NormalizedSandboxInfo }): ReactNode {
  const { info } = props;
  return (
    <div className="pv-section">
      <div className="pv-section-title">API</div>
      <div className="pv-section-body">
        <div className="pv-rows">
          <SbRow label="API Sandbox">
            <SbMono value={info.apiSandboxId} />
          </SbRow>
          <SbRow label="Template">
            <SbMono value={info.apiTemplate} />
          </SbRow>
          <SbRow label="API URL">
            <a className="entity-link" href={info.apiUrl} target="_blank" rel="noreferrer">
              {info.apiUrl}
            </a>{" "}
            <InfoTip text="Dead after sandbox teardown" />
          </SbRow>
          <SbRow label="Swarm API Key">
            <CopyCode text={info.swarmKey} />
          </SbRow>
          <SbRow label="API Version">
            <SbMono value={info.apiVersion} />
          </SbRow>
          <SbRow label="Started">
            <SbDate value={info.apiStartedAt} />
          </SbRow>
        </div>
      </div>
    </div>
  );
}

function SbRow(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="pv-row">
      <div className="pv-key">{props.label}</div>
      <div className="pv-val">{props.children}</div>
    </div>
  );
}

function SbMono(props: { value: string | null }): ReactNode {
  if (props.value === null) return <span className="dim">—</span>;
  return <code className="rd-mono">{props.value}</code>;
}

function SbDate(props: { value: string | null }): ReactNode {
  if (props.value === null) return <span className="dim">—</span>;
  return (
    <span title={props.value}>
      {fmtDate(props.value)} <span className="dim">· {fmtAgo(props.value)}</span>
    </span>
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
    // v8.0 OutcomeSpec v2: the weighted dimension this judgment feeds. Gate rows
    // and pre-v2 rows carry NULL → rendered as a dim dash (frozen-contract).
    key: "dimension",
    header: "Dimension",
    width: "150px",
    sortValue: (j) => j.dimension ?? "",
    titleText: (j) => (j.dimension === null ? "" : `${j.dimension} · weight ${fmtScore(j.weight)}`),
    render: (j) =>
      j.dimension === null ? (
        <span className="rd-judgment-dim dim">—</span>
      ) : (
        <span className="rd-judgment-dim">
          {humanizeKey(j.dimension)}
          {j.weight === null ? null : (
            <span className="rd-judgment-weight"> ×{fmtScore(j.weight)}</span>
          )}
        </span>
      ),
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

/**
 * Per-dimension breakdown of a finished attempt (v8.0 OutcomeSpec v2). One entry
 * per dimension judgment (non-null `dimension`/`weight`); `aggregate` mirrors the
 * runner's weighted mean `Σ wᵢ·dimᵢ / Σ wᵢ`. Pre-v2 attempts have no dimension
 * rows → `rows` empty → the summary band is suppressed (old attempts unchanged).
 */
interface DimensionBreakdown {
  rows: { name: string; weight: number; score: number | null }[];
  aggregate: number | null;
}

function dimensionBreakdown(judgments: JudgmentJson[]): DimensionBreakdown {
  const rows = judgments
    .filter((j) => j.dimension !== null && j.weight !== null)
    .map((j) => ({ name: j.dimension as string, weight: j.weight as number, score: j.score }));
  let weightSum = 0;
  let weighted = 0;
  for (const r of rows) {
    if (r.score === null) continue;
    weightSum += r.weight;
    weighted += r.weight * r.score;
  }
  return { rows, aggregate: weightSum > 0 ? weighted / weightSum : null };
}

/**
 * Compact per-dimension weighted-score band (v8.0). Hidden when no dimension
 * rows. Each chip is a toggle that FOCUSES one dimension — the judgments table
 * below narrows to that dimension's rows; click again (or the title) to clear.
 * `focused` mirrors ChecksTab state; a focus on a now-absent dimension just
 * shows no chip pressed (the table filter falls through to "all").
 */
function DimensionSummary(props: {
  breakdown: DimensionBreakdown;
  focused: string | null;
  onFocus: (name: string | null) => void;
}): ReactNode {
  const { rows, aggregate } = props.breakdown;
  const { focused, onFocus } = props;
  if (rows.length === 0) return null;
  return (
    <div className="rd-dim-summary">
      <div className="rd-dim-summary-head">
        <button
          type="button"
          className="rd-dim-summary-title"
          title={focused !== null ? "Clear the dimension focus" : "Click a dimension to focus it"}
          onClick={() => onFocus(null)}
        >
          Dimensions
        </button>
        <Tooltip text="Weighted mean Σ wᵢ·dimᵢ / Σ wᵢ — excludes gate rows">
          <span className="rd-dim-summary-agg">{fmtScore(aggregate)}</span>
        </Tooltip>
        {focused !== null ? (
          <span className="rd-dim-summary-focus dim">· focused on {humanizeKey(focused)}</span>
        ) : null}
      </div>
      <div className="rd-dim-summary-rows">
        {rows.map((r) => {
          const isFocused = focused === r.name;
          return (
            <button
              type="button"
              className={isFocused ? "rd-dim-summary-chip focused" : "rd-dim-summary-chip"}
              key={r.name}
              aria-pressed={isFocused}
              title={
                isFocused
                  ? `Showing only ${humanizeKey(r.name)} judgments — click to show all`
                  : `Focus the judgments table on ${humanizeKey(r.name)}`
              }
              onClick={() => onFocus(isFocused ? null : r.name)}
            >
              <span className="rd-dim-summary-chip-name">{humanizeKey(r.name)}</span>
              <span className="rd-dim-summary-chip-weight">×{fmtScore(r.weight)}</span>
              <span className="rd-dim-summary-chip-score">{fmtScore(r.score)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChecksTab(props: {
  attempt: AttemptJson | null;
  judgments: JudgmentJson[];
  live: JudgeLiveResponse | null;
}): ReactNode {
  const { attempt, judgments, live } = props;
  const judging = attempt?.status === "judging";
  const breakdown = dimensionBreakdown(judgments);
  // v8.0 per-run dimension focus (per-attempt scope): null = show every
  // judgment; a name narrows the table below to that dimension's rows. Reset on
  // attempt change so a stale focus never leaks across attempts.
  const [focusedDim, setFocusedDim] = useState<string | null>(null);
  const attemptId = attempt?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: attemptId is the reset trigger — the effect must re-run to clear focus when the viewed attempt changes, even though it is not read inside the body.
  useEffect(() => {
    setFocusedDim(null);
  }, [attemptId]);
  // Only filter when the focused dimension still has rows in this attempt;
  // otherwise fall through to "all" (no empty table from a stale focus).
  const focusActive = focusedDim !== null && judgments.some((j) => j.dimension === focusedDim);
  const visibleJudgments = focusActive
    ? judgments.filter((j) => j.dimension === focusedDim)
    : judgments;
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
        <>
          <DimensionSummary
            breakdown={breakdown}
            focused={focusActive ? focusedDim : null}
            onFocus={setFocusedDim}
          />
          <DataTable
            rows={visibleJudgments}
            columns={JUDGMENT_COLUMNS}
            rowKey={(j) => j.id}
            searchable={false}
            emptyText="No judgments"
            renderExpanded={(j) => <JudgmentDetail judgment={j} />}
          />
        </>
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

// ---- logs tab (items 10 + 14 + v6 §3.4/§5: runner / per-worker / api sub-tabs,
//      live runner stream, shared LogLines display contract) ----

type LogSource = "runner" | "api" | `worker-${number}`;

/**
 * Worker sub-tab indices: from the normalized sandbox blob when present,
 * falling back to distinct `worker(-i)?.log` artifact names (legacy
 * `worker.log` maps to worker 0). At least [0], so a Worker tab always exists.
 */
function workerLogIndices(attempt: AttemptJson | null, artifacts: ArtifactMetaJson[]): number[] {
  const info = normalizeSandboxInfo(attempt?.sandbox ?? null);
  if (info !== null && info.workers.length > 0) return info.workers.map((w) => w.index);
  const found = new Set<number>();
  for (const a of artifacts) {
    if (a.kind !== "sandbox-log" || a.name === null) continue;
    const m = /^worker(?:-(\d+))?\.log$/.exec(a.name);
    if (m !== null) found.add(m[1] === undefined ? 0 : Number(m[1]));
  }
  if (found.size === 0) return [0];
  return [...found].sort((a, b) => a - b);
}

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
    getArtifactText(id)
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

/** Frozen lookup rules (v6 §3.4): worker-0 falls back to the legacy `worker.log` name. */
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
  if (source === "api") {
    return artifacts.find((a) => a.kind === "sandbox-log" && a.name === "api.log") ?? null;
  }
  const index = Number(source.slice("worker-".length));
  return (
    artifacts.find((a) => a.kind === "sandbox-log" && a.name === `worker-${index}.log`) ??
    (index === 0
      ? (artifacts.find((a) => a.kind === "sandbox-log" && a.name === "worker.log") ?? null)
      : null)
  );
}

function LogsTab(props: {
  attempt: AttemptJson | null;
  artifacts: ArtifactMetaJson[];
  progress: AttemptProgressResponse | null;
}): ReactNode {
  const { attempt, artifacts, progress } = props;
  const [source, setSource] = useState<LogSource>("runner");

  const workerIndices = useMemo(() => workerLogIndices(attempt, artifacts), [attempt, artifacts]);
  // The lead's entrypoint log is saved as worker-<index>.log like any member —
  // identify it by the sandboxJson role (v7 §12.6, never by position/count).
  const leadIndices = useMemo(() => {
    const info = normalizeSandboxInfo(attempt?.sandbox ?? null);
    return new Set((info?.workers ?? []).filter((w) => w.role === "lead").map((w) => w.index));
  }, [attempt]);
  const sources = useMemo<LogSource[]>(
    () => ["runner", ...workerIndices.map((i): LogSource => `worker-${i}`), "api"],
    [workerIndices],
  );
  // A selection that disappears (attempt switch, fewer workers) falls back to Runner.
  const active: LogSource = sources.includes(source) ? source : "runner";

  const sourceLabel = (s: LogSource): string => {
    if (s === "runner") return "Runner";
    if (s === "api") return "API";
    const index = Number(s.slice("worker-".length));
    if (leadIndices.has(index)) return "Lead";
    return workerLabel(index, workerIndices.length - leadIndices.size);
  };

  const unfinished = attempt !== null && isUnfinished(attempt.status);
  // Live runner stream (item 14) while the registry has the attempt; the
  // persisted runner.log artifact takes over once the attempt finishes.
  const liveRunner = active === "runner" && unfinished && progress?.active === true;
  const artifact = attempt !== null && !liveRunner ? findLogArtifact(artifacts, active) : null;
  const fetched = useArtifactText(artifact?.id ?? null);

  const liveLog = liveRunner ? (progress?.log ?? []) : null;
  const rows = useMemo<ParsedLogRow[]>(() => {
    if (liveLog !== null) {
      // Live rows arrive structured (ts + level); ANSI strip still applies at render (§5).
      return liveLog.map((l) => ({ ts: l.ts, level: l.level, text: stripAnsi(l.line) }));
    }
    if (fetched.text === null) return [];
    return parseLogText(fetched.text);
  }, [liveLog, fetched.text]);

  if (!attempt) return <div className="dim">No attempt selected</div>;

  let body: ReactNode;
  if (liveRunner) {
    body =
      rows.length === 0 ? (
        <div className="rd-stage">
          <Spinner label="Waiting for runner output…" />
        </div>
      ) : (
        <LogLines rows={rows} live />
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
      // v7.5 item 3: the artifact's raw bytes back the Copy-all affordance;
      // the live runner stream has no stored text (rawText stays null there).
      <LogLines rows={rows} rawText={fetched.text} />
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
        {active === "runner"
          ? "Runner log not captured (older run)"
          : active === "api"
            ? "API log not captured"
            : `${sourceLabel(active)} log not captured`}
      </div>
    );
  }

  return (
    <div className="rd-logs">
      <div className="rd-log-sources">
        {sources.map((s) => (
          <button
            type="button"
            key={s}
            className={active === s ? "btn rd-log-src selected" : "btn rd-log-src"}
            onClick={() => setSource(s)}
          >
            {sourceLabel(s)}
          </button>
        ))}
      </div>
      {body}
    </div>
  );
}

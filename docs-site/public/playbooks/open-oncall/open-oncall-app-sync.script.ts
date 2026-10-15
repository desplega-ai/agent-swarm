import type { ScriptContext } from "swarm-sdk";

/**
 * open-oncall-app-sync: projects the `open-oncall` workflow runs into the
 * Open Oncall app. One script, three models (args.model):
 *   incident: one row per accepted alert run (status, severity, root cause, providers)
 *   event:    the incident timeline (alert → ack → investigate attempts → root cause →
 *             approval → fix attempts → PR → resolved / handed to a human)
 *   stats:    one "summary" row (open incidents, median time to root cause, failovers this week)
 * Reads only: workflow runs and their steps. Runs whose intake did not accept the
 * message (chatter in a bot channel) are skipped.
 */

const WORKFLOW_ID = "<OPEN_ONCALL_WORKFLOW_ID>";
const DASHBOARD = "<DASHBOARD_URL>";
const WEEK_MS = 7 * 24 * 3600 * 1000;

type Attempt = {
  index?: number;
  harness?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  taskId?: string | null;
  status?: string | null;
  reason?: string | null;
  providerError?: boolean;
  simulated?: boolean;
  model?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

type Rec = { key: string; fields: Record<string, unknown> };

function unwrap(x: any): any {
  if (x && typeof x === "object" && "data" in x && !("runs" in x) && !("run" in x)) return x.data;
  return x;
}

function ms(iso: unknown): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function fmtDuration(d: number | null): string {
  if (d == null || d < 0) return "";
  const s = Math.round(d / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

const MADRID = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function clock(iso: unknown): string {
  const t = ms(iso);
  return t == null ? "" : MADRID.format(new Date(t));
}

function who(a: Attempt | null | undefined): string {
  if (!a) return "";
  return [a.harness, a.agentName, a.model].filter(Boolean).join(" · ");
}

function failoverChain(attempts: Attempt[]): string {
  const ran = attempts.filter((a) => a.status && a.status !== "skipped");
  if (!ran.some((a) => a.status === "failed" || a.status === "cancelled")) return "";
  return ran.map((a) => a.harness ?? "?").join(" → ");
}

function short(s: unknown, n: number): string {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const STATUS = {
  investigating: "Investigating",
  awaiting: "Awaiting approval",
  fixing: "Fixing",
  resolved: "Resolved",
  human: "Handed to a human",
} as const;

type ApprovalRow = { id: string; status: string; expiresAt: string | null };

const STATUS_TONE: Record<string, string> = {
  [STATUS.investigating]: "info",
  [STATUS.awaiting]: "pending",
  [STATUS.fixing]: "active",
  [STATUS.resolved]: "success",
  [STATUS.human]: "neutral",
};

function buildRun(run: any, steps: any[], live: ApprovalRow | undefined) {
  const c = run.context ?? {};
  const intake = c.intake?.result ?? {};
  const alert = intake.alert ?? {};
  const step = (id: string) => steps.find((s) => s.nodeId === id) ?? null;
  const sIntake = step("intake");
  const sInv = step("investigate");
  const sAppr = step("approval");
  const sFix = step("fix");
  const sClose = step("close");

  const inv = c.investigate?.outputs?.pick?.result ?? null;
  const fix = c.fix?.outputs?.pick?.result ?? null;
  const close = c.close?.result ?? null;
  const findings = inv?.ok ? (inv.output ?? null) : null;
  const approvalStatus: string | null =
    live?.status ?? c.approval?.status ?? close?.approval?.status ?? (sAppr?.status === "waiting" ? "pending" : null);
  const requestId: string | null =
    live?.id ?? c.approval?.requestId ?? c.findings?.result?.requestId ?? close?.approval?.requestId ?? null;
  const approvalUrl: string = requestId ? `${DASHBOARD}/approval-requests/${requestId}` : "";

  let status: string;
  if (close) status = close.outcome === "resolved" ? STATUS.resolved : STATUS.human;
  else if (run.status === "failed" || run.status === "cancelled") status = STATUS.human;
  else if (approvalStatus && ["rejected", "timeout", "cancelled"].includes(approvalStatus)) status = STATUS.human;
  else if (sFix || approvalStatus === "approved") status = STATUS.fixing;
  else if (sAppr?.status === "waiting") status = STATUS.awaiting;
  else status = STATUS.investigating;

  const alertAt: string = intake.alertAt ?? intake.startedAt ?? run.startedAt;
  const alertMs = ms(alertAt);
  const rootCauseAt: string | null = findings ? (inv?.finishedAt ?? sInv?.finishedAt ?? null) : null;
  const rcMs = ms(rootCauseAt);
  const ttrcMs: number | null =
    typeof close?.timeToRootCauseMs === "number"
      ? close.timeToRootCauseMs
      : rcMs != null && alertMs != null
        ? rcMs - alertMs
        : null;
  const prUrl: string = fix?.output?.prUrl ?? close?.prUrl ?? "";
  const invAttempts: Attempt[] = inv?.attempts ?? close?.providers?.investigate?.attempts ?? [];
  const fixAttempts: Attempt[] = fix?.attempts ?? close?.providers?.fix?.attempts ?? [];
  const invChain = failoverChain(invAttempts);
  const fixChain = failoverChain(fixAttempts);
  const failovers = (invChain ? 1 : 0) + (fixChain ? 1 : 0);
  const drill = !!intake.simulateProviderDown;
  const sourceLabel: string =
    alert.sourceLabel ?? (intake.source === "manual" ? "Manual alert" : intake.source === "slack" ? "Slack" : (intake.source ?? "Alert"));
  const sev = findings?.severity
    ? String(findings.severity).toUpperCase()
    : alert.severity
      ? String(alert.severity).toUpperCase()
      : "";
  const resolvedAt: string | null = sClose?.finishedAt ?? run.finishedAt ?? null;
  const winnerInv = invAttempts.find((a) => a.status === "completed") ?? null;
  const winnerFix = fixAttempts.find((a) => a.status === "completed") ?? null;
  const evidence: string[] = Array.isArray(findings?.evidence) ? findings.evidence : [];

  const incident: Rec = {
    key: run.id,
    fields: {
      incidentRef: alert.incidentId ? `${sourceLabel} ${alert.incidentId}` : sourceLabel,
      alertSource: sourceLabel,
      title: short(alert.title ?? intake.alertText ?? "", 160),
      service: alert.service ?? "",
      repo: intake.repo ?? close?.repo ?? "",
      severity: sev || "—",
      status,
      open: status !== STATUS.resolved && status !== STATUS.human,
      alertAt,
      rootCauseAt,
      resolvedAt: close ? resolvedAt : null,
      ttrcMs,
      ttrc: fmtDuration(ttrcMs) || "—",
      summary: findings?.summary ?? "",
      rootCause: findings?.rootCause ?? "",
      proposedFix: findings?.proposedFix ?? "",
      evidence: evidence.map((e) => `- ${e}`).join("\n"),
      suspectCommit: findings?.suspectCommit ? String(findings.suspectCommit).slice(0, 7) : "",
      confidence: typeof findings?.confidence === "number" ? `${Math.round(findings.confidence * 100)}%` : "",
      investigatedBy: who(winnerInv),
      fixedBy: who(winnerFix),
      failover: failovers
        ? `${[invChain && `investigate ${invChain}`, fixChain && `fix ${fixChain}`].filter(Boolean).join(" · ")}${drill ? ` (drill: ${intake.simulateProviderDown} marked down)` : ""}`
        : "",
      failoverShort: [...new Set([invChain, fixChain].filter(Boolean))].join(" · "),
      statusTone: STATUS_TONE[status] ?? "neutral",
      sevTone: /1$/.test(sev) ? "error" : /2$/.test(sev) ? "warning" : sev ? "info" : "neutral",
      approvalAsk: `Approve opens one fix PR on ${intake.repo ?? "the repo"}. Nothing is merged. Reject hands the incident to a human.`,
      failovers,
      drill,
      prUrl,
      approvalId: requestId ?? "",
      approvalState: approvalStatus ?? "",
      approvalExpiresAt: approvalStatus === "pending" ? (live?.expiresAt ?? null) : null,
      respondPath: requestId && approvalStatus === "pending" ? `/api/approval-requests/${requestId}/respond` : "",
      approvalUrl,
      runUrl: `${DASHBOARD}/workflow-runs/${run.id}`,
      linksMd: [
        prUrl && `[Fix PR #${prUrl.split("/").pop()}](${prUrl})`,
        alert.url && `[${sourceLabel} incident](${alert.url})`,
        approvalUrl && `[Approval request](${approvalUrl})`,
        `[Workflow run](${DASHBOARD}/workflow-runs/${run.id})`,
      ]
        .filter(Boolean)
        .join(" · "),
      runStatus: run.status,
      outcome: close?.outcome ?? "",
    },
  };

  const events: Rec[] = [];
  let seq = 0;
  const push = (f: Record<string, unknown>) => {
    seq += 1;
    events.push({
      key: `${run.id}:${String(seq).padStart(2, "0")}`,
      fields: { runId: run.id, seq, provider: "", agent: "", model: "", detail: "", link: "", ...f, time: clock(f.at) },
    });
  };

  push({
    at: alertAt,
    stage: "Alert",
    title: `${sourceLabel}${alert.incidentId ? ` ${alert.incidentId}` : ""} fired`,
    detail: short(alert.title ?? intake.alertText ?? "", 200),
    state: "fired",
    link: alert.url ?? "",
  });
  if (sIntake?.finishedAt && intake.threadTs) {
    push({ at: sIntake.finishedAt, stage: "Ack", title: "Investigating, posted in the Slack thread", state: "ok" });
  }
  const attemptEvents = (stage: string, attempts: Attempt[], fallbackAt: string | null) => {
    const ran = attempts.filter((a) => a.status && a.status !== "skipped");
    ran.forEach((a, i) => {
      const failed = a.status === "failed" || a.status === "cancelled";
      const next = ran[i + 1];
      push({
        at: a.startedAt ?? fallbackAt,
        stage,
        title: failed
          ? `${a.harness} failed${next ? `, rerouted to ${next.harness}` : ""}`
          : a.status === "completed"
            ? `Handled by ${a.harness}`
            : `Running on ${a.harness}`,
        detail: failed ? `${a.reason ?? "failed"}${a.simulated ? " (failover drill)" : ""}` : "",
        provider: a.harness ?? "",
        agent: a.agentName ?? "",
        model: a.model ?? "",
        state: failed ? "failover" : a.status === "completed" ? "ok" : "running",
      });
    });
    return ran.length;
  };

  if (sInv) {
    const n = attemptEvents("Investigate", invAttempts, sInv.startedAt);
    if (n === 0 && sInv.status !== "completed") {
      push({ at: sInv.startedAt, stage: "Investigate", title: "Reading logs, traces, deploys and code", state: "running" });
    }
  }
  if (findings) {
    push({
      at: rootCauseAt,
      stage: "Root cause",
      title: short(findings.summary, 140),
      detail: `${sev}${findings.confidence != null ? ` · confidence ${Math.round(findings.confidence * 100)}%` : ""}${ttrcMs != null ? ` · ${fmtDuration(ttrcMs)} after the alert` : ""}`,
      provider: winnerInv?.harness ?? "",
      agent: winnerInv?.agentName ?? "",
      model: winnerInv?.model ?? "",
      state: "ok",
    });
  } else if (inv && !inv.ok) {
    push({ at: inv.finishedAt ?? sInv?.finishedAt, stage: "Root cause", title: "No provider could diagnose it", state: "failed" });
  }
  if (sAppr) {
    push({
      at: sAppr.startedAt,
      stage: "Approval",
      title: "Fix approval requested in Slack",
      state: approvalStatus === "pending" ? "waiting" : "ok",
      link: approvalUrl,
    });
    if (approvalStatus && approvalStatus !== "pending") {
      const label =
        approvalStatus === "approved" ? "Approved" : approvalStatus === "timeout" ? "Approval timed out" : "Rejected";
      push({
        at: sAppr.finishedAt,
        stage: "Approval",
        title: label,
        detail: approvalStatus === "approved" ? "" : "A human takes over",
        state: approvalStatus === "approved" ? "ok" : "failed",
      });
    }
  }
  if (sFix) {
    const n = attemptEvents("Fix", fixAttempts, sFix.startedAt);
    if (n === 0 && sFix.status !== "completed") {
      push({ at: sFix.startedAt, stage: "Fix", title: "Writing the fix", state: "running" });
    }
  }
  if (prUrl) {
    push({
      at: fix?.finishedAt ?? sFix?.finishedAt,
      stage: "PR",
      title: `Fix PR opened${fix?.output?.testsPassed ? ", tests green" : ""}`,
      detail: short(fix?.output?.summary ?? "", 200),
      provider: winnerFix?.harness ?? "",
      agent: winnerFix?.agentName ?? "",
      model: winnerFix?.model ?? "",
      state: "ok",
      link: prUrl,
    });
  }
  if (close) {
    const resolved = close.outcome === "resolved";
    push({
      at: resolvedAt,
      stage: resolved ? "Resolved" : "Handed off",
      title: resolved ? "Resolved, summary posted in the thread" : "Handed to a human",
      detail: resolved ? `Time to PR ${fmtDuration(close.timeToPrMs ?? null)}` : String(close.outcome ?? "").replace(/_/g, " "),
      state: resolved ? "ok" : "failed",
    });
  }

  return { incident, events, meta: { open: incident.fields.open as boolean, alertMs, ttrcMs, failovers, drill } };
}

export default async function (args: any, ctx: ScriptContext) {
  const a = args ?? {};
  const model: string = a.model ?? "incident";
  const workflowId: string = a.workflowId ?? WORKFLOW_ID;

  const runs: any[] = [];
  let complete = true;
  for (let offset = 0; offset < 300; offset += 100) {
    const page = unwrap(await (ctx.swarm as any).workflow_listRuns({ workflowId, limit: 100, offset, includeContext: true }));
    runs.push(...(page?.runs ?? []));
    if (!page?.page?.hasMore) break;
    if (offset + 100 >= 300) complete = false;
  }
  // The list rows are slim (no context), so read each run in full and keep the
  // ones whose intake accepted the message as an alert.
  const full: any[] = [];
  for (const r of runs) {
    const one = unwrap(await (ctx.swarm as any).workflow_getRun({ id: r.id }));
    if (one?.run?.context?.intake?.result?.accept === true) full.push(one);
  }

  // Live approval state per run (the run context only records it once resolved,
  // and older runs never stored the request id). Newest request per run wins.
  const live = new Map<string, ApprovalRow>();
  if (full.length > 0) {
    try {
      const ids = full.map((f) => `'${String(f.run.id).replace(/[^0-9a-f-]/gi, "")}'`).join(",");
      const q: any = unwrap(
        await (ctx.swarm as any).db_query({
          sql: `SELECT id, workflowRunId, status, expiresAt FROM approval_requests WHERE workflowRunId IN (${ids}) ORDER BY createdAt ASC`,
        }),
      );
      for (const [id, runId, status, expiresAt] of q?.rows ?? []) live.set(runId, { id, status, expiresAt });
    } catch {
      // Fall back to what the run context recorded.
    }
  }

  const built = full.map((f) => buildRun(f.run, f.steps ?? [], live.get(f.run.id)));

  if (model === "incident") return { records: built.map((b) => b.incident), complete };
  if (model === "event") return { records: built.flatMap((b) => b.events), complete };

  const now = Date.now();
  const ttrcs = built
    .map((b) => b.meta.ttrcMs)
    .filter((x): x is number => typeof x === "number" && x >= 0)
    .sort((x, y) => x - y);
  const median =
    ttrcs.length === 0
      ? null
      : ttrcs.length % 2
        ? ttrcs[(ttrcs.length - 1) / 2]
        : Math.round((ttrcs[ttrcs.length / 2 - 1] + ttrcs[ttrcs.length / 2]) / 2);
  const week = built.filter((b) => b.meta.alertMs != null && now - (b.meta.alertMs as number) <= WEEK_MS);
  const failoversWeek = week.reduce((n, b) => n + b.meta.failovers, 0);
  const drillsWeek = week.filter((b) => b.meta.drill).reduce((n, b) => n + b.meta.failovers, 0);
  return {
    records: [
      {
        key: "summary",
        fields: {
          openIncidents: built.filter((b) => b.meta.open).length,
          openNote: `${built.filter((b) => b.incident.fields.status === STATUS.awaiting).length} awaiting approval · ${built.length} total`,
          ttrcNote: ttrcs.length ? `Alert to root cause, over ${ttrcs.length} incident${ttrcs.length === 1 ? "" : "s"}` : "No root cause yet",
          incidents: built.length,
          medianTtrcMs: median,
          medianTtrc: median == null ? "—" : fmtDuration(median),
          ttrcSample: ttrcs.length,
          failoversWeek,
          failoverNote:
            failoversWeek === 0 ? "No provider failed this week" : drillsWeek === failoversWeek ? `All ${drillsWeek} from failover drills` : `${drillsWeek} from drills`,
        },
      },
    ],
    complete: true,
  };
}

import type { ScriptContext } from "swarm-sdk";

/**
 * open-oncall: deterministic steps of the Open Oncall workflow.
 *
 * ops
 * - intake:   normalize a slack.message or manual trigger, filter non-alerts,
 *             plan the provider failover chain per step, post "Investigating".
 * - pick:     (failover child workflow) read every attempt task of the child run,
 *             return the first success plus the provider record of every attempt.
 * - findings: post root cause + proposed fix + approval link in the alert thread.
 * - close:    post the final thread message and return the run summary
 *             (outcome, time to root cause, provider per step).
 *
 * Slack posts need lead privileges (slack-post is lead-only), so the workflow
 * that runs this script must be created by a lead. A non-lead run degrades to
 * { posted:false } and keeps going.
 */

type Row = unknown[];
type Attempt = {
  index: number;
  harness: string;
  agentId: string | null;
  agentName: string | null;
  taskId: string | null;
  status: "completed" | "failed" | "cancelled" | "pending" | "skipped";
  reason: string | null;
  providerError: boolean;
  simulated: boolean;
  model: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

const HARNESSES = ["claude", "codex", "opencode"];
const PROVIDER_ERROR_RE =
  /simulated provider outage|rate.?limit|\b429\b|\b5\d\d\b|overloaded|unavailable|unauthori[sz]ed|\b401\b|\b403\b|credential|quota|timed? ?out|ECONN|provider|harness|session (crashed|died)|auth/i;
const STEP_CAPS: Record<string, string[]> = {
  investigate: ["research", "codebase-analysis", "code-review", "pr-review", "debugging", "analysis"],
  fix: ["implementation", "bug-fixes", "pr-creation", "small-changes", "typescript", "git"],
};

async function q(ctx: ScriptContext, sql: string, params: unknown[] = []): Promise<Row[]> {
  const res = (await ctx.swarm.db_query({ sql, params })) as {
    success?: boolean;
    data?: { rows?: Row[]; error?: string };
  };
  if (res?.success === false) throw new Error(`db_query failed: ${res?.data?.error ?? "unknown"}`);
  return res?.data?.rows ?? [];
}

async function post(ctx: ScriptContext, channelId: string | null, text: string, threadTs?: string | null) {
  if (!channelId) return { posted: false, ts: null as string | null, error: "no channel", text };
  try {
    // slack-post caps message at 4000 chars.
    const payload: Record<string, unknown> = { channelId, message: text.length > 3900 ? `${text.slice(0, 3900)}…` : text };
    if (threadTs) payload.threadTs = threadTs;
    // slack_post's SDK type omits threadTs; the slack-post tool accepts it.
    const res = (await ctx.swarm.slack_post(payload as { channelId: string; message: string })) as Record<
      string,
      any
    >;
    const ok = res?.success !== false && res?.data?.success !== false;
    const ts = res?.messageTs ?? res?.data?.messageTs ?? res?.data?.data?.messageTs ?? res?.ts ?? null;
    if (!ok) return { posted: false, ts: null, error: String(res?.message ?? res?.data?.message ?? "slack_post failed"), text };
    return { posted: true, ts: ts ? String(ts) : null, error: null, text };
  } catch (err) {
    return { posted: false, ts: null, error: String(err instanceof Error ? err.message : err), text };
  }
}

function asObj(v: unknown): Record<string, any> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, any>;
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

function parseJsonOutput(raw: unknown): Record<string, any> | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as Record<string, any>;
  const s = String(raw).trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : s;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function slackTsToIso(ts?: string | null): string | null {
  if (!ts) return null;
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

function fmtDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "n/a";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

function csv(v: unknown): string[] {
  return String(v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function describeStep(step: Record<string, any> | null): string {
  if (!step?.handledBy) {
    const tried = (step?.attempts ?? []).filter((x: Attempt) => x.status !== "skipped");
    return tried.length
      ? `no provider completed (${tried.map((x: Attempt) => `${x.harness}: ${String(x.reason ?? x.status).slice(0, 60)}`).join("; ")})`
      : "no provider completed";
  }
  const failed = (step.attempts ?? []).filter((a: Attempt) => a.status === "failed" || a.status === "cancelled");
  const by = `${step.handledBy.harness} (${step.handledBy.agentName ?? "agent"})`;
  if (failed.length === 0) return by;
  const why = failed
    .map((a: Attempt) => `${a.harness}${a.simulated ? " simulated outage" : a.providerError ? " provider error" : " failed"}`)
    .join(", ");
  return `${by}, failed over from ${why}`;
}

// ─── intake ──────────────────────────────────────────────────

async function planChain(ctx: ScriptContext, step: string, order: string[]) {
  const rows = await q(
    ctx,
    "SELECT id, name, status, COALESCE(harness_provider, provider) AS harness, capabilities FROM agents WHERE isLead = 0 AND status != 'offline' AND name NOT LIKE 'ext:%'",
  );
  const caps = STEP_CAPS[step] ?? [];
  const chain: { harness: string; agentId: string; agentName: string }[] = [];
  for (const harness of order) {
    const candidates = rows
      .filter((r) => String(r[3] ?? "") === harness)
      .map((r) => {
        let c: string[] = [];
        try {
          c = JSON.parse(String(r[4] ?? "[]"));
        } catch {}
        const score = c.filter((x) => caps.includes(x)).length * 10 + (r[2] === "idle" ? 1 : 0);
        return { agentId: String(r[0]), agentName: String(r[1]), score };
      })
      .sort((a, b) => b.score - a.score || a.agentName.localeCompare(b.agentName));
    if (candidates[0]) chain.push({ harness, ...candidates[0] });
  }
  return chain;
}

function drillPreamble(harness: string, simulate: string | null): string {
  if (!simulate || simulate !== harness) return "";
  return (
    `OPEN ONCALL FAILOVER DRILL. This step is a staged outage of the ${harness} provider.\n` +
    `Do not investigate or change anything. Immediately call store-progress with status "failed" and ` +
    `failureReason "simulated provider outage: ${harness} unavailable (HTTP 529 overloaded)". Then stop.\n\n---\n\n`
  );
}

function flattenChain(chain: { harness: string; agentId: string; agentName: string }[], simulate: string | null) {
  const out: Record<string, string> = {};
  for (let i = 0; i < 3; i++) {
    const c = chain[i] ?? chain[chain.length - 1];
    out[`agent${i + 1}`] = c?.agentId ?? "";
    out[`harness${i + 1}`] = c?.harness ?? "";
    out[`name${i + 1}`] = c?.agentName ?? "";
    out[`preamble${i + 1}`] = drillPreamble(c?.harness ?? "", simulate);
  }
  out.order = chain.map((c) => c.harness).join(" → ");
  return out;
}

type Alert = {
  source: "slack" | "pagerduty" | "alertmanager" | "datadog" | "opsgenie" | "sentry" | "webhook";
  sourceLabel: string;
  text: string;
  title: string | null;
  url: string | null;
  service: string | null;
  severity: string | null;
  incidentId: string | null;
  ignored: string | null;
};

const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

/**
 * Normalize any alert source into one shape. PagerDuty v3 webhooks are the primary
 * source; Alertmanager/Grafana, Datadog, Opsgenie, Sentry and a plain JSON body also work.
 */
function normalizeAlert(t: Record<string, any>): Alert {
  const base = { title: null, url: null, service: null, severity: null, incidentId: null, ignored: null };
  // Slack slack.message event.
  if (typeof t.ts === "string" && typeof t.text === "string" && !t.alertText && !t.event) {
    return { ...base, source: "slack", sourceLabel: "Slack", text: String(t.text).trim() };
  }
  // PagerDuty v3 webhook: { event: { event_type, resource_type, data: <incident> } }.
  const ev = asObj(t.event);
  if (ev?.event_type && asObj(ev.data)) {
    const d = asObj(ev.data)!;
    const title = str(d.title) ?? "untitled incident";
    const service = str(asObj(d.service)?.summary);
    const urgency = str(d.urgency);
    const priority = str(asObj(d.priority)?.summary);
    const num = str(d.number);
    return {
      source: "pagerduty",
      sourceLabel: "PagerDuty",
      title,
      url: str(d.html_url),
      service,
      severity: priority ?? urgency,
      incidentId: num ? `#${num}` : str(d.id),
      ignored: ev.event_type === "incident.triggered" ? null : `PagerDuty event ${ev.event_type} is not incident.triggered`,
      text: `PagerDuty incident ${num ? `#${num} ` : ""}triggered: ${title}.${service ? ` Service: ${service}.` : ""}${urgency ? ` Urgency: ${urgency}.` : ""}${priority ? ` Priority: ${priority}.` : ""}`,
    };
  }
  // Alertmanager / Grafana unified alerting: { status, alerts: [{ labels, annotations }] }.
  if (Array.isArray(t.alerts) && t.status) {
    const firing = t.alerts.filter((x: any) => (x?.status ?? t.status) === "firing");
    const first = asObj(firing[0]) ?? {};
    const labels = asObj(first.labels) ?? {};
    const ann = asObj(first.annotations) ?? {};
    const title = str(labels.alertname) ?? str(t.title) ?? "alert";
    return {
      ...base,
      source: "alertmanager",
      sourceLabel: t.orgId != null ? "Grafana" : "Alertmanager",
      title,
      url: str(first.generatorURL) ?? str(t.externalURL),
      service: str(labels.service) ?? str(labels.job),
      severity: str(labels.severity),
      ignored: firing.length ? null : `status ${t.status}, nothing firing`,
      text: `${title}: ${str(ann.summary) ?? str(ann.description) ?? str(t.message) ?? ""}`.trim(),
    };
  }
  // Opsgenie: { action, alert: { message, ... } }.
  if (asObj(t.alert)?.message && t.action) {
    const al = asObj(t.alert)!;
    return {
      ...base,
      source: "opsgenie",
      sourceLabel: "Opsgenie",
      title: str(al.message),
      service: str(asObj(al.details)?.service) ?? str(al.entity),
      severity: str(al.priority),
      incidentId: str(al.tinyId),
      ignored: t.action === "Create" ? null : `Opsgenie action ${t.action} is not Create`,
      text: `${al.message}${al.description ? `: ${al.description}` : ""}`,
    };
  }
  // Sentry issue alert: { action, data: { issue | event } }.
  const sd = asObj(asObj(t.data)?.issue) ?? asObj(asObj(t.data)?.event);
  if (sd?.title) {
    return {
      ...base,
      source: "sentry",
      sourceLabel: "Sentry",
      title: str(sd.title),
      url: str(sd.web_url) ?? str(sd.permalink),
      service: str(asObj(sd.project)?.slug) ?? str(sd.project),
      severity: str(sd.level),
      text: `${sd.title}${sd.culprit ? ` in ${sd.culprit}` : ""}`,
    };
  }
  // Datadog webhook template ($EVENT_TITLE / $EVENT_MSG / $ALERT_TRANSITION / $LINK).
  if (t.title && (t.alert_transition || t.alert_type || t.event_type || t.body)) {
    return {
      ...base,
      source: "datadog",
      sourceLabel: "Datadog",
      title: str(t.title),
      url: str(t.link) ?? str(t.url),
      service: str(t.service),
      severity: str(t.priority) ?? str(t.alert_type),
      ignored: /recovered/i.test(String(t.alert_transition ?? "")) ? "Datadog transition Recovered" : null,
      text: `${t.title}${t.body ? `: ${t.body}` : ""}`,
    };
  }
  // Manual trigger or any JSON webhook.
  const text = str(t.alertText) ?? str(t.message) ?? str(t.summary) ?? str(t.title) ?? str(t.text) ?? "";
  return {
    ...base,
    source: "webhook",
    sourceLabel: str(t.source) ?? "Alert",
    title: str(t.title),
    url: str(t.url),
    service: str(t.service),
    severity: str(t.severity),
    text: text.trim(),
  };
}

function alertRootText(al: Alert): string {
  if (al.source === "pagerduty") {
    const id = al.incidentId ? (al.url ? `<${al.url}|${al.incidentId}>` : al.incidentId) : "";
    return [
      `🚨 *PagerDuty* · incident ${id} triggered`,
      `*${al.title}*`,
      [al.service ? `Service: \`${al.service}\`` : null, al.severity ? `Severity: ${al.severity}` : null].filter(Boolean).join(" · "),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return `🚨 *${al.sourceLabel}*${al.url ? ` · <${al.url}|open>` : ""}\n${al.text}`;
}

function serviceRepo(map: unknown, service: string | null): string | null {
  if (!service) return null;
  for (const pair of csv(map)) {
    const [k, v] = pair.split("=").map((x) => x.trim());
    if (k && v && k.toLowerCase() === service.toLowerCase()) return v;
  }
  return null;
}

async function intake(ctx: ScriptContext, a: Record<string, any>) {
  const t = asObj(a.trigger) ?? {};
  const startedAt = new Date().toISOString();
  const al = normalizeAlert(t);
  const fromSlack = al.source === "slack";
  // Webhooks carry no channel: they post to ONCALL_CHANNEL unless the payload names one.
  const channelId: string | null = (t.channelId ?? (fromSlack ? t.channel : null) ?? a.oncallChannel ?? null) || null;
  const alertText = al.text;
  const alertChannels = csv(a.alertChannels);
  const pattern = new RegExp(String(a.alertPattern || "alert|firing|incident|5xx|error rate|latency|p9[59]|down|🚨"), "i");
  const allowedRepos = csv(a.allowedRepos);
  const repoInText = alertText.match(/(?:repo[:=]\s*|github\.com\/)([\w.-]+\/[\w.-]+)/i)?.[1];
  const repo = String(t.repo || serviceRepo(a.serviceRepos, al.service) || repoInText || a.defaultRepo || "").replace(/\.git$/, "");
  const simulate = t.simulateProviderDown ? String(t.simulateProviderDown).toLowerCase() : null;
  const order = csv(a.providerOrder).length ? csv(a.providerOrder) : HARNESSES;

  let reason: string | null = null;
  if (al.ignored) reason = al.ignored;
  else if (!alertText) reason = "empty alert text";
  else if (fromSlack && t.threadTs && t.threadTs !== t.ts) reason = "thread reply, not a new alert";
  // Manual triggers too: lead-privileged posts only ever land in ALERT_CHANNELS.
  else if (channelId && !alertChannels.includes(String(channelId))) reason = "channel is not an alert channel";
  else if (fromSlack && !pattern.test(alertText)) reason = "message does not look like an alert";
  else if (!repo) reason = "no repo: set trigger.repo or the DEFAULT_REPO input";
  else if (allowedRepos.length && !allowedRepos.includes(repo)) reason = `repo ${repo} is not in ALLOWED_REPOS`;
  else if (simulate && !HARNESSES.includes(simulate)) reason = `simulateProviderDown must be one of ${HARNESSES.join(", ")}`;
  if (reason) return { accept: false, reason, source: al.source, startedAt };

  const investigate = await planChain(ctx, "investigate", order);
  const fix = await planChain(ctx, "fix", order);
  if (investigate.length === 0 || fix.length === 0) {
    return { accept: false, reason: "no online worker for any provider", startedAt };
  }

  const slack: Record<string, unknown>[] = [];
  let threadTs: string | null = fromSlack ? String(t.ts) : (t.threadTs ?? null);
  let alertAt = fromSlack ? slackTsToIso(String(t.ts)) : null;
  if (!fromSlack && channelId && !threadTs) {
    // Webhook or manual alert: post the alert itself as the thread root.
    const root = await post(ctx, channelId, alertRootText(al));
    slack.push({ kind: "alert", ...root });
    threadTs = root.ts;
    alertAt = slackTsToIso(root.ts) ?? startedAt;
  }
  const inv = flattenChain(investigate, simulate);
  const ack = await post(
    ctx,
    channelId,
    `👀 *Open Oncall* is investigating \`${repo}\`.\nPrimary: *${investigate[0]!.harness}* (${investigate[0]!.agentName}). Failover: ${investigate
      .slice(1)
      .map((c) => c.harness)
      .join(" → ") || "none"}.${simulate ? `\n_Failover drill: ${simulate} is marked down for this run._` : ""}`,
    threadTs,
  );
  slack.push({ kind: "ack", ...ack });

  return {
    accept: true,
    reason: null,
    source: al.source,
    alert: { source: al.source, sourceLabel: al.sourceLabel, title: al.title, url: al.url, service: al.service, severity: al.severity, incidentId: al.incidentId },
    channelId,
    threadTs,
    alertText,
    repo,
    simulateProviderDown: simulate,
    startedAt,
    alertAt: alertAt ?? startedAt,
    chains: { investigate, fix },
    investigate: inv,
    fix: flattenChain(fix, simulate),
    slack,
  };
}

// ─── pick (failover child) ───────────────────────────────────

async function pick(ctx: ScriptContext, a: Record<string, any>) {
  const runId = String(a.runId ?? "");
  const simulate = a.simulateProviderDown ? String(a.simulateProviderDown) : null;
  const planned = [1, 2, 3].map((i) => ({ harness: String(a[`harness${i}`] ?? ""), agentId: String(a[`agent${i}`] ?? "") }));
  const rows = await q(
    ctx,
    `SELECT t.id, t.agentId, a.name, COALESCE(a.harness_provider, a.provider, t.provider) AS harness, t.status, t.failureReason,
            t.output, COALESCE(t.resolvedModel, t.model) AS model, t.createdAt, t.finishedAt, s.nodeId
       FROM agent_tasks t
       LEFT JOIN agents a ON a.id = t.agentId
       LEFT JOIN workflow_run_steps s ON s.id = t.workflowRunStepId
      WHERE t.workflowRunId = ?
      ORDER BY t.createdAt ASC`,
    [runId],
  );
  const attempts: Attempt[] = planned.map((p, i) => {
    const row = rows.find((r) => r[10] === `try-${i + 1}`);
    if (!row) {
      return {
        index: i + 1,
        harness: p.harness,
        agentId: p.agentId || null,
        agentName: null,
        taskId: null,
        status: "skipped",
        reason: null,
        providerError: false,
        simulated: false,
        model: null,
        startedAt: null,
        finishedAt: null,
      };
    }
    const status = String(row[4]);
    const reason = row[5] ? String(row[5]) : null;
    return {
      index: i + 1,
      harness: String(row[3] ?? p.harness),
      agentId: row[1] ? String(row[1]) : null,
      agentName: row[2] ? String(row[2]) : null,
      taskId: String(row[0]),
      status: (["completed", "failed", "cancelled"].includes(status) ? status : "pending") as Attempt["status"],
      reason,
      providerError: !!reason && PROVIDER_ERROR_RE.test(reason),
      simulated: !!reason && /simulated provider outage/i.test(reason) && simulate === String(row[3] ?? p.harness),
      model: row[7] ? String(row[7]) : null,
      startedAt: row[8] ? String(row[8]) : null,
      finishedAt: row[9] ? String(row[9]) : null,
    };
  });
  const winner = attempts.find((x) => x.status === "completed") ?? null;
  const winnerRow = winner ? rows.find((r) => r[0] === winner.taskId) : null;
  const output = winnerRow ? parseJsonOutput(winnerRow[6]) : null;
  return {
    ok: !!winner && !!output,
    step: String(a.step ?? ""),
    output,
    outputText: winnerRow && !output ? String(winnerRow[6] ?? "").slice(0, 4000) : null,
    handledBy: winner
      ? { harness: winner.harness, agentId: winner.agentId, agentName: winner.agentName, model: winner.model, taskId: winner.taskId }
      : null,
    failedOver: attempts.some((x) => x.status === "failed" || x.status === "cancelled"),
    attempts,
    finishedAt: winner?.finishedAt ?? null,
  };
}

// ─── findings ────────────────────────────────────────────────

async function findings(ctx: ScriptContext, a: Record<string, any>) {
  const inv = asObj(a.investigate);
  const result = asObj(inv?.outputs?.pick?.result) ?? inv;
  if (!result?.ok) return { posted: false, skipped: "no root cause; close reports the failure" };
  const o = result.output ?? {};
  const runId = String(a.runId ?? "");
  const appUrl = String(a.appUrl || "https://app.agent-swarm.dev").replace(/\/+$/, "");

  // The approval node runs in parallel; wait for its request row (bounded).
  let requestId: string | null = null;
  for (let i = 0; i < 20 && !requestId; i++) {
    const rows = await q(ctx, "SELECT id FROM approval_requests WHERE workflowRunId = ? ORDER BY createdAt DESC LIMIT 1", [runId]);
    requestId = rows[0]?.[0] ? String(rows[0][0]) : null;
    if (!requestId) await new Promise((r) => setTimeout(r, 1000));
  }
  const approvalUrl = requestId ? `${appUrl}/approval-requests/${requestId}` : `${appUrl}/approval-requests`;
  const evidence = (Array.isArray(o.evidence) ? o.evidence : [])
    .slice(0, 5)
    .map((e: unknown) => `• ${typeof e === "string" ? e : JSON.stringify(e)}`)
    .join("\n");
  const conf = typeof o.confidence === "number" ? ` · confidence ${Math.round(o.confidence * 100)}%` : "";
  const text = [
    `🔎 *Root cause found* (${o.severity ?? "sev?"}${conf})`,
    `*Summary:* ${o.summary ?? "n/a"}`,
    `*Root cause:* ${o.rootCause ?? "n/a"}`,
    evidence ? `*Evidence:*\n${evidence}` : null,
    `*Proposed fix:* ${o.proposedFix ?? "n/a"}`,
    `_Investigated by ${describeStep(result)}._`,
    `👉 *Approve or reject the fix PR:* <${approvalUrl}|Review & respond> (one click)`,
  ]
    .filter(Boolean)
    .join("\n");
  const res = await post(ctx, a.channelId ?? null, text, a.threadTs ?? null);
  return { ...res, approvalUrl, requestId };
}

// ─── close ───────────────────────────────────────────────────

function stepResult(v: unknown) {
  const o = asObj(v);
  return (asObj(o?.outputs?.pick?.result) ?? null) as Record<string, any> | null;
}

async function close(ctx: ScriptContext, a: Record<string, any>) {
  const inv = stepResult(a.investigate);
  const fix = stepResult(a.fix);
  const approval = asObj(a.approval);
  const alertAt = Date.parse(String(a.alertAt ?? a.startedAt ?? ""));
  const rootCauseAt = inv?.finishedAt ? Date.parse(inv.finishedAt) : NaN;
  const ttrc = Number.isFinite(alertAt) && Number.isFinite(rootCauseAt) ? rootCauseAt - alertAt : null;
  const prUrl: string | null = fix?.output?.prUrl ?? null;
  const prAt = fix?.finishedAt ? Date.parse(fix.finishedAt) : NaN;
  const ttpr = Number.isFinite(alertAt) && Number.isFinite(prAt) ? prAt - alertAt : null;

  let outcome: "resolved" | "handed_off" | "investigation_failed" | "fix_failed";
  if (!inv?.ok) outcome = "investigation_failed";
  else if (approval && approval.status && approval.status !== "approved") outcome = "handed_off";
  else if (fix?.ok && prUrl) outcome = "resolved";
  else outcome = fix ? "fix_failed" : "handed_off";

  const providers = {
    investigate: inv ? { handledBy: inv.handledBy, failedOver: inv.failedOver, attempts: inv.attempts } : null,
    fix: fix ? { handledBy: fix.handledBy, failedOver: fix.failedOver, attempts: fix.attempts } : null,
  };
  const lines: string[] = [];
  if (outcome === "resolved") {
    lines.push(`✅ *Resolved.* Fix PR: ${prUrl}`);
    if (fix?.output?.summary) lines.push(`*Change:* ${fix.output.summary}`);
  } else if (outcome === "handed_off") {
    lines.push(
      `✋ *Fix ${approval?.status === "timeout" ? "approval timed out" : "rejected"}.* A human takes over from here. Findings stay above.`,
    );
  } else if (outcome === "investigation_failed") {
    lines.push("🛑 *Every provider failed to investigate.* A human needs to take over.");
  } else {
    lines.push("🛑 *Every provider failed to open the fix PR.* A human needs to take over. Findings stay above.");
  }
  lines.push(`*Time to root cause:* ${fmtDuration(ttrc)}${ttpr != null && outcome === "resolved" ? ` · *time to PR:* ${fmtDuration(ttpr)}` : ""}`);
  lines.push(`*Providers:* investigate → ${describeStep(inv)}${fix ? ` · fix → ${describeStep(fix)}` : ""}`);
  lines.push("_Open Oncall · sleep better without relying on a single provider._");
  const slack = await post(ctx, a.channelId ?? null, lines.join("\n"), a.threadTs ?? null);

  return {
    outcome,
    repo: a.repo ?? null,
    alertText: a.alertText ?? null,
    channelId: a.channelId ?? null,
    threadTs: a.threadTs ?? null,
    alertAt: Number.isFinite(alertAt) ? new Date(alertAt).toISOString() : null,
    timeToRootCauseMs: ttrc,
    timeToRootCause: fmtDuration(ttrc),
    timeToPrMs: outcome === "resolved" ? ttpr : null,
    prUrl,
    findings: inv?.output ?? null,
    approval: approval ? { status: approval.status ?? null, requestId: approval.requestId ?? null } : null,
    providers,
    simulateProviderDown: a.simulateProviderDown || null,
    slack,
  };
}

export default async function (args: unknown, ctx: ScriptContext) {
  const a = (args ?? {}) as Record<string, any>;
  switch (a.op) {
    case "intake":
      return intake(ctx, a);
    case "pick":
      return pick(ctx, a);
    case "findings":
      return findings(ctx, a);
    case "close":
      return close(ctx, a);
    default:
      throw new Error(`open-oncall: unknown op ${String(a.op)}`);
  }
}


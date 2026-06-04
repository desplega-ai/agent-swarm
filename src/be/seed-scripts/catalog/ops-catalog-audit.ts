import { z } from "zod";

export const argsSchema = z.object({
  nowIso: z.string().optional().describe("Audit clock override (default: current time)"),
  publishPage: z.boolean().optional().describe("Publish an authed HTML page (default true)"),
  includeSamples: z
    .boolean()
    .optional()
    .describe("Include small row samples for each finding cluster (default true)"),
  staleScheduleDays: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Flag enabled schedules with no run for this many days (default 14)"),
  tempScheduleNames: z
    .array(z.string())
    .optional()
    .describe("Known temporary schedule name fragments that should self-lift"),
});

const CODE_WORK_RE =
  /\b(git|github|gh\b|gh-cli|docker|docker-compose|bun|npm|pnpm|yarn|tsc|eslint|lint|test|pr\b|pull request|branch|commit|repo|worktree|typescript|javascript)\b/i;
const CODE_AGENT_RE =
  /\b(code|coder|coding|implement|implementation|engineer|software|typescript|javascript|repo|github|picateclas)\b/i;
const NON_CODE_AGENT_RE = /\b(content|reviewer|research|sales|gtm|support|ops|lead)\b/i;
const SMOKE_WORKFLOW_RE =
  /\b(smoke|demo|litmus-smoke|one[- ]shot|validation|des-462-gate-validation|gsc-runtime-smoke)\b/i;
const GATE_WORKFLOW_RE = /\b(litmus|gate|eval|review|validation|quality|structured)\b/i;
const STALE_URL_RE =
  /\b(localhost|127\.0\.0\.1|api\.example-swarm\.dev|app\.example-swarm\.dev|example-swarm\.dev|fly\.dev)\b/i;
const CONTRADICTORY_RE =
  /\b(do not|don't|never)\b[\s\S]{0,240}\b(always|must|required)\b|\b(always|must|required)\b[\s\S]{0,240}\b(do not|don't|never)\b/i;

const CODE_REGISTRY_EVENTS =
  "agentmail.email.followup agentmail.email.mapped_lead agentmail.email.mapped_worker agentmail.email.no_agent agentmail.email.unmapped common.command_suggestions.github_comment_issue common.command_suggestions.github_comment_pr common.command_suggestions.github_issue common.command_suggestions.github_pr common.command_suggestions.gitlab_issue common.command_suggestions.gitlab_mr common.delegation_instruction common.delegation_instruction.gitlab github.check_run.failed github.check_suite.failed github.comment.mentioned github.issue.assigned github.issue.labeled github.issue.mentioned github.pull_request.assigned github.pull_request.closed github.pull_request.labeled github.pull_request.mentioned github.pull_request.review_requested github.pull_request.review_submitted github.pull_request.synchronize github.workflow_run.failed gitlab.comment.mentioned gitlab.issue.assigned gitlab.merge_request.opened gitlab.pipeline.failed heartbeat.boot-triage heartbeat.checklist jira.issue.assigned jira.issue.commented jira.issue.followup kapso.message.received linear.issue.assigned linear.issue.followup linear.issue.reassigned slack.assistant.greeting slack.assistant.offline slack.assistant.suggested_prompts slack.message.thread_context system.agent.agent_fs system.agent.artifacts system.agent.code_quality system.agent.context_mode system.agent.filesystem system.agent.lead system.agent.register system.agent.role system.agent.seed_scripts system.agent.self_awareness system.agent.services system.agent.share_urls system.agent.slack system.agent.system system.agent.worker system.agent.worker.remote system.agent.worker.slack system.session.lead system.session.worker system.session.worker.pi system.session.worker.remote task.budget.refused task.requester.profile task.worker.completed task.worker.failed".split(
    " ",
  );

function rowsToObjects(res: any): any[] {
  const p = res?.data ?? res;
  const cols: string[] = p?.columns ?? [];
  return (p?.rows ?? []).map((r: any) =>
    Array.isArray(r) ? Object.fromEntries(cols.map((c, i) => [c, r[i]])) : r,
  );
}

async function query(ctx: any, sql: string, params?: unknown[]): Promise<any[]> {
  try {
    return rowsToObjects(await ctx.swarm.db_query({ sql, params }));
  } catch (error) {
    return [{ unavailable: error instanceof Error ? error.message : String(error) }];
  }
}

function safeJson(value: unknown, fallback: any = null): any {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
}

function compactText(value: unknown, max = 180): string {
  return asText(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function daysSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round((nowMs - t) / 86400000);
}

function severity(rank: number): "critical" | "high" | "medium" | "low" {
  if (rank >= 4) return "critical";
  if (rank === 3) return "high";
  if (rank === 2) return "medium";
  return "low";
}

function sample<T>(rows: T[], includeSamples: boolean, limit = 5): T[] {
  return includeSamples ? rows.slice(0, limit) : [];
}

function isCodeCapable(agent: any): boolean {
  if (!agent) return false;
  const text = [
    agent.name,
    agent.role,
    agent.description,
    Array.isArray(agent.capabilities) ? agent.capabilities.join(" ") : agent.capabilities,
  ]
    .filter(Boolean)
    .join(" ");
  if (!CODE_AGENT_RE.test(text)) return false;
  if (NON_CODE_AGENT_RE.test(text) && !/\bpicateclas\b/i.test(text)) return false;
  return true;
}

function nodeList(definition: any): any[] {
  return Array.isArray(definition?.nodes) ? definition.nodes : [];
}

function hasStructuredOutput(value: any): boolean {
  return /"outputSchema"|"schema"|"jsonSchema"|"structured"/i.test(JSON.stringify(value ?? {}));
}

function htmlEscape(value: unknown): string {
  return asText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function humanLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatMetric(value: unknown): string {
  if (typeof value === "number") return new Intl.NumberFormat("en-US").format(value);
  return asText(value);
}

function severityTone(value: string): string {
  if (value === "critical") return "danger";
  if (value === "high") return "warn";
  if (value === "medium") return "note";
  return "low";
}

function renderSampleValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "object" && item !== null ? JSON.stringify(item) : asText(item)))
      .join(", ");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return asText(value);
}

function renderSamples(samples: any[]): string {
  if (!Array.isArray(samples) || samples.length === 0) return "";
  const normalized = samples.map((sampleRow) =>
    sampleRow && typeof sampleRow === "object" && !Array.isArray(sampleRow)
      ? sampleRow
      : { value: sampleRow },
  );
  const columns = Array.from(
    new Set(normalized.flatMap((sampleRow) => Object.keys(sampleRow).slice(0, 6))),
  ).slice(0, 6);
  if (columns.length === 0) return "";
  const rows = normalized
    .map(
      (sampleRow) =>
        `<tr>${columns
          .map((column) => `<td>${htmlEscape(renderSampleValue(sampleRow[column]))}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="sample-table" aria-label="Sample rows">
    <table>
      <thead><tr>${columns.map((column) => `<th>${htmlEscape(humanLabel(column))}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

export function renderPage(result: any): string {
  const metrics = [
    ["Findings", result.summary.findingsTotal],
    ["Schedules enabled", result.summary.schedulesEnabled],
    ["Workflows enabled", result.summary.workflowsEnabled],
    ["Prompt templates", result.summary.promptTemplates],
  ];
  const sections = ["schedules", "workflows", "promptsTemplates"]
    .map((key) => {
      const group = result.goals[key];
      const findings = group.findings
        .map(
          (finding: any) => `<article class="finding ${htmlEscape(severityTone(finding.severity))}">
            <div class="finding-head">
              <div>
                <p class="finding-id">${htmlEscape(finding.id)}</p>
                <h3>${htmlEscape(finding.summary)}</h3>
              </div>
              <span class="pill ${htmlEscape(severityTone(finding.severity))}">${htmlEscape(
                finding.severity,
              )}</span>
            </div>
            <p class="action">${htmlEscape(finding.action)}</p>
            ${renderSamples(finding.samples)}
          </article>`,
        )
        .join("");
      const checks = Object.entries(group.checks || {})
        .map(
          ([label, value]) =>
            `<div class="check"><span>${htmlEscape(humanLabel(label))}</span><strong>${htmlEscape(
              formatMetric(value),
            )}</strong></div>`,
        )
        .join("");
      return `<section class="section">
        <div class="section-grid">
          <aside class="checks">
            <p class="section-kicker">${htmlEscape(humanLabel(key))}</p>
            <div class="check-list">${checks}</div>
          </aside>
          <div>
            <div class="section-head">
              <h2>${htmlEscape(group.goal)}</h2>
              <span>${htmlEscape(formatMetric(group.findingCount))} finding(s)</span>
            </div>
            <div class="findings">
              ${findings || '<p class="empty">No actionable findings in this cluster.</p>'}
            </div>
          </div>
        </div>
      </section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f5f2ea">
  <title>Ops Catalog Audit</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f2ea;
      --panel: #ffffff;
      --ink: #18181b;
      --muted: #5f6368;
      --line: #ded8cb;
      --accent: #255c99;
      --danger: #b42318;
      --danger-bg: #fff1f0;
      --warn: #b54708;
      --warn-bg: #fff7ed;
      --note: #175cd3;
      --note-bg: #eff6ff;
      --low: #067647;
      --low-bg: #ecfdf3;
      --radius: 8px;
      --shadow: 0 1px 2px rgba(24, 24, 27, 0.06), 0 14px 36px rgba(24, 24, 27, 0.07);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 16px;
      line-height: 1.55;
    }
    main {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
      padding: 48px 0 72px;
    }
    header { margin-bottom: 28px; }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 750;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      max-width: 860px;
      font-size: clamp(2rem, 4vw, 3rem);
      line-height: 1.05;
      letter-spacing: 0;
    }
    .lede {
      max-width: 780px;
      margin: 16px 0 0;
      color: var(--muted);
      font-size: 18px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 32px 0;
    }
    .metric, .section, details {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    .metric { padding: 18px; }
    .metric strong {
      display: block;
      font-size: 32px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .metric span {
      display: block;
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    .section {
      margin-top: 18px;
      padding: 24px;
    }
    .section-grid {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      gap: 28px;
    }
    .section-kicker {
      margin: 0 0 12px;
      color: var(--accent);
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .check-list {
      display: grid;
      gap: 8px;
    }
    .check {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid var(--line);
    }
    .check span {
      color: var(--muted);
      font-size: 13px;
    }
    .check strong {
      font-size: 18px;
      font-variant-numeric: tabular-nums;
    }
    .section-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }
    .section-head h2 {
      max-width: 680px;
      margin: 0;
      font-size: 24px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    .section-head > span {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
    }
    .findings {
      display: grid;
      gap: 12px;
    }
    .finding {
      border: 1px solid var(--line);
      border-left: 4px solid var(--note);
      border-radius: var(--radius);
      padding: 16px;
      background: #fffdf8;
    }
    .finding.danger { border-left-color: var(--danger); }
    .finding.warn { border-left-color: var(--warn); }
    .finding.low { border-left-color: var(--low); }
    .finding-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
    }
    .finding-id {
      margin: 0 0 4px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    h3 {
      margin: 0;
      font-size: 17px;
      line-height: 1.3;
      letter-spacing: 0;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 4px 9px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .pill.danger { background: var(--danger-bg); color: var(--danger); }
    .pill.warn { background: var(--warn-bg); color: var(--warn); }
    .pill.note { background: var(--note-bg); color: var(--note); }
    .pill.low { background: var(--low-bg); color: var(--low); }
    .action {
      margin: 10px 0 0;
      color: var(--muted);
    }
    .sample-table {
      margin-top: 14px;
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--panel);
    }
    table {
      width: 100%;
      min-width: 640px;
      border-collapse: collapse;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    td {
      max-width: 360px;
      color: #27272a;
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    tr:last-child td { border-bottom: 0; }
    .empty {
      margin: 0;
      color: var(--muted);
    }
    details {
      margin-top: 24px;
      padding: 18px;
    }
    summary {
      cursor: pointer;
      font-weight: 800;
    }
    pre {
      margin: 16px 0 0;
      max-height: 560px;
      overflow: auto;
      padding: 16px;
      border-radius: var(--radius);
      background: #111827;
      color: #f9fafb;
      font-size: 12px;
      line-height: 1.45;
    }
    @media (max-width: 860px) {
      main { width: min(100% - 24px, 1120px); padding-top: 32px; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .section-grid { grid-template-columns: 1fr; gap: 18px; }
      .section { padding: 18px; }
      .section-head { display: block; }
      .section-head > span { display: block; margin-top: 8px; }
    }
    @media (max-width: 520px) {
      .metrics { grid-template-columns: 1fr; }
      .lede { font-size: 16px; }
      .finding-head { display: block; }
      .pill { margin-top: 10px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Generated ${htmlEscape(result.generatedAt)}</p>
      <h1>Ops Catalog Audit</h1>
      <p class="lede">A re-runnable audit of schedules, workflows, and prompt/template catalogs. It found ${htmlEscape(
        formatMetric(result.summary.findingsTotal),
      )} actionable issue cluster(s), with the highest-risk items called out first inside each group.</p>
    </header>
    <section class="metrics" aria-label="Audit summary">
      ${metrics
        .map(
          ([label, value]) =>
            `<div class="metric"><strong>${htmlEscape(formatMetric(value))}</strong><span>${htmlEscape(
              label,
            )}</span></div>`,
        )
        .join("")}
    </section>
    ${sections}
    <details>
      <summary>Compressed JSON appendix</summary>
      <pre>${htmlEscape(JSON.stringify(result, null, 2))}</pre>
    </details>
  </main>
</body>
</html>`;
}

async function publishAuditPage(result: any, ctx: any): Promise<any> {
  const redacted = ctx.stdlib?.Redacted;
  const value = (v: any) => (redacted?.value ? redacted.value(v) : String(v));
  const response = await ctx.stdlib.fetch(`${value(ctx.swarm.config.mcpBaseUrl)}/api/pages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${value(ctx.swarm.config.apiKey)}`,
      "Content-Type": "application/json",
      "X-Agent-ID": value(ctx.swarm.config.agentId),
    },
    body: JSON.stringify({
      title: "Ops Catalog Audit",
      slug: "ops-catalog-audit",
      description: "Clustered audit-as-code report for schedules, workflows, and prompts/templates.",
      contentType: "text/html",
      authMode: "authed",
      body: renderPage(result),
    }),
  });
  const body = await response.json().catch(async () => ({ error: await response.text() }));
  if (!response.ok) return { error: body?.error || `page create failed: ${response.status}` };
  return {
    id: body?.id ?? null,
    appUrl: body?.app_url ?? null,
    apiUrl: body?.api_url ?? null,
    version: body?.version ?? null,
  };
}

/** Audit schedules, workflows, and prompt/template catalogs by goal, with optional authed page output. */
export default async function opsCatalogAudit(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args || {});
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };

  const now = parsed.data.nowIso ? new Date(parsed.data.nowIso) : new Date();
  const nowMs = now.getTime();
  const publishPage = parsed.data.publishPage !== false;
  const includeSamples = parsed.data.includeSamples !== false;
  const staleScheduleDays = parsed.data.staleScheduleDays || 14;
  const tempScheduleNames = parsed.data.tempScheduleNames || [
    "memory-gate-597",
    "swarm-postdeploy-memory",
  ];

  const scheduleRows = await query(
    ctx,
    `SELECT s.*, a.name as targetAgentName, a.role as targetAgentRole,
            a.description as targetAgentDescription, a.capabilities as targetAgentCapabilities,
            a.provider as targetAgentProvider, a.harness_provider as targetAgentHarnessProvider
     FROM scheduled_tasks s LEFT JOIN agents a ON a.id = s.targetAgentId
     WHERE s.enabled = 1 ORDER BY s.name ASC`,
  );
  const schedules = scheduleRows.filter((r) => !r.unavailable);
  const agentsById = new Map<string, any>();
  for (const s of schedules) {
    if (!s.targetAgentId) continue;
    agentsById.set(s.targetAgentId, {
      id: s.targetAgentId,
      name: s.targetAgentName,
      role: s.targetAgentRole,
      description: s.targetAgentDescription,
      capabilities: safeJson(s.targetAgentCapabilities, []),
      provider: s.targetAgentProvider,
      harnessProvider: s.targetAgentHarnessProvider,
    });
  }

  const duplicateCronGroups = Object.values(
    schedules.reduce((acc: any, s: any) => {
      const cron = s.cronExpression || (s.intervalMs ? `interval:${s.intervalMs}` : "");
      if (!cron) return acc;
      const key = `${cron}::${s.timezone || "UTC"}`;
      acc[key] ??= { key, cron, timezone: s.timezone || "UTC", schedules: [] };
      acc[key].schedules.push({ id: s.id, name: s.name });
      return acc;
    }, {}),
  ).filter((g: any) => g.schedules.length > 1);

  const deadSchedules = schedules.filter((s: any) => {
    const noNext = !s.nextRunAt && s.scheduleType === "recurring";
    const stale = (daysSince(s.lastRunAt, nowMs) ?? 0) >= staleScheduleDays;
    return noNext || stale || Number(s.consecutiveErrors || 0) > 0;
  });

  const tempSchedules = schedules.filter((s: any) => {
    const haystack = `${s.name || ""}\n${s.description || ""}\n${s.taskTemplate || ""}`.toLowerCase();
    const known = tempScheduleNames.some((name) => haystack.includes(name.toLowerCase()));
    const dateMatches = [
      ...haystack.matchAll(
        /\b(?:self[- ]lift|remove|disable|until|through|expires?)\D{0,40}(\d{4}-\d{2}-\d{2})/g,
      ),
    ];
    const expired = dateMatches.some((m) => (m[1] ? Date.parse(m[1]) <= nowMs : false));
    return known || expired;
  });

  const routingRisks = schedules
    .filter((s: any) => CODE_WORK_RE.test(`${s.name || ""}\n${s.tags || ""}\n${s.taskTemplate || ""}`))
    .map((s: any) => {
      const target = s.targetAgentId ? agentsById.get(s.targetAgentId) : null;
      const pool = !s.targetAgentId;
      const opencode = target?.provider === "opencode" || target?.harnessProvider === "opencode";
      const risky = pool || !isCodeCapable(target) || opencode;
      return risky
        ? {
            id: s.id,
            name: s.name,
            targetAgentId: s.targetAgentId || null,
            targetAgentName: target?.name || null,
            reason: pool
              ? "pool-targeted code work"
              : opencode
                ? "opencode target for code work"
                : "target is not code-capable",
            action: "Pin this schedule to a code-capable worker targetAgentId before it runs again.",
          }
        : null;
    })
    .filter(Boolean);

  const workflowRows = await query(
    ctx,
    `SELECT id, name, description, enabled, definition, triggers, input, triggerSchema, createdAt, lastUpdatedAt
     FROM workflows ORDER BY name ASC`,
  );
  const workflows = workflowRows.filter((r) => !r.unavailable);
  const enabledWorkflows = workflows.filter((w: any) => asBool(w.enabled));
  const smokeEnabled = enabledWorkflows
    .filter((w: any) => SMOKE_WORKFLOW_RE.test(`${w.name || ""}\n${w.description || ""}`))
    .map((w: any) => ({
      id: w.id,
      name: w.name,
      action: "Disable or delete if this was only a smoke/eval fixture.",
    }));
  const gateCoverageGaps = enabledWorkflows
    .map((w: any) => {
      const definition = safeJson(w.definition, {});
      const text = `${w.name || ""}\n${w.description || ""}\n${JSON.stringify(definition)}`;
      const structured =
        hasStructuredOutput(definition) ||
        hasStructuredOutput(safeJson(w.input, {})) ||
        hasStructuredOutput(safeJson(w.triggerSchema, {}));
      if (!GATE_WORKFLOW_RE.test(text) || structured) return null;
      return {
        id: w.id,
        name: w.name,
        nodeCount: nodeList(definition).length,
        action: "Add outputSchema/schema coverage to litmus/eval/gate nodes so downstream checks are deterministic.",
      };
    })
    .filter(Boolean);
  const workflowTypeRows = enabledWorkflows.map((w: any) => {
    const definition = safeJson(w.definition, {});
    const nodes = nodeList(definition);
    const nodeTypes = Array.from(new Set(nodes.map((n: any) => n.type).filter(Boolean))).sort();
    const loadBearing =
      !SMOKE_WORKFLOW_RE.test(`${w.name || ""}\n${w.description || ""}`) && nodes.length > 1;
    return {
      id: w.id,
      name: w.name,
      nodeCount: nodes.length,
      nodeTypes,
      class: loadBearing ? "load-bearing" : "fixture-or-small",
    };
  });

  const promptRows = await query(
    ctx,
    `SELECT id, eventType, scope, scopeId, state, body, isDefault, version, createdBy, updatedAt
     FROM prompt_templates ORDER BY eventType ASC, scope ASC`,
  );
  const prompts = promptRows.filter((r) => !r.unavailable);
  const expectedEvents = new Set(CODE_REGISTRY_EVENTS);
  const defaultEvents = new Set(prompts.filter((p: any) => asBool(p.isDefault)).map((p: any) => p.eventType));
  const liveEvents = new Set(prompts.map((p: any) => p.eventType));
  const missingDefaultEvents = [...expectedEvents].filter((e) => !defaultEvents.has(e)).sort();
  const dbOnlyEvents = [...liveEvents].filter((e) => !expectedEvents.has(e) && !e.startsWith("test.")).sort();

  const bodyGroups: Record<string, any[]> = {};
  for (const p of prompts) {
    const key = compactText(p.body, 500);
    if (!key) continue;
    bodyGroups[key] ??= [];
    bodyGroups[key].push({
      id: p.id,
      eventType: p.eventType,
      scope: p.scope,
      scopeId: p.scopeId,
    });
  }
  const duplicatePromptBodies = Object.values(bodyGroups).filter((group) => group.length > 1);
  const staleUrlPrompts = prompts
    .filter((p: any) => STALE_URL_RE.test(p.body || ""))
    .map((p: any) => ({
      id: p.id,
      eventType: p.eventType,
      scope: p.scope,
      match: (p.body.match(STALE_URL_RE) || [])[0],
    }));
  const contradictoryPrompts = prompts
    .filter((p: any) => CONTRADICTORY_RE.test(p.body || ""))
    .map((p: any) => ({ id: p.id, eventType: p.eventType, scope: p.scope }));
  const skillDuplicateRows = await query(
    ctx,
    `SELECT name, count(*) as count,
            group_concat(scope || ':' || coalesce(ownerAgentId, 'global'), ', ') as locations
     FROM skills
     WHERE isEnabled = 1 AND systemDefault = 1
     GROUP BY name HAVING count(*) > 1 ORDER BY count DESC, name ASC`,
  );
  const systemDefaultSkillDuplicates = skillDuplicateRows.filter((r) => !r.unavailable);
  const skillDuplicateUnavailable = skillDuplicateRows.find((r) => r.unavailable)?.unavailable;

  const findings = {
    schedules: [
      duplicateCronGroups.length && {
        id: "schedules.duplicate-crons",
        severity: severity(duplicateCronGroups.length > 2 ? 3 : 2),
        summary: `${duplicateCronGroups.length} duplicate enabled cron/interval group(s).`,
        action: "Confirm whether each duplicate group is intentional; consolidate or retarget redundant schedules.",
        samples: sample(duplicateCronGroups, includeSamples),
      },
      deadSchedules.length && {
        id: "schedules.dead-or-stale",
        severity: severity(deadSchedules.length > 3 ? 3 : 2),
        summary: `${deadSchedules.length} enabled schedule(s) look dead, stale, or erroring.`,
        action: `Disable dead schedules or repair nextRunAt/cron/errors. Stale threshold: ${staleScheduleDays} days.`,
        samples: sample(
          deadSchedules.map((s: any) => ({
            id: s.id,
            name: s.name,
            nextRunAt: s.nextRunAt,
            lastRunAt: s.lastRunAt,
            consecutiveErrors: s.consecutiveErrors,
          })),
          includeSamples,
        ),
      },
      tempSchedules.length && {
        id: "schedules.temporary-self-lift",
        severity: "high",
        summary: `${tempSchedules.length} temporary monitor schedule(s) may be past self-lift.`,
        action: "Review the named temporary monitors and disable/delete the ones whose guard window has expired.",
        samples: sample(
          tempSchedules.map((s: any) => ({ id: s.id, name: s.name })),
          includeSamples,
        ),
      },
      routingRisks.length && {
        id: "schedules.rule-13-15-routing",
        severity: "critical",
        summary: `${routingRisks.length} enabled code-work schedule(s) are not pinned to a code-capable worker.`,
        action: "Set targetAgentId to a code-capable worker; never leave git/docker/bun/gh work on the pool.",
        samples: sample(routingRisks, includeSamples),
      },
    ].filter(Boolean),
    workflows: [
      smokeEnabled.length && {
        id: "workflows.enabled-fixtures",
        severity: severity(smokeEnabled.length > 2 ? 3 : 2),
        summary: `${smokeEnabled.length} enabled workflow(s) look like smoke/demo/one-shot fixtures.`,
        action: "Disable fixture workflows unless they are explicitly load-bearing production gates.",
        samples: sample(smokeEnabled, includeSamples),
      },
      gateCoverageGaps.length && {
        id: "workflows.structured-output-gaps",
        severity: "high",
        summary: `${gateCoverageGaps.length} litmus/eval/gate workflow(s) lack visible structured-output schema coverage.`,
        action: "Add outputSchema/schema coverage so gate outputs can be regression-checked.",
        samples: sample(gateCoverageGaps, includeSamples),
      },
    ].filter(Boolean),
    promptsTemplates: [
      (missingDefaultEvents.length || dbOnlyEvents.length) && {
        id: "prompts.registry-drift",
        severity: severity(missingDefaultEvents.length > 0 ? 3 : 2),
        summary: `${missingDefaultEvents.length} code registry event(s) missing default DB rows; ${dbOnlyEvents.length} DB event(s) absent from code registry.`,
        action: "Re-seed prompt templates or remove stale DB-only templates after confirming no runtime still emits them.",
        samples: sample(
          [
            ...missingDefaultEvents.slice(0, 5).map((eventType) => ({
              kind: "missing-default",
              eventType,
            })),
            ...dbOnlyEvents.slice(0, 5).map((eventType) => ({ kind: "db-only", eventType })),
          ],
          includeSamples,
          10,
        ),
      },
      duplicatePromptBodies.length && {
        id: "prompts.redundant-bodies",
        severity: "medium",
        summary: `${duplicatePromptBodies.length} prompt body group(s) are duplicated across templates.`,
        action: "Extract shared text into a template reference or remove redundant overrides.",
        samples: sample(duplicatePromptBodies, includeSamples, 3),
      },
      staleUrlPrompts.length && {
        id: "prompts.stale-urls-hosts",
        severity: "high",
        summary: `${staleUrlPrompts.length} prompt template(s) contain stale/local/example hosts.`,
        action: "Replace hardcoded hosts with runtime env-var guidance or current public hosts.",
        samples: sample(staleUrlPrompts, includeSamples),
      },
      contradictoryPrompts.length && {
        id: "prompts.contradictory-instructions",
        severity: "medium",
        summary: `${contradictoryPrompts.length} prompt template(s) contain nearby must/never style conflicts worth review.`,
        action: "Tighten redundant or conflicting instruction blocks so workers do not receive mixed routing guidance.",
        samples: sample(contradictoryPrompts, includeSamples),
      },
      (systemDefaultSkillDuplicates.length || skillDuplicateUnavailable) && {
        id: "prompts.system-default-skill-duplicates",
        severity: systemDefaultSkillDuplicates.length ? "high" : "low",
        summary: skillDuplicateUnavailable
          ? `Could not query systemDefault skill duplicates: ${skillDuplicateUnavailable}`
          : `${systemDefaultSkillDuplicates.length} systemDefault skill name(s) are duplicated.`,
        action: "Deduplicate system-default skills so prompt skill seeding is stable and non-redundant.",
        samples: sample(systemDefaultSkillDuplicates, includeSamples),
      },
    ].filter(Boolean),
  };

  const result: any = {
    generatedAt: now.toISOString(),
    script: "ops-catalog-audit",
    summary: {
      schedulesEnabled: schedules.length,
      workflowsTotal: workflows.length,
      workflowsEnabled: enabledWorkflows.length,
      promptTemplates: prompts.length,
      findingsTotal:
        findings.schedules.length + findings.workflows.length + findings.promptsTemplates.length,
    },
    goals: {
      schedules: {
        goal: "Reduce schedule cost/context waste and prevent misrouted code work.",
        findingCount: findings.schedules.length,
        checks: {
          duplicateCronGroups: duplicateCronGroups.length,
          deadOrStaleSchedules: deadSchedules.length,
          temporarySelfLiftSchedules: tempSchedules.length,
          routingRisks: routingRisks.length,
        },
        findings: findings.schedules,
      },
      workflows: {
        goal: "Separate load-bearing workflows from fixtures and enforce deterministic gate outputs.",
        findingCount: findings.workflows.length,
        checks: {
          enabledFixtures: smokeEnabled.length,
          structuredOutputGaps: gateCoverageGaps.length,
          loadBearingCount: workflowTypeRows.filter((w) => w.class === "load-bearing").length,
          fixtureOrSmallCount: workflowTypeRows.filter((w) => w.class === "fixture-or-small").length,
        },
        workflowClasses: sample(workflowTypeRows, includeSamples, 20),
        findings: findings.workflows,
      },
      promptsTemplates: {
        goal: "Keep prompt registry, runtime defaults, host guidance, and skill seed blocks aligned.",
        findingCount: findings.promptsTemplates.length,
        checks: {
          codeRegistryEvents: CODE_REGISTRY_EVENTS.length,
          dbOnlyEvents: dbOnlyEvents.length,
          missingDefaultEvents: missingDefaultEvents.length,
          duplicatePromptBodyGroups: duplicatePromptBodies.length,
          staleUrlPrompts: staleUrlPrompts.length,
          contradictoryPrompts: contradictoryPrompts.length,
          systemDefaultSkillDuplicates: systemDefaultSkillDuplicates.length,
        },
        findings: findings.promptsTemplates,
      },
    },
  };

  if (publishPage) result.page = await publishAuditPage(result, ctx);
  return result;
}

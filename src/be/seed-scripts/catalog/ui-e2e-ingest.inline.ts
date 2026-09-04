import { z } from "zod";
import {
  agentFsViewerUrl,
  APP_DEFINITION,
  APP_NAME,
  artifactKeyFor,
  aggregateShards,
  configNumber,
  configString,
  CONFIG_DEFAULTS,
  createRow,
  dateOrNull,
  DEFAULT_AGENT_FS_LIVE_HOST,
  failureFingerprint,
  findingKeyFor,
  groupKeyFor,
  incidentKeyFor,
  KV_NAMESPACE,
  listRows,
  MAX_ERROR_CHARS,
  opensIncidents,
  PAGE_SLUG,
  patchRow,
  PROMOTE_WORKFLOW_NAME,
  renderTrackerPage,
  resultKeyFor,
  runKeyFor,
  swarmHttp,
  tallyResults,
  targetFor,
  TRIAGE_WORKFLOW_NAME,
  unwrapId,
  unwrapList,
  upsertRow,
  utcDay,
} from "./ui-e2e-core";

const RunSchema = z.object({
  repo: z.string().min(3).describe("Repository in 'owner/name' form"),
  ref: z.string().min(1).describe("Git ref, e.g. refs/heads/main"),
  sha: z.string().min(7).describe("Head commit SHA"),
  prNumber: z.number().int().positive().nullable().describe("PR number, or null"),
  isFork: z.boolean().describe("True when the head repo is a fork"),
  trigger: z.enum(["pr", "main", "nightly", "manual"]).describe("What produced this run"),
  runner: z.enum(["ci", "swarm-worker", "sandbox"]).describe("Who executed it"),
  shardIndex: z.number().int().positive().describe("1-based shard index"),
  shardTotal: z.number().int().positive().describe("Total shards in this run"),
  startedAt: z.string().min(1).describe("ISO-8601 start"),
  finishedAt: z.string().min(1).describe("ISO-8601 finish"),
  ciUrl: z.string().optional().describe("Link back to the CI run"),
});

const ResultSchema = z.object({
  specId: z.string().min(1).describe("Stable id: '<spec file path>:<full test title>'"),
  title: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped", "flaky"]),
  durationMs: z.number().nonnegative(),
  retries: z.number().int().nonnegative(),
  error: z.string().optional().describe("Required when status is failed"),
});

const ArtifactSchema = z.object({
  kind: z.enum(["screenshot", "trace", "video", "report", "log"]),
  storage: z.enum(["agent-fs", "github"]),
  path: z.string().optional().describe("agent-fs path (storage=agent-fs)"),
  url: z.string().optional().describe("Absolute URL (storage=github)"),
  orgId: z.string().optional(),
  driveId: z.string().optional(),
  specId: z.string().nullable().optional(),
  sizeBytes: z.number().nonnegative().optional(),
});

const FindingSchema = z.object({
  title: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  steps: z.string().min(1).describe("Steps to reproduce"),
  evidence: z.array(z.string()).describe("Artifact paths or urls backing the finding"),
  suspectedArea: z.string().min(1),
});

export const argsSchema = z.object({
  schemaVersion: z.literal(1).describe("Payload contract version"),
  run: RunSchema,
  results: z.array(ResultSchema).describe("Per-spec results for THIS shard"),
  artifacts: z.array(ArtifactSchema).optional(),
  findings: z.array(FindingSchema).optional().describe("Exploratory findings (swarm runner)"),
  cost: z
    .object({ model: z.string().optional(), tokens: z.number().optional(), usd: z.number().optional() })
    .optional(),
  regeneratePage: z.boolean().optional().describe("Regenerate the public page (default true)"),
  mode: z
    .enum(["ingest", "annotate"])
    .optional()
    .describe("'annotate' writes triage results back onto an incident instead of ingesting a run"),
  annotate: z
    .object({
      incidentKey: z.string().optional(),
      findingKey: z.string().optional(),
      classification: z.enum(["unknown", "app-bug", "flaky-spec", "infra"]).optional(),
      triageTaskId: z.string().optional(),
      promoteTaskId: z.string().optional(),
      fixPr: z.string().optional(),
      linearIssue: z.string().optional(),
      findingStatus: z.enum(["open", "dispatched", "deferred", "promoted", "dismissed"]).optional(),
    })
    .optional(),
});

/** Look the app up by name, create it on first ingest. Cached in KV. */
async function ensureApp(ctx: any): Promise<string> {
  const cached: any = await ctx.swarm.kv_getOrNull({ namespace: KV_NAMESPACE, key: "appId" });
  const cachedId = cached?.data?.value ?? cached?.value;
  if (typeof cachedId === "string" && cachedId.length > 0) return cachedId;

  const apps = unwrapList(await ctx.swarm.app_list({}), "apps");
  const found = apps.find((a: any) => a?.name === APP_NAME);
  let appId: string | null = typeof found?.id === "string" ? found.id : null;

  if (!appId) {
    const created: any = await ctx.swarm.app_upsert({
      name: APP_NAME,
      description:
        "UI E2E tracker — Playwright and swarm-exploratory run results, artifacts, findings and failure incidents for apps/ui.",
      definition: APP_DEFINITION,
    });
    appId = unwrapId(created);
  }
  if (!appId) throw new Error("could not resolve or create the uiE2eTracker app");
  await ctx.swarm.kv_set({ namespace: KV_NAMESPACE, key: "appId", value: appId });
  return appId;
}

/**
 * The sweep and prune schedules, created once alongside the app.
 *
 * Bootstrapping them here rather than seeding them keeps the whole tracker
 * self-assembling from a single first ingest: no schedule Seeder kind exists in
 * `src/be/seed/registry.ts`, and an operator who never ingests never needs
 * either schedule.
 */
async function ensureSchedules(ctx: any): Promise<Record<string, string | null>> {
  const cached: any = await ctx.swarm.kv_getOrNull({ namespace: KV_NAMESPACE, key: "schedules" });
  if ((cached?.data?.value ?? cached?.value) === "ensured") return { cached: "ensured" };

  const wanted = [
    {
      name: "ui-e2e-sweep",
      scriptName: "ui-e2e-sweep",
      // Every 15 min: fine-grained enough that a dead shard resolves inside one
      // working session, cheap enough to be free (it reads a filtered row set).
      cronExpression: "*/15 * * * *",
      description: "Mark UI E2E runs whose shards never reported as incomplete; requeue deferred triage.",
    },
    {
      name: "ui-e2e-prune",
      scriptName: "ui-e2e-prune",
      cronExpression: "0 4 * * *",
      description: "Apply the UI E2E tracker's 30-day retention to app rows and agent-fs artifacts.",
    },
  ];

  const existing = unwrapList(await ctx.swarm.schedule_list({}), "schedules");
  const result: Record<string, string | null> = {};
  for (const spec of wanted) {
    const found = existing.find((s: any) => s?.name === spec.name);
    if (found) {
      result[spec.name] = found.id ?? null;
      continue;
    }
    const created: any = await ctx.swarm.schedule_create({
      name: spec.name,
      description: spec.description,
      targetType: "script",
      scriptName: spec.scriptName,
      scriptArgs: {},
      scheduleType: "recurring",
      cronExpression: spec.cronExpression,
      timezone: "UTC",
      enabled: true,
    });
    result[spec.name] = unwrapId(created);
  }
  await ctx.swarm.kv_set({ namespace: KV_NAMESPACE, key: "schedules", value: "ensured" });
  return result;
}

const TRIAGE_PROMPT = `A UI E2E spec is failing on {{trigger}} for {{repo}}.

Spec: {{specId}}
Fingerprint: {{fingerprint}} (seen {{occurrences}}x, latest sha {{sha}})
Error: {{error}}
Artifacts + run: {{runUrl}}
Tracker: {{pageUrl}}

Classify this failure as exactly one of: app-bug | flaky-spec | infra.
- flaky-spec or infra: fix it and open a PR against {{repo}}.
- app-bug: do NOT patch the spec. Open a Linear issue describing the product defect.

Then report the classification and the PR or issue link via your structured output.`;

const PROMOTE_PROMPT = `An exploratory UI E2E session found a reproducible issue on {{repo}} ({{target}}).

Finding: {{title}} (severity {{severity}})
Suspected area: {{suspectedArea}}
Steps to reproduce:
{{steps}}
Evidence: {{evidence}}
Tracker: {{pageUrl}}

Write a deterministic Playwright spec under apps/ui/e2e/ that reproduces this.
Hard constraints: the spec must be plain Playwright. No LLM calls, no qa-use, no
browser-agent, no network calls to any model provider from inside the spec. It
must pass or fail on assertions alone, and must be stable enough to run on every PR.

Open a PR against {{repo}} with just that spec and report its URL.`;

async function ensureWorkflow(
  ctx: any,
  name: string,
  description: string,
  prompt: string,
  required: string[],
  outputSchema: Record<string, unknown> | undefined,
  kvKey: string,
): Promise<string | null> {
  const cached: any = await ctx.swarm.kv_getOrNull({ namespace: KV_NAMESPACE, key: kvKey });
  const cachedId = cached?.data?.value ?? cached?.value;
  if (typeof cachedId === "string" && cachedId.length > 0) return cachedId;

  const workflows = unwrapList(await ctx.swarm.workflow_list({}), "workflows");
  const found = workflows.find((w: any) => w?.name === name);
  let id: string | null = typeof found?.id === "string" ? found.id : null;

  if (!id) {
    const properties: Record<string, unknown> = {};
    for (const key of required) properties[key] = { type: "string" };
    const created: any = await ctx.swarm.workflow_create({
      name,
      description,
      definition: {
        nodes: [
          {
            id: "act",
            type: "agent-task",
            inputs: { t: "trigger" },
            config: {
              template: prompt.replace(/\{\{(\w+)\}\}/g, "{{t.$1}}"),
              tags: ["ui-e2e", name],
              priority: 60,
              ...(outputSchema ? { outputSchema } : {}),
            },
          },
        ],
      },
      // A bare webhook trigger is the documented operator opt-in to an open
      // endpoint; the caller here is the ingest script running server-side.
      triggers: [{ type: "webhook" }],
      triggerSchema: { type: "object", required, properties },
    });
    id = unwrapId(created);
  }
  if (!id) return null;
  await ctx.swarm.kv_set({ namespace: KV_NAMESPACE, key: kvKey, value: id });
  return id;
}

/**
 * Dispatch budget. `kv_incr` is the whole enforcement: it is atomic, so two
 * shards landing at once cannot both read "4 used" and both dispatch.
 */
async function claimDispatch(ctx: any, nowMs: number, cap: number): Promise<boolean> {
  const res: any = await ctx.swarm.kv_incr({
    namespace: KV_NAMESPACE,
    key: `dispatch:${utcDay(nowMs)}`,
    by: 1,
    ttlSeconds: 172800,
  });
  const used = Number(res?.data?.value ?? res?.value ?? 0);
  return Number.isFinite(used) && used <= cap;
}

async function dispatchedToday(ctx: any, nowMs: number): Promise<number> {
  const res: any = await ctx.swarm.kv_getOrNull({
    namespace: KV_NAMESPACE,
    key: `dispatch:${utcDay(nowMs)}`,
  });
  return Number(res?.data?.value ?? res?.value ?? 0) || 0;
}

async function fireWebhook(ctx: any, http: any, workflowId: string, payload: any): Promise<boolean> {
  try {
    const res = await ctx.stdlib.fetch(`${http.base}/api/webhooks/${workflowId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function regeneratePage(
  ctx: any,
  http: any,
  appId: string,
  opts: { perTarget: number; appUrl: string },
): Promise<any> {
  const groups = await listRows(ctx, http, appId, "runGroups", {}, {
    sort: "lastIngestAt:desc",
    limit: 400,
  });
  const byTarget = new Map<string, any[]>();
  for (const g of groups) {
    const list = byTarget.get(g.target) ?? [];
    if (list.length < opts.perTarget) list.push(g);
    byTarget.set(g.target, list);
  }
  const keptGroupKeys = new Set<string>();
  for (const list of byTarget.values()) for (const g of list) keptGroupKeys.add(g.groupKey);

  const artifacts = await listRows(ctx, http, appId, "artifacts", {}, {
    sort: "ingestedAt:desc",
    limit: 1000,
  });
  const artifactsByGroup = new Map<string, any[]>();
  for (const a of artifacts) {
    if (!keptGroupKeys.has(a.groupKey)) continue;
    const list = artifactsByGroup.get(a.groupKey) ?? [];
    if (list.length < 8) list.push(a);
    artifactsByGroup.set(a.groupKey, list);
  }

  const incidents = await listRows(ctx, http, appId, "incidents", { status: "open" }, {
    sort: "lastSeenAt:desc",
    limit: 100,
  });
  const findings = await listRows(ctx, http, appId, "findings", { status: "open" }, {
    sort: "ingestedAt:desc",
    limit: 100,
  });

  // main first, then PR targets, so the page's most-watched row is at the top.
  const targetNames = [...byTarget.keys()].sort((a, b) =>
    a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b),
  );

  const body = renderTrackerPage({
    generatedAt: new Date().toISOString(),
    appUrl: opts.appUrl,
    targets: targetNames.map((target) => ({
      target,
      groups: (byTarget.get(target) ?? []).map((g: any) => ({
        sha: String(g.sha ?? ""),
        trigger: String(g.trigger ?? ""),
        runner: String(g.runner ?? ""),
        status: String(g.status ?? ""),
        durationMs: Number(g.durationMs ?? 0),
        passed: Number(g.passed ?? 0),
        failed: Number(g.failed ?? 0),
        flaky: Number(g.flaky ?? 0),
        shardsReported: Number(g.shardsReported ?? 0),
        shardTotal: Number(g.shardTotal ?? 0),
        lastIngestAt: String(g.lastIngestAt ?? ""),
        artifacts: (artifactsByGroup.get(g.groupKey) ?? []).map((a: any) => ({
          kind: String(a.kind ?? ""),
          storage: String(a.storage ?? ""),
          href: String(a.viewerUrl || a.url || ""),
          label: a.storage === "github" ? `${a.kind} (gh)` : String(a.kind ?? ""),
        })).filter((a: any) => a.href),
      })),
    })),
    incidents: incidents.map((i: any) => ({
      specId: String(i.specId ?? ""),
      occurrences: Number(i.occurrences ?? 0),
      classification: String(i.classification ?? "unknown"),
      lastSeenAt: String(i.lastSeenAt ?? ""),
      lastSeenSha: String(i.lastSeenSha ?? ""),
      triageStatus: String(i.triageStatus ?? ""),
      fixPr: String(i.fixPr ?? ""),
      linearIssue: String(i.linearIssue ?? ""),
    })),
    findings: findings.map((f: any) => ({
      title: String(f.title ?? ""),
      severity: String(f.severity ?? ""),
      suspectedArea: String(f.suspectedArea ?? ""),
      status: String(f.status ?? ""),
      target: String(f.target ?? ""),
    })),
  });

  const res: any = await ctx.swarm.page_create({
    title: "UI E2E tracker",
    slug: PAGE_SLUG,
    description: "Read-only projection of the UI E2E tracker app.",
    contentType: "text/html",
    authMode: "public",
    body,
  });
  const payload = res?.data ?? res;
  return { id: unwrapId(res), url: payload?.app_url ?? payload?.appUrl ?? null };
}

async function handleAnnotate(ctx: any, http: any, appId: string, annotate: any) {
  const touched: string[] = [];
  if (annotate?.incidentKey) {
    const rows = await listRows(ctx, http, appId, "incidents", { incidentKey: annotate.incidentKey }, { limit: 1 });
    if (rows[0]) {
      const values: Record<string, unknown> = {};
      if (annotate.classification) values.classification = annotate.classification;
      if (annotate.triageTaskId) values.triageTaskId = annotate.triageTaskId;
      if (annotate.fixPr) values.fixPr = annotate.fixPr;
      if (annotate.linearIssue) values.linearIssue = annotate.linearIssue;
      if (Object.keys(values).length) {
        await patchRow(ctx, http, appId, "incidents", rows[0].id, values);
        touched.push(annotate.incidentKey);
      }
    }
  }
  if (annotate?.findingKey) {
    const rows = await listRows(ctx, http, appId, "findings", { findingKey: annotate.findingKey }, { limit: 1 });
    if (rows[0]) {
      const values: Record<string, unknown> = {};
      if (annotate.findingStatus) values.status = annotate.findingStatus;
      if (annotate.promoteTaskId) values.promoteTaskId = annotate.promoteTaskId;
      if (Object.keys(values).length) {
        await patchRow(ctx, http, appId, "findings", rows[0].id, values);
        touched.push(annotate.findingKey);
      }
    }
  }
  return { ok: true, mode: "annotate", touched };
}

/** Single ingest point for Playwright CI shards and swarm exploratory runs. */
export default async function uiE2eIngest(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) throw new Error(`invalid payload: ${parsed.error.message}`);
  const payload = parsed.data;

  const http = swarmHttp(ctx);
  const appId = await ensureApp(ctx);
  const schedules = await ensureSchedules(ctx);
  const appUrlBase = http.base.replace(/\/api$/, "");
  const appUrl = `${appUrlBase}/apps/${appId}`;

  if (payload.mode === "annotate") {
    return handleAnnotate(ctx, http, appId, payload.annotate ?? {});
  }

  const run = payload.run;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const target = targetFor(run.prNumber);
  const groupKey = groupKeyFor(run);
  const runKey = runKeyFor(groupKey, run.shardIndex);

  // A fork payload is untrusted CI output relayed by a base-repo job. It never
  // writes agent-fs paths, never opens incidents, never spends the PR budget.
  // `trigger` already excludes it from incidents; this is defense in depth so a
  // mislabelled payload cannot reach those paths at all.
  const forkRejected: string[] = [];
  const incomingArtifacts = (payload.artifacts ?? []).filter((a: any) => {
    if (run.isFork && a.storage === "agent-fs") {
      forkRejected.push(a.path ?? "");
      return false;
    }
    return true;
  });

  const tally = tallyResults(payload.results);
  const shardStatus = tally.failed > 0 ? "failed" : "passed";

  // ── the shard row ────────────────────────────────────────────────────────
  const shardValues: Record<string, unknown> = {
    groupKey,
    repo: run.repo,
    target,
    sha: run.sha,
    trigger: run.trigger,
    runner: run.runner,
    shardIndex: run.shardIndex,
    shardTotal: run.shardTotal,
    status: shardStatus,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) || 0,
    passed: tally.passed,
    failed: tally.failed,
    skipped: tally.skipped,
    flaky: tally.flaky,
    costModel: payload.cost?.model ?? "",
    costTokens: payload.cost?.tokens ?? 0,
    costUsd: payload.cost?.usd ?? 0,
    ciUrl: run.ciUrl ?? "",
    ingestedAt: nowIso,
  };
  const shard = await upsertRow(
    ctx,
    http,
    appId,
    "runs",
    "runKey",
    runKey,
    shardValues,
    // A re-ingest of the same (repo, sha, shard, runner) is a retry, not a new
    // run: bump the attempt counter on the SAME row.
    (existing) => ({ attempt: (Number(existing.attempt) || 1) + 1 }),
  );

  // ── per-spec results ─────────────────────────────────────────────────────
  const failures: Array<{ specId: string; title: string; error: string; fingerprint: string }> = [];
  for (const result of payload.results) {
    const error = (result.error ?? "").slice(0, MAX_ERROR_CHARS);
    const fingerprint = result.status === "failed" ? failureFingerprint(result.specId, error) : "";
    await upsertRow(ctx, http, appId, "results", "resultKey", resultKeyFor(runKey, result.specId), {
      runKey,
      groupKey,
      specId: result.specId,
      title: result.title,
      status: result.status,
      durationMs: result.durationMs,
      retries: result.retries,
      error,
      fingerprint,
      ingestedAt: nowIso,
    });
    if (result.status === "failed") {
      failures.push({ specId: result.specId, title: result.title, error, fingerprint });
    }
  }

  // ── artifacts ────────────────────────────────────────────────────────────
  const liveHost = (await configString(ctx, "AGENT_FS_LIVE_URL")) ?? DEFAULT_AGENT_FS_LIVE_HOST;
  const defaultOrg = await configString(ctx, "UI_E2E_AGENT_FS_ORG_ID");
  const defaultDrive = await configString(ctx, "UI_E2E_AGENT_FS_DRIVE_ID");
  let artifactsWritten = 0;
  for (const artifact of incomingArtifacts) {
    const pathOrUrl = artifact.storage === "agent-fs" ? (artifact.path ?? "") : (artifact.url ?? "");
    if (!pathOrUrl) continue;
    const viewerUrl =
      artifact.storage === "agent-fs"
        ? agentFsViewerUrl(
            liveHost,
            artifact.orgId ?? defaultOrg,
            artifact.driveId ?? defaultDrive,
            artifact.path ?? "",
          )
        : (artifact.url ?? "");
    await upsertRow(
      ctx,
      http,
      appId,
      "artifacts",
      "artifactKey",
      artifactKeyFor(runKey, artifact.kind, pathOrUrl),
      {
        runKey,
        groupKey,
        specId: artifact.specId ?? "",
        kind: artifact.kind,
        storage: artifact.storage,
        path: artifact.path ?? "",
        url: artifact.url ?? "",
        viewerUrl,
        sizeBytes: artifact.sizeBytes ?? 0,
        ingestedAt: nowIso,
      },
    );
    artifactsWritten++;
  }

  // ── aggregate over EVERY shard of this group ─────────────────────────────
  const timeoutMin = await configNumber(
    ctx,
    "UI_E2E_SHARD_TIMEOUT_MIN",
    CONFIG_DEFAULTS.UI_E2E_SHARD_TIMEOUT_MIN,
  );
  const shardRows = await listRows(ctx, http, appId, "runs", { groupKey }, { limit: 100 });
  const aggregate = aggregateShards(shardRows as any, { nowMs, timeoutMin });

  const existingGroups = await listRows(ctx, http, appId, "runGroups", { groupKey }, { limit: 1 });
  const previousStatus = existingGroups[0]?.status ?? "";
  const groupValues: Record<string, unknown> = {
    repo: run.repo,
    target,
    ref: run.ref,
    sha: run.sha,
    prNumber: run.prNumber ?? 0,
    isFork: run.isFork,
    trigger: run.trigger,
    runner: run.runner,
    shardTotal: aggregate.shardTotal,
    shardsReported: aggregate.shardsReported,
    status: aggregate.status,
    startedAt: dateOrNull(aggregate.startedAt),
    finishedAt: dateOrNull(aggregate.finishedAt),
    durationMs: aggregate.durationMs,
    passed: aggregate.passed,
    failed: aggregate.failed,
    skipped: aggregate.skipped,
    flaky: aggregate.flaky,
    costUsd: aggregate.costUsd,
    lastIngestAt: nowIso,
  };
  await upsertRow(ctx, http, appId, "runGroups", "groupKey", groupKey, groupValues);

  // ── findings ─────────────────────────────────────────────────────────────
  const cap = await configNumber(
    ctx,
    "UI_E2E_MAX_PRS_PER_DAY",
    CONFIG_DEFAULTS.UI_E2E_MAX_PRS_PER_DAY,
  );
  const pageUrl = `${appUrlBase}/p/${PAGE_SLUG}`;
  const dispatch = { dispatched: 0, deferred: 0 };
  const findingSummary = { created: 0, dispatched: 0, deferred: 0 };

  const promoteWorkflowId = payload.findings?.length
    ? await ensureWorkflow(
        ctx,
        PROMOTE_WORKFLOW_NAME,
        "Turn an exploratory UI E2E finding into a deterministic Playwright spec and open a PR.",
        PROMOTE_PROMPT,
        ["findingKey", "repo", "title"],
        { type: "object", properties: { prUrl: { type: "string" } } },
        "promoteWorkflowId",
      )
    : null;

  for (const finding of payload.findings ?? []) {
    const findingKey = findingKeyFor(groupKey, finding.title);
    const existing = await listRows(ctx, http, appId, "findings", { findingKey }, { limit: 1 });
    const alreadyDispatched = existing[0]?.status === "dispatched" || existing[0]?.status === "promoted";
    let status = existing[0]?.status ?? "open";

    if (!alreadyDispatched && promoteWorkflowId) {
      if (await claimDispatch(ctx, nowMs, cap)) {
        const fired = await fireWebhook(ctx, http, promoteWorkflowId, {
          findingKey,
          repo: run.repo,
          target,
          title: finding.title,
          severity: finding.severity,
          steps: finding.steps,
          suspectedArea: finding.suspectedArea,
          evidence: finding.evidence.join(", "),
          pageUrl,
        });
        status = fired ? "dispatched" : "open";
        if (fired) {
          dispatch.dispatched++;
          findingSummary.dispatched++;
        }
      } else {
        status = "deferred";
        dispatch.deferred++;
        findingSummary.deferred++;
      }
    }

    const written = await upsertRow(ctx, http, appId, "findings", "findingKey", findingKey, {
      groupKey,
      runKey,
      repo: run.repo,
      target,
      sha: run.sha,
      title: finding.title,
      severity: finding.severity,
      steps: finding.steps,
      suspectedArea: finding.suspectedArea,
      evidence: finding.evidence.join(", "),
      status,
      ingestedAt: nowIso,
    });
    if (written.created) findingSummary.created++;
  }

  if (payload.findings?.length) {
    const allFindings = await listRows(ctx, http, appId, "findings", { groupKey }, { limit: 200 });
    const groupRow = (await listRows(ctx, http, appId, "runGroups", { groupKey }, { limit: 1 }))[0];
    if (groupRow) {
      await patchRow(ctx, http, appId, "runGroups", groupRow.id, {
        findingCount: allFindings.length,
      });
    }
  }

  // ── incidents ────────────────────────────────────────────────────────────
  const incidents = { opened: [] as string[], attached: [] as string[], closed: [] as string[] };
  const authoritative = opensIncidents(run.trigger) && !run.isFork;

  if (authoritative) {
    const triageWorkflowId = failures.length
      ? await ensureWorkflow(
          ctx,
          TRIAGE_WORKFLOW_NAME,
          "Triage a UI E2E failure incident: classify app-bug | flaky-spec | infra, then fix or file it.",
          TRIAGE_PROMPT,
          ["incidentKey", "repo", "specId", "fingerprint"],
          {
            type: "object",
            required: ["classification"],
            properties: {
              classification: {
                type: "string",
                enum: ["app-bug", "flaky-spec", "infra"],
              },
              rationale: { type: "string" },
              prUrl: { type: "string" },
              linearIssue: { type: "string" },
            },
          },
          "triageWorkflowId",
        )
      : null;

    for (const failure of failures) {
      const incidentKey = incidentKeyFor(run.repo, failure.fingerprint);
      const rows = await listRows(ctx, http, appId, "incidents", { incidentKey }, { limit: 1 });
      const existing = rows[0];

      if (existing && existing.status === "open") {
        // Same fingerprint, already open: count it, do NOT dispatch again.
        // One triage task per fingerprint is the whole point of the dedup.
        await patchRow(ctx, http, appId, "incidents", existing.id, {
          occurrences: (Number(existing.occurrences) || 0) + 1,
          lastSeenAt: nowIso,
          lastSeenSha: run.sha,
          error: failure.error,
        });
        incidents.attached.push(incidentKey);
        continue;
      }

      let triageStatus = "pending";
      if (triageWorkflowId) {
        if (await claimDispatch(ctx, nowMs, cap)) {
          const fired = await fireWebhook(ctx, http, triageWorkflowId, {
            incidentKey,
            repo: run.repo,
            specId: failure.specId,
            fingerprint: failure.fingerprint,
            title: failure.title,
            error: failure.error,
            sha: run.sha,
            target,
            trigger: run.trigger,
            occurrences: existing ? (Number(existing.occurrences) || 0) + 1 : 1,
            runUrl: run.ciUrl ?? "",
            pageUrl,
          });
          triageStatus = fired ? "dispatched" : "pending";
          if (fired) dispatch.dispatched++;
        } else {
          triageStatus = "deferred";
          dispatch.deferred++;
        }
      }

      if (existing) {
        // A closed incident that fails again REOPENS the same row — the flake
        // history stays in one place instead of forking a fresh occurrences=1.
        await patchRow(ctx, http, appId, "incidents", existing.id, {
          status: "open",
          triageStatus,
          occurrences: (Number(existing.occurrences) || 0) + 1,
          lastSeenAt: nowIso,
          lastSeenSha: run.sha,
          error: failure.error,
          closedAt: null,
          closedBySha: "",
        });
      } else {
        await createRow(ctx, http, appId, "incidents", {
          incidentKey,
          repo: run.repo,
          specId: failure.specId,
          fingerprint: failure.fingerprint,
          title: failure.title,
          error: failure.error,
          status: "open",
          triageStatus,
          classification: "unknown",
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          firstSeenSha: run.sha,
          lastSeenSha: run.sha,
          occurrences: 1,
        });
      }
      incidents.opened.push(incidentKey);
    }

    // Close on green — only on a COMPLETE group, and only for specs this group
    // actually passed. Closing every open incident for the repo would silently
    // close incidents for specs these shards never ran.
    if (aggregate.complete && aggregate.status === "passed") {
      const groupResults = await listRows(ctx, http, appId, "results", { groupKey }, { limit: 1000 });
      const passedSpecs = new Set(
        groupResults.filter((r: any) => r.status === "passed").map((r: any) => r.specId),
      );
      const open = await listRows(ctx, http, appId, "incidents", { repo: run.repo, status: "open" }, { limit: 200 });
      for (const incident of open) {
        if (!passedSpecs.has(incident.specId)) continue;
        await patchRow(ctx, http, appId, "incidents", incident.id, {
          status: "closed",
          closedAt: nowIso,
          closedBySha: run.sha,
        });
        incidents.closed.push(incident.incidentKey);
      }
    }
  }

  // ── public page ──────────────────────────────────────────────────────────
  let page: any = { skipped: true };
  const statusChanged = previousStatus !== aggregate.status;
  if (payload.regeneratePage !== false) {
    const minInterval = await configNumber(
      ctx,
      "UI_E2E_PAGE_MIN_INTERVAL_SEC",
      CONFIG_DEFAULTS.UI_E2E_PAGE_MIN_INTERVAL_SEC,
    );
    const lastRes: any = await ctx.swarm.kv_getOrNull({ namespace: KV_NAMESPACE, key: "pageAt" });
    const lastAt = Number(lastRes?.data?.value ?? lastRes?.value ?? 0) || 0;
    // Two shards plus a retry would otherwise rewrite (and version-snapshot)
    // the page five times a minute. A status change always wins the debounce.
    if (statusChanged || nowMs - lastAt > minInterval * 1000) {
      const perTarget = await configNumber(
        ctx,
        "UI_E2E_PAGE_RUNS_PER_TARGET",
        CONFIG_DEFAULTS.UI_E2E_PAGE_RUNS_PER_TARGET,
      );
      page = await regeneratePage(ctx, http, appId, { perTarget, appUrl });
      await ctx.swarm.kv_set({ namespace: KV_NAMESPACE, key: "pageAt", value: nowMs });
    }
  }

  return {
    ok: true,
    appId,
    appUrl,
    schedules,
    groupKey,
    runKey,
    attempt: Number(shard.row?.attempt ?? 1),
    groupStatus: aggregate.status,
    shardsReported: aggregate.shardsReported,
    shardTotal: aggregate.shardTotal,
    complete: aggregate.complete,
    missingShards: aggregate.missingShards,
    resultsWritten: payload.results.length,
    artifactsWritten,
    forkRejectedArtifacts: forkRejected.length,
    incidents,
    findings: findingSummary,
    dispatch: { capPerDay: cap, usedToday: await dispatchedToday(ctx, nowMs), ...dispatch },
    page,
  };
}

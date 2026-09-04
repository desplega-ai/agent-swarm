/**
 * Shared core for the UI E2E tracker scripts (`ui-e2e-ingest`, `ui-e2e-sweep`,
 * `ui-e2e-prune`).
 *
 * This file is a plain module with NO imports, so `src/be/seed-scripts/index.ts`
 * can text-prepend it into each script's runtime source (same trick as
 * `catalog-report.ts`). Keeping it importable also means the pure logic —
 * fingerprinting, shard aggregation, retention cutoffs — is unit-testable
 * directly from `src/tests/scripts-ui-e2e-tracker.test.ts` instead of only
 * through a sandboxed script run.
 *
 * Everything that talks to the swarm goes through `ctx` and is typed `any`:
 * catalog scripts are typechecked against the generated script SDK, not against
 * the host repo's types.
 */

// ─── Config keys ─────────────────────────────────────────────────────────────

export const CONFIG_DEFAULTS = {
  /** A group still `running` past this many minutes is marked `incomplete`. */
  UI_E2E_SHARD_TIMEOUT_MIN: 90,
  /** Cap on triage/promote dispatches per UTC day, shared by both workflows. */
  UI_E2E_MAX_PRS_PER_DAY: 5,
  /** Retention window for rows and agent-fs paths. */
  UI_E2E_RETENTION_DAYS: 30,
  /** Run groups listed per target on the public page. */
  UI_E2E_PAGE_RUNS_PER_TARGET: 10,
  /** Debounce between page regenerations when nothing changed status. */
  UI_E2E_PAGE_MIN_INTERVAL_SEC: 30,
};

export const APP_NAME = "uiE2eTracker";
export const PAGE_SLUG = "ui-e2e";
export const TRIAGE_WORKFLOW_NAME = "ui-e2e-incident-triage";
export const PROMOTE_WORKFLOW_NAME = "ui-e2e-promote-finding";
export const KV_NAMESPACE = "ui-e2e";

/** Error text is stored in a string column; keep rows small and pages readable. */
export const MAX_ERROR_CHARS = 4000;

// ─── Keys and fingerprints ───────────────────────────────────────────────────

export function slugify(input: string): string {
  return (
    String(input || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

/**
 * FNV-1a 64-bit, rendered as 16 hex chars.
 *
 * Deliberately not SHA-256: the scripts-runtime import allowlist rejects
 * `crypto`, and a fingerprint only has to separate distinct failure shapes
 * within one repo's spec set — it is not a security boundary. FNV-1a is
 * dependency-free, deterministic across runtimes, and stable enough for that.
 */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash = (hash ^ BigInt(input.charCodeAt(i) & 0xff)) & mask;
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Collapse a raw Playwright error into the shape that identifies the failure,
 * dropping everything that varies run to run.
 *
 * Digit-stripping is the load-bearing step: without it `Timeout 5000ms
 * exceeded` and `Timeout 30000ms exceeded` are two incidents for one bug.
 */
export function normalizeError(error: unknown): string {
  const raw = typeof error === "string" ? error : "";
  if (!raw.trim()) return "";
  const firstLine = raw.split("\n")[0] ?? "";
  return firstLine
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR is the point.
    .replace(/\[[0-9;]*m/g, "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/(?:\.{0,2}\/)[\w.@/-]+/g, "<path>")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

/** Failure identity: the spec plus the normalized error, per the contract. */
export function failureFingerprint(specId: string, error: unknown): string {
  return fnv1a64(`${specId}\n${normalizeError(error)}`);
}

/** `pr-<N>` for a pull request, `main` otherwise. Nightly reports against main. */
export function targetFor(prNumber: number | null | undefined): string {
  return typeof prNumber === "number" && prNumber > 0 ? `pr-${prNumber}` : "main";
}

export function groupKeyFor(run: {
  repo: string;
  prNumber?: number | null;
  sha: string;
  runner: string;
}): string {
  return `${run.repo}#${targetFor(run.prNumber)}#${run.sha}#${run.runner}`;
}

export function runKeyFor(groupKey: string, shardIndex: number): string {
  return `${groupKey}#${shardIndex}`;
}

export function resultKeyFor(runKey: string, specId: string): string {
  return `${runKey}#${specId}`;
}

export function artifactKeyFor(
  runKey: string,
  kind: string,
  pathOrUrl: string,
): string {
  return `${runKey}#${kind}#${pathOrUrl}`;
}

export function findingKeyFor(groupKey: string, title: string): string {
  return `${groupKey}#${slugify(title)}`;
}

export function incidentKeyFor(repo: string, fingerprint: string): string {
  return `${repo}#${fingerprint}`;
}

/** Incidents are opened and closed only by the two authoritative triggers. */
export function opensIncidents(trigger: string): boolean {
  return trigger === "main" || trigger === "nightly";
}

// ─── Shard aggregation ───────────────────────────────────────────────────────

export type ShardRow = {
  shardIndex: number;
  shardTotal: number;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  passed?: number;
  failed?: number;
  skipped?: number;
  flaky?: number;
  costUsd?: number;
};

export type GroupAggregate = {
  shardTotal: number;
  shardsReported: number;
  complete: boolean;
  status: "running" | "passed" | "failed" | "incomplete";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  costUsd: number;
  missingShards: number[];
};

/**
 * Recompute a run group from EVERY shard row that shares its key — never from
 * the shard report that happened to arrive last. That is what makes
 * out-of-order shards and re-ingested retries converge on the same answer.
 */
export function aggregateShards(
  rows: ShardRow[],
  opts: { nowMs: number; timeoutMin: number },
): GroupAggregate {
  const shardTotal = rows.reduce((max, r) => Math.max(max, r.shardTotal || 0), 0);
  const seen = new Set<number>();
  for (const row of rows) {
    if (typeof row.shardIndex === "number") seen.add(row.shardIndex);
  }
  const shardsReported = seen.size;
  const complete = shardTotal > 0 && shardsReported >= shardTotal;

  const missingShards: number[] = [];
  for (let i = 1; i <= shardTotal; i++) if (!seen.has(i)) missingShards.push(i);

  const starts = rows.map((r) => Date.parse(r.startedAt || "")).filter((n) => !Number.isNaN(n));
  const ends = rows.map((r) => Date.parse(r.finishedAt || "")).filter((n) => !Number.isNaN(n));
  const startMs = starts.length ? Math.min(...starts) : opts.nowMs;
  const endMs = ends.length ? Math.max(...ends) : 0;

  const sum = (key: "passed" | "failed" | "skipped" | "flaky" | "costUsd") =>
    rows.reduce((total, r) => total + (Number(r[key]) || 0), 0);

  const anyFailed = rows.some((r) => r.status === "failed");
  const timedOut = opts.nowMs - startMs > opts.timeoutMin * 60_000;

  // Failure beats incompleteness: one failed shard plus one missing shard is a
  // failed run. The failure is evidence; the missing shard is only absence.
  let status: GroupAggregate["status"];
  if (anyFailed) status = "failed";
  else if (complete) status = "passed";
  else if (timedOut) status = "incomplete";
  else status = "running";

  return {
    shardTotal,
    shardsReported,
    complete,
    status,
    startedAt: new Date(startMs).toISOString(),
    finishedAt: complete && endMs ? new Date(endMs).toISOString() : "",
    durationMs: complete && endMs ? endMs - startMs : 0,
    passed: sum("passed"),
    failed: sum("failed"),
    skipped: sum("skipped"),
    flaky: sum("flaky"),
    costUsd: Math.round(sum("costUsd") * 10000) / 10000,
    missingShards,
  };
}

/** Per-shard tallies from the reported spec results. */
export function tallyResults(results: Array<{ status?: string }>): {
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
} {
  const tally = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  for (const r of results) {
    if (r.status === "passed") tally.passed++;
    else if (r.status === "failed") tally.failed++;
    else if (r.status === "skipped") tally.skipped++;
    else if (r.status === "flaky") tally.flaky++;
  }
  return tally;
}

// ─── App definition ──────────────────────────────────────────────────────────

const enumCol = (values: string[], dflt?: string) => ({
  kind: "enum",
  enum: values,
  ...(dflt ? { default: dflt } : {}),
});

/**
 * Six models, not the five the brief named: `runs` is one SHARD report and
 * `runGroups` is the aggregate across shards. Shard count is variable so it
 * cannot be columns; the sweep needs a concrete row to mark `incomplete`; and
 * the page needs a cheap per-target listing without a fan-in query.
 *
 * Apps have no composite-unique constraint and `POST /rows` always creates, so
 * every model carries an explicit indexed `*Key` column and the scripts upsert
 * by filtered list -> PATCH or POST.
 */
export const APP_DEFINITION: Record<string, unknown> = {
  models: {
    runGroups: {
      columns: {
        groupKey: { kind: "string", required: true, index: true },
        repo: { kind: "string", required: true, index: true },
        target: { kind: "string", required: true, index: true },
        ref: { kind: "string" },
        sha: { kind: "string", required: true, index: true },
        prNumber: { kind: "number" },
        isFork: { kind: "boolean", default: false },
        trigger: enumCol(["pr", "main", "nightly", "manual"]),
        runner: enumCol(["ci", "swarm-worker", "sandbox"]),
        shardTotal: { kind: "number", default: 1 },
        shardsReported: { kind: "number", default: 0 },
        status: enumCol(["running", "passed", "failed", "incomplete"], "running"),
        startedAt: { kind: "date" },
        finishedAt: { kind: "date" },
        durationMs: { kind: "number", default: 0 },
        passed: { kind: "number", default: 0 },
        failed: { kind: "number", default: 0 },
        skipped: { kind: "number", default: 0 },
        flaky: { kind: "number", default: 0 },
        findingCount: { kind: "number", default: 0 },
        costUsd: { kind: "number", default: 0 },
        lastIngestAt: { kind: "date", index: true },
      },
    },
    runs: {
      columns: {
        runKey: { kind: "string", required: true, index: true },
        groupKey: { kind: "string", required: true, index: true },
        repo: { kind: "string", required: true },
        target: { kind: "string" },
        sha: { kind: "string" },
        trigger: enumCol(["pr", "main", "nightly", "manual"]),
        runner: enumCol(["ci", "swarm-worker", "sandbox"]),
        shardIndex: { kind: "number", default: 1 },
        shardTotal: { kind: "number", default: 1 },
        attempt: { kind: "number", default: 1 },
        status: enumCol(["passed", "failed", "incomplete"], "incomplete"),
        startedAt: { kind: "date" },
        finishedAt: { kind: "date" },
        durationMs: { kind: "number", default: 0 },
        passed: { kind: "number", default: 0 },
        failed: { kind: "number", default: 0 },
        skipped: { kind: "number", default: 0 },
        flaky: { kind: "number", default: 0 },
        costModel: { kind: "string" },
        costTokens: { kind: "number", default: 0 },
        costUsd: { kind: "number", default: 0 },
        ciUrl: { kind: "string" },
        ingestedAt: { kind: "date", index: true },
      },
    },
    results: {
      columns: {
        resultKey: { kind: "string", required: true, index: true },
        runKey: { kind: "string", required: true, index: true },
        groupKey: { kind: "string", required: true, index: true },
        specId: { kind: "string", required: true, index: true },
        title: { kind: "string" },
        status: enumCol(["passed", "failed", "skipped", "flaky"], "passed"),
        durationMs: { kind: "number", default: 0 },
        retries: { kind: "number", default: 0 },
        error: { kind: "string" },
        fingerprint: { kind: "string", index: true },
        incidentKey: { kind: "string", index: true },
        ingestedAt: { kind: "date", index: true },
      },
    },
    artifacts: {
      columns: {
        artifactKey: { kind: "string", required: true, index: true },
        runKey: { kind: "string", required: true, index: true },
        groupKey: { kind: "string", required: true, index: true },
        specId: { kind: "string" },
        kind: enumCol(["screenshot", "trace", "video", "report", "log"], "log"),
        storage: enumCol(["agent-fs", "github"], "agent-fs"),
        path: { kind: "string" },
        url: { kind: "string" },
        viewerUrl: { kind: "string" },
        sizeBytes: { kind: "number", default: 0 },
        ingestedAt: { kind: "date", index: true },
      },
    },
    findings: {
      columns: {
        findingKey: { kind: "string", required: true, index: true },
        groupKey: { kind: "string", required: true, index: true },
        runKey: { kind: "string" },
        repo: { kind: "string", required: true },
        target: { kind: "string" },
        sha: { kind: "string" },
        title: { kind: "string", required: true },
        severity: enumCol(["low", "medium", "high", "critical"], "medium"),
        steps: { kind: "string" },
        suspectedArea: { kind: "string" },
        evidence: { kind: "string" },
        status: enumCol(["open", "dispatched", "deferred", "promoted", "dismissed"], "open"),
        promoteTaskId: { kind: "string" },
        ingestedAt: { kind: "date", index: true },
      },
    },
    incidents: {
      columns: {
        incidentKey: { kind: "string", required: true, index: true },
        repo: { kind: "string", required: true, index: true },
        specId: { kind: "string", required: true, index: true },
        fingerprint: { kind: "string", required: true, index: true },
        title: { kind: "string" },
        error: { kind: "string" },
        status: enumCol(["open", "closed"], "open"),
        triageStatus: enumCol(["pending", "dispatched", "deferred"], "pending"),
        classification: enumCol(["unknown", "app-bug", "flaky-spec", "infra"], "unknown"),
        firstSeenAt: { kind: "date" },
        lastSeenAt: { kind: "date", index: true },
        firstSeenSha: { kind: "string" },
        lastSeenSha: { kind: "string" },
        occurrences: { kind: "number", default: 1 },
        triageTaskId: { kind: "string" },
        linearIssue: { kind: "string" },
        fixPr: { kind: "string" },
        closedAt: { kind: "date" },
        closedBySha: { kind: "string" },
      },
    },
  },
  queries: {
    recentGroups: { model: "runGroups", sort: { column: "lastIngestAt", dir: "desc" }, limit: 100 },
    openIncidents: {
      model: "incidents",
      filter: { status: "open" },
      sort: { column: "lastSeenAt", dir: "desc" },
      limit: 100,
    },
    openFindings: {
      model: "findings",
      filter: { status: "open" },
      sort: { column: "ingestedAt", dir: "desc" },
      limit: 100,
    },
    recentFailures: {
      model: "results",
      filter: { status: "failed" },
      sort: { column: "ingestedAt", dir: "desc" },
      limit: 200,
    },
  },
  pages: {
    overview: {
      title: "UI E2E tracker",
      root: "root",
      elements: {
        root: {
          type: "Stack",
          props: { gap: "lg", padding: "md" },
          children: ["heading", "runsCard", "incidentsCard", "findingsCard", "failuresCard"],
        },
        heading: { type: "Heading", props: { text: "UI E2E tracker", level: "h1" } },
        runsCard: {
          type: "Card",
          props: { title: "Recent runs", description: "One row per repo/target/sha/runner." },
          children: ["runsTable"],
        },
        runsTable: {
          type: "Table",
          props: {
            data: { $state: "/queries/recentGroups/data" },
            loading: { $state: "/queries/recentGroups/loading" },
            emptyMessage: "No runs ingested yet.",
            pagination: true,
            columns: [
              { key: "target", label: "Target" },
              { key: "sha", label: "SHA" },
              { key: "trigger", label: "Trigger", kind: "badge" },
              { key: "runner", label: "Runner" },
              {
                key: "status",
                label: "Status",
                kind: "badge",
                tones: {
                  passed: "success",
                  failed: "error",
                  running: "pending",
                  incomplete: "warning",
                },
              },
              { key: "passed", label: "Pass", kind: "number" },
              { key: "failed", label: "Fail", kind: "number" },
              { key: "flaky", label: "Flaky", kind: "number" },
              { key: "durationMs", label: "Duration ms", kind: "number" },
              { key: "lastIngestAt", label: "Last ingest", kind: "date" },
            ],
          },
        },
        incidentsCard: {
          type: "Card",
          props: { title: "Open incidents", description: "One per failure fingerprint." },
          children: ["incidentsTable"],
        },
        incidentsTable: {
          type: "Table",
          props: {
            data: { $state: "/queries/openIncidents/data" },
            loading: { $state: "/queries/openIncidents/loading" },
            emptyMessage: "No open incidents.",
            columns: [
              { key: "specId", label: "Spec" },
              {
                key: "classification",
                label: "Class",
                kind: "badge",
                tones: {
                  "app-bug": "error",
                  "flaky-spec": "warning",
                  infra: "info",
                  unknown: "neutral",
                },
              },
              { key: "occurrences", label: "Seen", kind: "number" },
              { key: "lastSeenSha", label: "Last SHA" },
              { key: "lastSeenAt", label: "Last seen", kind: "date" },
              { key: "triageStatus", label: "Triage", kind: "badge" },
              { key: "fixPr", label: "Fix PR" },
              { key: "linearIssue", label: "Linear" },
            ],
          },
        },
        findingsCard: {
          type: "Card",
          props: { title: "Exploratory findings", description: "Awaiting promotion to a spec." },
          children: ["findingsTable"],
        },
        findingsTable: {
          type: "Table",
          props: {
            data: { $state: "/queries/openFindings/data" },
            loading: { $state: "/queries/openFindings/loading" },
            emptyMessage: "No open findings.",
            columns: [
              { key: "title", label: "Finding" },
              {
                key: "severity",
                label: "Severity",
                kind: "badge",
                tones: { critical: "error", high: "error", medium: "warning", low: "neutral" },
              },
              { key: "suspectedArea", label: "Area" },
              { key: "target", label: "Target" },
              { key: "status", label: "Status", kind: "badge" },
              { key: "ingestedAt", label: "Seen", kind: "date" },
            ],
          },
        },
        failuresCard: {
          type: "Card",
          props: { title: "Recent failures", description: "Every failed spec result." },
          children: ["failuresTable"],
        },
        failuresTable: {
          type: "Table",
          props: {
            data: { $state: "/queries/recentFailures/data" },
            loading: { $state: "/queries/recentFailures/loading" },
            emptyMessage: "No failures recorded.",
            pagination: true,
            columns: [
              { key: "specId", label: "Spec" },
              { key: "error", label: "Error" },
              { key: "retries", label: "Retries", kind: "number" },
              { key: "fingerprint", label: "Fingerprint" },
              { key: "ingestedAt", label: "When", kind: "date" },
            ],
          },
        },
      },
    },
  },
  defaultPage: "overview",
};

// ─── Swarm HTTP helpers ──────────────────────────────────────────────────────

/**
 * SDK envelope shapes are NOT uniform: `app_list` puts its array at
 * `data.apps`, `schedule_list` at `data.schedules`, `workflow_list` puts it at
 * `data` itself. Guessing one shape silently yields an empty list, which here
 * meant "not found" and created a duplicate workflow on every single ingest.
 */
export function unwrapList(response: any, key: string): any[] {
  const payload = response?.data ?? response;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(response?.[key])) return response[key];
  return [];
}

/** Created-entity id, wherever the tool happens to put it. */
export function unwrapId(response: any): string | null {
  const payload = response?.data ?? response;
  const candidate =
    payload?.id ??
    payload?.appId ??
    payload?.workflowId ??
    payload?.scheduleId ??
    payload?.schedule?.id ??
    payload?.workflow?.id ??
    payload?.app?.id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

export type SwarmHttp = { base: string; headers: Record<string, string> };

export function swarmHttp(ctx: any): SwarmHttp {
  const base = ctx.stdlib.Redacted.value(ctx.swarm.config.mcpBaseUrl).replace(/\/+$/, "");
  return {
    base,
    headers: {
      Authorization: `Bearer ${ctx.stdlib.Redacted.value(ctx.swarm.config.apiKey)}`,
      "X-Agent-ID": ctx.stdlib.Redacted.value(ctx.swarm.config.agentId),
      "Content-Type": "application/json",
    },
  };
}

async function httpJson(
  ctx: any,
  http: SwarmHttp,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await ctx.stdlib.fetch(http.base + path, {
    method,
    headers: http.headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${path} -> ${res.status} ${parsed?.error || parsed?.message || text.slice(0, 200)}`,
    );
  }
  return parsed;
}

function rowsPath(appId: string, model: string): string {
  return `/api/apps/${encodeURIComponent(appId)}/models/${encodeURIComponent(model)}/rows`;
}

export async function listRows(
  ctx: any,
  http: SwarmHttp,
  appId: string,
  model: string,
  filter: Record<string, string | number | boolean> = {},
  extra: Record<string, string | number> = {},
): Promise<any[]> {
  // Row filters MUST carry the `filter.` prefix — `filtersFromQuery` in
  // src/http/apps.ts skips every other query key silently, so an unprefixed
  // filter returns the WHOLE model and every upsert then patches row #1.
  const params: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    params.push(`filter.${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  for (const [key, value] of Object.entries(extra)) {
    params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  const qs = params.length ? `?${params.join("&")}` : "";
  const body = await httpJson(ctx, http, "GET", rowsPath(appId, model) + qs);
  return Array.isArray(body?.rows) ? body.rows : [];
}

export async function createRow(
  ctx: any,
  http: SwarmHttp,
  appId: string,
  model: string,
  values: Record<string, unknown>,
): Promise<any> {
  const body = await httpJson(ctx, http, "POST", rowsPath(appId, model), { values });
  return body?.row ?? null;
}

export async function patchRow(
  ctx: any,
  http: SwarmHttp,
  appId: string,
  model: string,
  rowId: string,
  values: Record<string, unknown>,
): Promise<any> {
  const body = await httpJson(
    ctx,
    http,
    "PATCH",
    `${rowsPath(appId, model)}/${encodeURIComponent(rowId)}`,
    { values },
  );
  return body?.row ?? null;
}

export async function deleteRow(
  ctx: any,
  http: SwarmHttp,
  appId: string,
  model: string,
  rowId: string,
): Promise<void> {
  await httpJson(ctx, http, "DELETE", `${rowsPath(appId, model)}/${encodeURIComponent(rowId)}`);
}

/**
 * Upsert by the model's `*Key` column. This is what makes a retry of the same
 * (repo, sha, shard, runner) update rows instead of duplicating them.
 */
export async function upsertRow(
  ctx: any,
  http: SwarmHttp,
  appId: string,
  model: string,
  keyColumn: string,
  keyValue: string,
  values: Record<string, unknown>,
  onExisting?: (existing: any) => Record<string, unknown>,
): Promise<{ row: any; created: boolean }> {
  const existing = await listRows(ctx, http, appId, model, { [keyColumn]: keyValue }, { limit: 1 });
  const found = existing[0];
  if (!found) {
    return {
      row: await createRow(ctx, http, appId, model, { ...values, [keyColumn]: keyValue }),
      created: true,
    };
  }
  const merged = onExisting ? { ...values, ...onExisting(found) } : values;
  return { row: await patchRow(ctx, http, appId, model, found.id, merged), created: false };
}

// ─── Config + KV ─────────────────────────────────────────────────────────────

export async function configNumber(ctx: any, key: string, fallback: number): Promise<number> {
  try {
    const res: any = await ctx.swarm.config_get({ key });
    const payload = res?.data ?? res;
    const raw = payload?.value ?? payload?.config?.value;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export async function configString(ctx: any, key: string): Promise<string | null> {
  try {
    const res: any = await ctx.swarm.config_get({ key });
    const payload = res?.data ?? res;
    const raw = payload?.value ?? payload?.config?.value;
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * `date` columns reject the empty string but accept `null` for a non-required
 * column (`validValue` in `src/apps/row-store.ts`). Anything that may be
 * "not known yet" — a group's `finishedAt`, a reopened incident's `closedAt` —
 * has to go through this or the whole row write fails with `invalid row values`.
 */
export function dateOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ─── agent-fs viewer links ───────────────────────────────────────────────────

/**
 * `{live}/file/~/{orgId}/{driveId}/{path}` — the same deterministic form
 * `buildAgentFsLiveUrl` produces in `src/utils/constants.ts`. Path-addressed and
 * unsigned, so there is no expiry to re-sign on each page regeneration.
 */
export function agentFsViewerUrl(
  liveHost: string,
  orgId: string | null,
  driveId: string | null,
  path: string,
): string {
  if (!orgId || !driveId || !path) return "";
  return `${liveHost.replace(/\/+$/, "")}/file/~/${orgId}/${driveId}/${path.replace(/^\/+/, "")}`;
}

export const DEFAULT_AGENT_FS_LIVE_HOST = "https://live.agent-fs.dev";

/** Canonical artifact path prefix for a run's shard, per the storage contract. */
export function artifactPathPrefix(
  repo: string,
  target: string,
  sha: string,
  shardIndex: number,
): string {
  return `e2e/${repo.replace(/\//g, "__")}/${target}/${sha}/${shardIndex}/`;
}

// ─── Public page rendering ───────────────────────────────────────────────────

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Scheme allowlist for every URL this page turns into an `href`.
 *
 * `escapeHtml` stops markup injection but NOT an executable scheme: a stored
 * `javascript:alert(1)` survives escaping intact and runs on click, and the
 * tracker page is public. So an href is rendered ONLY when it parses as an
 * absolute http(s) URL; everything else (javascript:, data:, vbscript:, file:,
 * a protocol-relative `//evil`, a relative path) collapses to "" and the caller
 * renders inert text instead of a link.
 *
 * Applied at ingest so bad URLs are never stored, AND here at render so rows
 * written before this check — or by any other writer — still cannot execute.
 */
export function safeHttpUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Not absolute (relative path, protocol-relative `//host`, or malformed).
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
  return parsed.href;
}

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export type PageModel = {
  generatedAt: string;
  appUrl: string;
  targets: Array<{
    target: string;
    groups: Array<{
      sha: string;
      trigger: string;
      runner: string;
      status: string;
      durationMs: number;
      passed: number;
      failed: number;
      flaky: number;
      shardsReported: number;
      shardTotal: number;
      lastIngestAt: string;
      artifacts: Array<{ kind: string; storage: string; href: string; label: string }>;
    }>;
  }>;
  incidents: Array<{
    specId: string;
    occurrences: number;
    classification: string;
    lastSeenAt: string;
    lastSeenSha: string;
    triageStatus: string;
    fixPr: string;
    linearIssue: string;
  }>;
  findings: Array<{
    title: string;
    severity: string;
    suspectedArea: string;
    status: string;
    target: string;
  }>;
};

const STATUS_COLORS: Record<string, string> = {
  passed: "#1a7f37",
  failed: "#cf222e",
  running: "#9a6700",
  incomplete: "#8250df",
};

export function renderTrackerPage(model: PageModel): string {
  const targetSections = model.targets
    .map((t) => {
      const rows = t.groups
        .map((g) => {
          const links = g.artifacts.length
            ? g.artifacts
                .map((a) => {
                  // Unsafe scheme -> render the label as inert text, never an href.
                  const safe = safeHttpUrl(a.href);
                  if (!safe) {
                    return `<span class=muted title="${escapeHtml(a.storage)}">${escapeHtml(a.label)}</span>`;
                  }
                  return `<a href="${escapeHtml(safe)}" title="${escapeHtml(a.storage)}">${escapeHtml(a.label)}</a>`;
                })
                .join(" ")
            : "<span class=muted>none</span>";
          const color = STATUS_COLORS[g.status] ?? "#57606a";
          return `<tr>
  <td><code>${escapeHtml(g.sha.slice(0, 8))}</code></td>
  <td><b style="color:${color}">${escapeHtml(g.status)}</b></td>
  <td>${escapeHtml(g.trigger)} / ${escapeHtml(g.runner)}</td>
  <td>${g.shardsReported}/${g.shardTotal}</td>
  <td>${g.passed} pass · ${g.failed} fail · ${g.flaky} flaky</td>
  <td>${escapeHtml(formatDuration(g.durationMs))}</td>
  <td class=links>${links}</td>
  <td class=muted>${escapeHtml(g.lastIngestAt)}</td>
</tr>`;
        })
        .join("\n");
      return `<h2>${escapeHtml(t.target)}</h2>
<table>
<thead><tr><th>SHA</th><th>Status</th><th>Trigger</th><th>Shards</th><th>Results</th><th>Duration</th><th>Artifacts</th><th>Last ingest</th></tr></thead>
<tbody>${rows || '<tr><td colspan=8 class=muted>No runs.</td></tr>'}</tbody>
</table>`;
    })
    .join("\n");

  const incidentRows = model.incidents
    .map((i) => {
      // fixPr is written back by the triage agent, so it gets the same scheme
      // allowlist as artifact links rather than bare HTML escaping.
      const fixPr = safeHttpUrl(i.fixPr);
      const fixPrCell = fixPr ? `<a href="${escapeHtml(fixPr)}">PR</a>` : "";
      return `<tr>
  <td><code>${escapeHtml(i.specId)}</code></td>
  <td>${escapeHtml(i.classification)}</td>
  <td>${i.occurrences}</td>
  <td><code>${escapeHtml(i.lastSeenSha.slice(0, 8))}</code></td>
  <td class=muted>${escapeHtml(i.lastSeenAt)}</td>
  <td>${escapeHtml(i.triageStatus)}</td>
  <td>${fixPrCell} ${escapeHtml(i.linearIssue)}</td>
</tr>`;
    })
    .join("\n");

  const findingRows = model.findings
    .map(
      (f) => `<tr>
  <td>${escapeHtml(f.title)}</td>
  <td>${escapeHtml(f.severity)}</td>
  <td>${escapeHtml(f.suspectedArea)}</td>
  <td>${escapeHtml(f.target)}</td>
  <td>${escapeHtml(f.status)}</td>
</tr>`,
    )
    .join("\n");

  const safeAppUrl = safeHttpUrl(model.appUrl);
  const appLink = safeAppUrl ? ` · <a href="${escapeHtml(safeAppUrl)}">private app</a>` : "";

  return `<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>UI E2E tracker</title>
<style>
:root { color-scheme: light dark; }
body { font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0 auto; max-width: 1100px; padding: 24px 16px 64px; }
h1 { margin: 0 0 4px; font-size: 22px; }
h2 { margin: 28px 0 8px; font-size: 16px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #d0d7de40; vertical-align: top; }
th { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; opacity: .7; }
code { font: 12px ui-monospace, SFMono-Regular, monospace; }
.muted { opacity: .6; }
.links a { margin-right: 6px; }
.sub { margin: 0 0 20px; opacity: .7; }
</style>
</head>
<body>
<h1>UI E2E tracker</h1>
<p class=sub>Read-only projection. Generated ${escapeHtml(model.generatedAt)}${appLink}</p>
${targetSections}
<h2>Open incidents</h2>
<table>
<thead><tr><th>Spec</th><th>Class</th><th>Seen</th><th>Last SHA</th><th>Last seen</th><th>Triage</th><th>Links</th></tr></thead>
<tbody>${incidentRows || '<tr><td colspan=7 class=muted>None open.</td></tr>'}</tbody>
</table>
<h2>Exploratory findings</h2>
<table>
<thead><tr><th>Finding</th><th>Severity</th><th>Area</th><th>Target</th><th>Status</th></tr></thead>
<tbody>${findingRows || '<tr><td colspan=5 class=muted>None.</td></tr>'}</tbody>
</table>
<p class=muted>GitHub-stored artifacts expire with their Actions run; agent-fs viewer links do not.</p>
</body>
</html>`;
}

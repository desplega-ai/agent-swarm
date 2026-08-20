import * as z from "zod";
import { deleteKv, getAllTasks, getKv, type TaskFilters, upsertKv } from "../be/db";
import { listScriptConnections } from "../be/script-connections";
import { getScriptById } from "../be/scripts/db";
import { runSavedScriptAsAgent } from "../be/scripts/run-saved";
import { type AgentTask, AgentTaskStatusSchema } from "../types";
import { scrubObject, scrubSecrets } from "../utils/secret-scrubber";
import {
  type AppDefinition,
  type AppValidationIssue,
  type ColumnDef,
  isIso8601Date,
  type ModelDef,
  type SourceDef,
  type SourceTransform,
} from "./definition";
import {
  type AppRow,
  appsNamespace,
  createAppRowUnlocked,
  listAllAppRowsForMigrationUnlocked,
  patchAppRowUnlocked,
  withMutationLock,
} from "./row-store";
import { appDefinitionNeedsRepair, getApp } from "./store";
import { resolveSyncRunAs } from "./sync-run-as";

/** One record a source pull produced: an identity plus its raw field bag. */
export type SourceRecord = { key: string; fields: Record<string, unknown> };

/**
 * `complete: false` means the pull window may have missed records, so the
 * caller must NOT sweep unseen rows stale.
 */
export type PullResult = { records: SourceRecord[]; complete: boolean; warnings: string[] };

export type SyncPassResult = {
  model: string;
  source: string;
  connector: "script" | "swarm-tasks";
  pulled: number;
  created: number;
  updated: number;
  refreshed: number;
  /** Source-owned rows this pass wrote nothing to: unseen and already stale, or unseen with the sweep skipped. */
  unchanged: number;
  markedStale: number;
  staleSweepSkipped?: boolean;
  warnings: string[];
  durationMs: number;
  invokedBy?: string;
  error?: string;
  /** Set together when single-flight short-circuited this trigger — no pull, no writes. */
  skipped?: true;
  alreadyRunning?: true;
};

/**
 * `ok` is false when any pass errored, or when the request never resolved to a
 * runnable pair — in which case `passes` is empty and `issues` carries
 * path-bearing reasons the doors (HTTP 400 / `toolErr`) can render verbatim.
 */
export type AppSyncResult = {
  ok: boolean;
  passes: SyncPassResult[];
  issues?: AppValidationIssue[];
};

/** Last-pass state per pair. No history — the current state is the whole story. */
export type AppSyncStatus = {
  lastStartedAt: string;
  lastFinishedAt: string;
  ok: boolean;
  created: number;
  updated: number;
  refreshed: number;
  markedStale: number;
  error?: string;
};

const MAX_PULL_RECORDS = 500;
const MAX_PASS_WARNINGS = 20;
const MAX_TASK_LIMIT = 200;
const DEFAULT_TASK_LIMIT = 100;
const MAX_TASK_PROMPT_CHARS = 1000;
const MAX_ERROR_DETAIL_CHARS = 500;

/** A pass failure with a message meant for an operator; never carries row churn. */
class SyncPassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncPassError";
  }
}

/** Transform could not produce a value for this column — the column goes null. */
class TransformError extends Error {}

function warn(warnings: string[], message: string): void {
  // Hard cap: a broken source must not turn one pass into an unbounded payload.
  if (warnings.length < MAX_PASS_WARNINGS) warnings.push(message);
}

// ---------------------------------------------------------------------------
// Sync status (KV)
// ---------------------------------------------------------------------------

/**
 * Full KV path is `apps:<appId>:sync-status:<model>:<source>` — the reserved
 * `apps:*` namespace plus this key. Writes go through the row-store's own
 * internal KV path (`src/be/db`), which the generic KV choke points guard.
 */
function syncStatusKey(model: string, source: string): string {
  return `sync-status:${model}:${source}`;
}

async function writeSyncStatus(
  appId: string,
  pass: SyncPassResult,
  lastStartedAt: string,
): Promise<void> {
  // A pass can outlive its app: deletion purges the apps:<id> namespace while
  // a pull is in flight, and writing here would resurrect it as an orphan.
  if (!(await getApp(appId))) return;
  const status: AppSyncStatus = {
    lastStartedAt,
    lastFinishedAt: new Date().toISOString(),
    ok: pass.error === undefined,
    created: pass.created,
    updated: pass.updated,
    refreshed: pass.refreshed,
    markedStale: pass.markedStale,
    ...(pass.error === undefined ? {} : { error: pass.error }),
  };
  await upsertKv({
    namespace: appsNamespace(appId),
    key: syncStatusKey(pass.model, pass.source),
    value: status,
    valueType: "json",
  });
}

/** Last completed pass for a pair, or null when none has run. */
export async function getAppSyncStatus(
  appId: string,
  model: string,
  source: string,
): Promise<AppSyncStatus | null> {
  const entry = await getKv(appsNamespace(appId), syncStatusKey(model, source));
  const value = entry?.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as AppSyncStatus;
}

/**
 * Every declared (model x source) pair's last-pass status, keyed
 * `<model>:<source>` — the per-source freshness surface the app payload and
 * `app-get` expose so UI/agents can render "last synced / last error".
 */
export async function collectAppSyncStatus(appId: string): Promise<Record<string, AppSyncStatus>> {
  const statuses: Record<string, AppSyncStatus> = {};
  const app = await getApp(appId);
  if (!app || appDefinitionNeedsRepair(app)) return statuses;
  for (const [modelName, model] of Object.entries(app.definition.models)) {
    for (const sourceName of Object.keys(model.sources ?? {})) {
      const status = await getAppSyncStatus(appId, modelName, sourceName);
      if (status) statuses[`${modelName}:${sourceName}`] = status;
    }
  }
  return statuses;
}

/**
 * Delete the per-pair status for every (model x source) whose pull or
 * projection dependencies changed between two definitions, or whose pair is
 * gone: the stored freshness described the OLD configuration, and presenting
 * it for the new one would claim a pass that never ran.
 */
export async function invalidateChangedSyncStatus(
  appId: string,
  previous: AppDefinition | undefined,
  next: AppDefinition,
): Promise<void> {
  if (!previous) return;
  for (const [modelName, oldModel] of Object.entries(previous.models)) {
    for (const [sourceName, oldSource] of Object.entries(oldModel.sources ?? {})) {
      const nextModel = next.models[modelName];
      const nextSource = nextModel?.sources?.[sourceName];
      const unchanged =
        nextModel !== undefined &&
        nextSource !== undefined &&
        pairFingerprint(nextModel, sourceName, nextSource) ===
          pairFingerprint(oldModel, sourceName, oldSource);
      if (!unchanged) await deleteKv(appsNamespace(appId), syncStatusKey(modelName, sourceName));
    }
  }
}

// ---------------------------------------------------------------------------
// Pull: script connector
// ---------------------------------------------------------------------------

/**
 * The canonical sync-script contract: a bare array is a complete snapshot;
 * the object form may declare an incomplete window.
 */
const SourceRecordSchema = z.object({
  key: z.union([z.string().min(1), z.number()]).transform(String),
  fields: z.record(z.string(), z.unknown()),
});

const PullPayloadSchema = z.union([
  z.array(SourceRecordSchema),
  z.object({ records: z.array(SourceRecordSchema), complete: z.boolean().optional() }),
]);

function scriptFailure(output: {
  exitCode: number;
  error?: string;
  runtimeError?: { name: string; message: string };
  stderr: string;
}): string | undefined {
  if (output.exitCode === 0 && !output.error && !output.runtimeError) return undefined;
  const base = output.runtimeError
    ? `${output.runtimeError.name}: ${output.runtimeError.message}`
    : (output.error ?? `script exited with code ${output.exitCode}`);
  // stderr is a prime secret carrier — scrub BEFORE truncating, or a secret
  // straddling the cap loses its suffix and defeats exact-value redaction.
  const stderr = scrubSecrets(output.stderr).trim().slice(0, MAX_ERROR_DETAIL_CHARS);
  return stderr.length > 0 ? `${base} — ${stderr}` : base;
}

function parsePullPayload(payload: unknown, warnings: string[]): PullResult {
  const parsed = PullPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new SyncPassError(
      `source script returned an invalid payload — expected Array<{key, fields}> or {records, complete?} (${detail})`,
    );
  }
  // A bare array is a complete snapshot by contract.
  let records = Array.isArray(parsed.data) ? parsed.data : parsed.data.records;
  let complete = Array.isArray(parsed.data) ? true : (parsed.data.complete ?? true);
  if (records.length > MAX_PULL_RECORDS) {
    warn(
      warnings,
      `source returned ${records.length} records; truncated to the ${MAX_PULL_RECORDS}-record cap and the stale sweep is skipped`,
    );
    records = records.slice(0, MAX_PULL_RECORDS);
    complete = false;
  }
  return { records, complete, warnings };
}

async function pullFromScript(args: {
  appId: string;
  model: string;
  sourceName: string;
  source: Extract<SourceDef, { connector: "script" }>;
}): Promise<PullResult> {
  const warnings: string[] = [];
  const { source } = args;
  const script = await getScriptById(source.scriptId);
  if (!script) throw new SyncPassError(`script "${source.scriptId}" not found`);
  const agentId = await resolveSyncRunAs(script);

  // Re-run the definition-time connection check at runtime: a connection
  // disabled after the write must fail the pass before the script is invoked.
  if (source.connection !== undefined) {
    const reachable = listScriptConnections({ agentId });
    if (!reachable.some((connection) => connection.slug === source.connection)) {
      throw new SyncPassError(
        `connection "${source.connection}" not found or disabled for the sync run-as identity`,
      );
    }
  }

  // runSavedScriptAsAgent is the entire credential story: egress secrets,
  // ctx.api.<slug> and ctx.mcp.<slug> for this identity. The engine never
  // reads, resolves, or forwards secret material.
  const output = await runSavedScriptAsAgent({
    script,
    agentId,
    input: {
      ...source.args,
      app: { id: args.appId },
      model: args.model,
      source: args.sourceName,
      ...(source.connection ? { connection: source.connection } : {}),
    },
  });
  const failure = scriptFailure(output);
  if (failure) throw new SyncPassError(failure);
  return parsePullPayload(output.result, warnings);
}

// ---------------------------------------------------------------------------
// Pull: swarm-tasks connector
// ---------------------------------------------------------------------------

const TASK_CONFIG_KEYS = new Set([
  "status",
  "agentId",
  "tags",
  "assetKey",
  "limit",
  "includeHeartbeat",
]);

function commaList(value: unknown): string[] {
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function taskLimit(raw: unknown, warnings: string[]): number {
  if (raw === undefined) return DEFAULT_TASK_LIMIT;
  const parsed = Math.trunc(Number(raw));
  if (!Number.isFinite(parsed) || parsed < 1) {
    warn(
      warnings,
      `config.limit "${String(raw)}" is not a positive integer; using ${DEFAULT_TASK_LIMIT}`,
    );
    return DEFAULT_TASK_LIMIT;
  }
  if (parsed > MAX_TASK_LIMIT) {
    warn(
      warnings,
      `config.limit ${parsed} exceeds the ${MAX_TASK_LIMIT} cap; using ${MAX_TASK_LIMIT}`,
    );
    return MAX_TASK_LIMIT;
  }
  return parsed;
}

function taskRecord(task: AgentTask): SourceRecord {
  return {
    key: task.id,
    fields: {
      id: task.id,
      status: task.status,
      // Scrub BEFORE truncating: a secret straddling the cap would otherwise
      // lose its suffix and defeat exact-value redaction downstream.
      prompt: scrubSecrets(task.task).slice(0, MAX_TASK_PROMPT_CHARS),
      source: task.source,
      agentId: task.agentId,
      tags: task.tags,
      priority: task.priority,
      createdAt: task.createdAt,
      updatedAt: task.lastUpdatedAt,
      vcsProvider: task.vcsProvider,
      vcsNumber: task.vcsNumber,
      vcsUrl: task.vcsUrl,
      vcsAuthor: task.vcsAuthor,
    },
  };
}

async function pullFromSwarmTasks(
  source: Extract<SourceDef, { connector: "swarm-tasks" }>,
  invokedBy?: string,
): Promise<PullResult> {
  const warnings: string[] = [];
  const config = source.config ?? {};
  for (const key of Object.keys(config)) {
    if (!TASK_CONFIG_KEYS.has(key)) {
      warn(
        warnings,
        `config key "${key}" is not supported by the swarm-tasks connector and was ignored`,
      );
    }
  }

  const limit = taskLimit(config.limit, warnings);
  const filters: TaskFilters = {
    limit,
    includeHeartbeat: config.includeHeartbeat === true || config.includeHeartbeat === "true",
  };

  if (config.status !== undefined) {
    const statuses = commaList(config.status).map((token) => {
      const parsed = AgentTaskStatusSchema.safeParse(token);
      if (!parsed.success) throw new SyncPassError(`config.status: unknown task status "${token}"`);
      return parsed.data;
    });
    // Fail CLOSED like agentId/assetKey: an empty filter silently dropping
    // would widen a previously scoped pull to the whole pool.
    if (statuses.length === 0) {
      throw new SyncPassError(
        `config.status must name at least one task status, got ${JSON.stringify(config.status)}`,
      );
    }
    filters.status = statuses;
  }
  // Scoping config fails CLOSED: silently dropping a malformed filter would
  // widen the pull to the whole task pool.
  if (config.agentId !== undefined) {
    if (typeof config.agentId !== "string" || config.agentId.trim().length === 0) {
      throw new SyncPassError(
        `config.agentId must be a non-empty string, got ${JSON.stringify(config.agentId)}`,
      );
    }
    filters.agentId = config.agentId.trim();
  }
  if (config.tags !== undefined) {
    const tags = commaList(config.tags);
    if (tags.length === 0) {
      throw new SyncPassError(
        `config.tags must name at least one tag, got ${JSON.stringify(config.tags)}`,
      );
    }
    filters.tags = tags;
  }
  if (config.assetKey !== undefined) {
    if (typeof config.assetKey !== "string" || config.assetKey.trim().length === 0) {
      throw new SyncPassError(
        `config.assetKey must be a non-empty string, got ${JSON.stringify(config.assetKey)}`,
      );
    }
    filters.keyPrefix = config.assetKey.trim();
  }

  // Mirror the get-tasks surface: a user principal is hard-scoped to tasks it
  // requested. A scoped window can never confirm absence outside that scope,
  // so the pull always reports incomplete and the stale sweep stays off.
  const scopedUserId = invokedBy?.startsWith("user:") ? invokedBy.slice("user:".length) : undefined;
  if (scopedUserId !== undefined) {
    filters.requestedByUserId = scopedUserId;
    warn(warnings, "pull scoped to tasks requested by the invoking user");
  }

  const records = (await getAllTasks(filters)).map(taskRecord);
  // A full page means the window may have cut records off.
  return { records, complete: scopedUserId === undefined && records.length < limit, warnings };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function getByDottedPath(fields: Record<string, unknown>, path: string): unknown {
  let value: unknown = fields;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function applyTransform(value: unknown, transform: SourceTransform | undefined): unknown {
  if (value === undefined || value === null) return null;
  switch (transform) {
    case undefined:
      return value;
    case "lower":
      return String(value).toLowerCase();
    case "upper":
      return String(value).toUpperCase();
    case "slug":
      return slugify(String(value));
    case "cents": {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) throw new TransformError(`"${String(value)}" is not a number`);
      return Math.round(numeric * 100);
    }
    case "date-parse": {
      const date = new Date(typeof value === "number" ? value : String(value));
      if (Number.isNaN(date.getTime()))
        throw new TransformError(`"${String(value)}" is not a date`);
      return date.toISOString();
    }
  }
}

/**
 * Mirrors the row-store's per-kind value check. Projections are pre-validated
 * here so one bad field nulls one column instead of throwing mid-reconcile and
 * leaving the pass half-applied.
 */
function validForKind(column: ColumnDef, value: unknown): boolean {
  if (column.kind === "string") return typeof value === "string";
  if (column.kind === "number") return typeof value === "number" && Number.isFinite(value);
  if (column.kind === "boolean") return typeof value === "boolean";
  if (column.kind === "date") return typeof value === "string" && isIso8601Date(value);
  return typeof value === "string" && Boolean(column.enum?.includes(value));
}

function projectRecord(args: {
  record: SourceRecord;
  bindings: Array<[string, ColumnDef]>;
  joinKey: string;
  warnings: string[];
}): Record<string, unknown> {
  const values: Record<string, unknown> = { [args.joinKey]: args.record.key };
  for (const [name, column] of args.bindings) {
    const binding = column.source;
    if (!binding) continue;
    const raw = getByDottedPath(args.record.fields, binding.field);
    let value: unknown;
    try {
      value = applyTransform(raw, binding.transform);
    } catch (error) {
      warn(
        args.warnings,
        `column "${name}": transform "${binding.transform}" failed — ${error instanceof Error ? error.message : String(error)}`,
      );
      value = null;
    }
    if (value !== null && !validForKind(column, value)) {
      warn(
        args.warnings,
        `column "${name}": field "${binding.field}" produced a value that is not a valid ${column.kind}`,
      );
      value = null;
    }
    values[name] = value;
  }
  return values;
}

/** A missing column and an explicit null are the same absence of a value. */
function sameValue(existing: unknown, projected: unknown): boolean {
  return Object.is(existing ?? null, projected ?? null);
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

type PairDefinition = { model: ModelDef; source: SourceDef };

async function resolvePair(
  appId: string,
  model: string,
  source: string,
): Promise<PairDefinition | null> {
  const app = await getApp(appId);
  if (!app || appDefinitionNeedsRepair(app)) return null;
  const modelDef = app.definition.models[model];
  const sourceDef = modelDef?.sources?.[source];
  return modelDef && sourceDef ? { model: modelDef, source: sourceDef } : null;
}

/**
 * Everything a pass's projection depends on: the full source definition plus
 * the shape of every column bound to it. Snapshotted before the unlocked pull
 * and compared under the lock — ANY drift (script, args, connection, config,
 * join key, bindings) aborts the pass rather than projecting a stale payload
 * through fresh rules. Serialization order is stable because both reads parse
 * the same stored definition; a concurrent definition write that merely
 * reorders keys aborts too, which is the safe direction.
 */
function pairFingerprint(model: ModelDef, sourceName: string, source: SourceDef): string {
  const bindings = Object.entries(model.columns)
    .filter(([, column]) => column.source?.of === sourceName)
    .map(([name, column]) => ({
      name,
      kind: column.kind,
      enum: column.enum ?? null,
      required: column.required === true,
      hidden: column.hidden === true,
      field: column.source?.field,
      transform: column.source?.transform ?? null,
    }));
  return JSON.stringify({ source, bindings });
}

type ReconcileCounts = {
  created: number;
  updated: number;
  refreshed: number;
  unchanged: number;
  markedStale: number;
  staleSweepSkipped?: boolean;
};

function reconcile(args: {
  appId: string;
  model: string;
  sourceName: string;
  fingerprint: string;
  joinKey: string;
  pull: PullResult;
  warnings: string[];
  /**
   * Mutated write-by-write so a mid-pass failure still reports the row churn
   * that actually committed — the writes are independent KV upserts, not a
   * transaction, and a thrown error must not zero them out.
   */
  counts: ReconcileCounts;
}): Promise<void> {
  const { appId, model, sourceName, joinKey, pull, warnings, counts } = args;
  return withMutationLock(appId, model, async () => {
    // Re-read under the lock: the pull ran unlocked, so the definition it was
    // planned against may be gone. Anything that moves the identity or the
    // projection rules of this pair aborts before the first write.
    const fresh = await resolvePair(appId, model, sourceName);
    if (!fresh) {
      throw new SyncPassError(
        `model "${model}" no longer declares source "${sourceName}"; pass aborted with no writes`,
      );
    }
    if (pairFingerprint(fresh.model, sourceName, fresh.source) !== args.fingerprint) {
      throw new SyncPassError(
        `source "${sourceName}" changed while the pull was running; pass aborted with no writes`,
      );
    }
    const modelDef = fresh.model;
    // Hidden columns are rejected by the row-store on every write path, so a
    // hidden binding must not be projected.
    const bindings = Object.entries(modelDef.columns).filter(
      ([, column]) => column.source?.of === sourceName && column.hidden !== true,
    );

    const mine = new Map<string, AppRow>();
    const unkeyed: AppRow[] = [];
    // Reconcile holds the mutation lock, so the unbounded pager is safe. The
    // plain listAppRows cap (100k) would hide rows past it: pulled keys would
    // duplicate and the hidden rows would never be swept stale.
    for (const row of await listAllAppRowsForMigrationUnlocked(appId, model)) {
      if (row.source !== sourceName) continue;
      const key = row[joinKey];
      if (typeof key === "string") mine.set(key, row);
      else unkeyed.push(row);
    }

    const now = new Date().toISOString();
    const actor = `sync:${sourceName}`;
    const seen = new Set<string>();

    for (const record of pull.records) {
      if (seen.has(record.key)) {
        warn(warnings, `source returned duplicate key "${record.key}"; the last record wins`);
      }
      seen.add(record.key);
      const values = projectRecord({ record, bindings, joinKey, warnings });
      const envelope = { source: sourceName, syncedAt: now, stale: false };
      const existing = mine.get(record.key);
      if (!existing) {
        // No adoption: a row with no source of its own is not ours to take.
        const created = await createAppRowUnlocked(appId, model, modelDef, values, {
          allowSourceManaged: true,
          envelope,
          actor,
        });
        mine.set(record.key, created);
        counts.created += 1;
        continue;
      }
      const differs = Object.entries(values).some(
        ([name, value]) => !sameValue(existing[name], value),
      );
      const updated = await patchAppRowUnlocked(appId, model, modelDef, existing.id, values, {
        allowSourceManaged: true,
        envelope,
        actor,
        // Freshness must be meaningful: syncedAt advances on every confirmed
        // row, updatedAt only when projected data actually moved.
        ...(differs ? {} : { skipUpdatedAt: true }),
      });
      if (!updated) {
        warn(warnings, `row "${existing.id}" vanished before it could be updated`);
        continue;
      }
      mine.set(record.key, updated);
      if (differs) counts.updated += 1;
      else counts.refreshed += 1;
    }

    const unseen = [...mine.entries()]
      .filter(([key]) => !seen.has(key))
      .map(([, row]) => row)
      .concat(unkeyed);
    if (!pull.complete) {
      counts.staleSweepSkipped = true;
      counts.unchanged += unseen.length;
      warn(warnings, "pull reported an incomplete window; stale sweep skipped");
      return;
    }
    for (const row of unseen) {
      if (row.stale === true) {
        counts.unchanged += 1;
        continue;
      }
      await patchAppRowUnlocked(
        appId,
        model,
        modelDef,
        row.id,
        {},
        {
          allowSourceManaged: true,
          skipUpdatedAt: true,
          // syncedAt records last confirmed presence, so it stays frozen here.
          envelope: {
            source: sourceName,
            syncedAt: typeof row.syncedAt === "string" ? row.syncedAt : now,
            stale: true,
          },
        },
      );
      counts.markedStale += 1;
    }
  });
}

// ---------------------------------------------------------------------------
// Pass orchestration
// ---------------------------------------------------------------------------

/** In-process single-flight guard, keyed `<appId>:<model>:<source>`. */
const inFlight = new Map<string, Promise<SyncPassResult>>();

function passBase(args: {
  model: string;
  source: string;
  connector: SourceDef["connector"];
  invokedBy?: string;
}): SyncPassResult {
  return {
    model: args.model,
    source: args.source,
    connector: args.connector,
    pulled: 0,
    created: 0,
    updated: 0,
    refreshed: 0,
    unchanged: 0,
    markedStale: 0,
    warnings: [],
    durationMs: 0,
    ...(args.invokedBy === undefined ? {} : { invokedBy: args.invokedBy }),
  };
}

async function executePass(args: {
  appId: string;
  model: string;
  sourceName: string;
  source: SourceDef;
  invokedBy?: string;
}): Promise<SyncPassResult> {
  const startedMs = Date.now();
  const lastStartedAt = new Date(startedMs).toISOString();
  const warnings: string[] = [];
  const base = passBase({
    model: args.model,
    source: args.sourceName,
    connector: args.source.connector,
    invokedBy: args.invokedBy,
  });

  // Set once the pair resolves. finish() skips the status write when the live
  // definition no longer matches this pass's snapshot: an obsolete pass must
  // not resurrect status a migration just invalidated, nor seed an orphan key
  // for a pair that changed or vanished while it was in flight.
  let plannedFingerprint: string | null = null;

  const finish = async (result: SyncPassResult): Promise<SyncPassResult> => {
    const scrubbed = scrubObject({ ...result, warnings, durationMs: Date.now() - startedMs });
    const current = await resolvePair(args.appId, args.model, args.sourceName);
    const stillCurrent =
      plannedFingerprint !== null &&
      current !== null &&
      pairFingerprint(current.model, args.sourceName, current.source) === plannedFingerprint;
    if (stillCurrent) await writeSyncStatus(args.appId, scrubbed, lastStartedAt);
    return scrubbed;
  };

  // Reconcile mutates this accumulator write-by-write, so the error path below
  // reports the churn that actually committed instead of the zero-count base.
  const counts: ReconcileCounts = {
    created: 0,
    updated: 0,
    refreshed: 0,
    unchanged: 0,
    markedStale: 0,
  };
  let pulled = 0;

  try {
    // Snapshot the pair's projection rules before the unlocked pull; reconcile
    // compares under the lock and aborts on any drift.
    const planned = await resolvePair(args.appId, args.model, args.sourceName);
    if (!planned) {
      throw new SyncPassError(
        `model "${args.model}" no longer declares source "${args.sourceName}"; pass aborted with no writes`,
      );
    }
    // Pull from the SAME snapshot the fingerprint was computed from:
    // args.source was captured at pair-selection time and may already be
    // stale (an earlier pass's await lets the definition move); pulling it
    // while fingerprinting the fresh resolve would let drifted data commit.
    const source = planned.source;
    const fingerprint = pairFingerprint(planned.model, args.sourceName, source);
    plannedFingerprint = fingerprint;

    // Pull OUTSIDE the lock; reconcile inside it. Pulled values persist into
    // rows any app.use principal can later read, so secrets are redacted here
    // at the persistence boundary — the finish() scrub only covers the pass
    // summary, never pull.records.
    const pull = scrubObject(
      source.connector === "script"
        ? await pullFromScript({
            appId: args.appId,
            model: args.model,
            sourceName: args.sourceName,
            source,
          })
        : await pullFromSwarmTasks(source, args.invokedBy),
    );
    pulled = pull.records.length;
    for (const warning of pull.warnings) warn(warnings, warning);
    await reconcile({
      appId: args.appId,
      model: args.model,
      sourceName: args.sourceName,
      fingerprint,
      joinKey: source.joinKey,
      pull,
      warnings,
      counts,
    });
    return finish({ ...base, ...counts, pulled });
  } catch (error) {
    const message =
      error instanceof SyncPassError
        ? error.message
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
    return finish({ ...base, ...counts, pulled, error: message });
  }
}

async function runPass(args: {
  appId: string;
  model: string;
  sourceName: string;
  source: SourceDef;
  invokedBy?: string;
}): Promise<SyncPassResult> {
  const key = `${args.appId}:${args.model}:${args.sourceName}`;
  if (inFlight.has(key)) {
    // A pass for this pair is already running: do not pull again.
    return scrubObject({
      ...passBase({
        model: args.model,
        source: args.sourceName,
        connector: args.source.connector,
        invokedBy: args.invokedBy,
      }),
      warnings: ["a sync pass for this pair is already running; this trigger did not pull"],
      skipped: true as const,
      alreadyRunning: true as const,
    });
  }
  const pass = executePass(args);
  inFlight.set(key, pass);
  try {
    return await pass;
  } finally {
    if (inFlight.get(key) === pass) inFlight.delete(key);
  }
}

function noPairIssue(input: { model?: string; source?: string }): AppValidationIssue {
  if (input.source !== undefined) {
    return {
      path: "source",
      message:
        input.model !== undefined
          ? `unknown source "${input.source}" on model "${input.model}"`
          : `unknown source "${input.source}" — no model declares it`,
    };
  }
  if (input.model !== undefined) {
    return { path: "model", message: `model "${input.model}" declares no sources` };
  }
  return { path: "appId", message: "no model declares a source to sync" };
}

/**
 * Run every `(model x source)` pair the input selects, sequentially. Each pass
 * pulls outside the per-(app, model) mutation lock and reconciles inside it.
 */
export async function runAppSync(input: {
  appId: string;
  model?: string;
  source?: string;
  invokedBy?: string;
}): Promise<AppSyncResult> {
  const app = await getApp(input.appId);
  if (!app) {
    return {
      ok: false,
      passes: [],
      issues: [{ path: "appId", message: `app "${input.appId}" not found` }],
    };
  }
  if (appDefinitionNeedsRepair(app)) {
    return {
      ok: false,
      passes: [],
      issues: [{ path: "definition", message: "app definition needs repair before it can sync" }],
    };
  }
  const models = app.definition.models;
  if (input.model !== undefined && !Object.hasOwn(models, input.model)) {
    return {
      ok: false,
      passes: [],
      issues: [{ path: "model", message: `unknown model "${input.model}"` }],
    };
  }

  const pairs = (input.model !== undefined ? [input.model] : Object.keys(models)).flatMap((model) =>
    Object.entries(models[model]?.sources ?? {})
      .filter(([sourceName]) => input.source === undefined || sourceName === input.source)
      .map(([sourceName, source]) => ({ model, sourceName, source })),
  );
  if (pairs.length === 0) {
    return { ok: false, passes: [], issues: [noPairIssue(input)] };
  }

  const passes: SyncPassResult[] = [];
  for (const pair of pairs) {
    passes.push(await runPass({ appId: app.id, ...pair, invokedBy: input.invokedBy }));
  }
  return { ok: passes.every((pass) => pass.error === undefined), passes };
}

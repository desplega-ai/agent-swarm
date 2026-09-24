/**
 * Assets an extension ships: scripts and schedules (workflows and skills come later).
 *
 * Two stages, because script checks spawn processes and must not hold the write lock:
 * `preflightAssets` runs outside any transaction and returns a write plan;
 * `reconcileAssets` runs inside the caller's transaction and only writes.
 *
 * Every asset the extension created has an `extension_assets` row. Its `seededHash`
 * lets upgrades and uninstall tell pristine rows (safe to update or delete) from rows
 * a user edited (kept, and reported). The rule is the seed runner's (`src/be/seed/runner.ts`).
 */
import { calculateNextRun } from "../../scheduler/scheduler";
import { extractScriptSignature } from "../../scripts-runtime/extract-signature";
import { validateScriptImports } from "../../scripts-runtime/import-allowlist";
import type { ExtensionManifest, ScheduledTask } from "../../types";
import {
  computeContentHash,
  createScheduledTask,
  deleteScheduledTask,
  getDbClient,
  getScheduledTaskByName,
  updateScheduledTask,
} from "../db";
import { deleteScript, getScript, upsertScriptByName } from "../scripts/db";
import { embedScript } from "../scripts/embeddings";
import { extractArgsJsonSchema } from "../scripts/extract-schema";
import { typecheckScript } from "../scripts/typecheck";

export type ExtensionAssetKind = "script" | "schedule" | "workflow" | "skill";

type ScriptPlan = {
  kind: "script";
  name: string;
  source: string;
  description: string;
  intent: string;
  signatureJson: string;
  argsJsonSchema: string | null;
  hash: string;
};

type ScheduleSpec = {
  name: string;
  description: string | null;
  scriptName: string;
  cronExpression: string | null;
  intervalMs: number | null;
  timezone: string;
  scriptArgs: Record<string, unknown>;
};

type SchedulePlan = { kind: "schedule"; name: string; spec: ScheduleSpec; hash: string };

export type AssetPlan = { scripts: ScriptPlan[]; schedules: SchedulePlan[] };

export type PreflightResult = { ok: true; plan: AssetPlan } | { ok: false; diagnostics: string[] };

export type AssetRef = { kind: ExtensionAssetKind; name: string };

export type ReconcileResult = {
  created: AssetRef[];
  updated: AssetRef[];
  /** Edited by a user since install: left as is. */
  skipped: AssetRef[];
  /** Dropped from the manifest and pristine: deleted. */
  deleted: AssetRef[];
  /** Dropped from the manifest but edited: kept and no longer tracked. */
  detached: AssetRef[];
};

export type RemoveResult = { deleted: AssetRef[]; detached: AssetRef[] };

type ExtensionAssetRow = {
  id: string;
  extensionId: string;
  kind: ExtensionAssetKind;
  assetId: string;
  name: string;
  seededHash: string;
  enabledBefore: number | null;
};

/** Raised inside the install transaction; rolls back every write. */
export class ExtensionAssetConflictError extends Error {
  constructor(readonly diagnostics: string[]) {
    super(diagnostics.join("\n"));
    this.name = "ExtensionAssetConflictError";
  }
}

// ─── Hashing (never includes enabled state) ─────────────────────────────────

function scheduleHash(spec: ScheduleSpec): string {
  return computeContentHash(
    JSON.stringify([
      spec.name,
      spec.description,
      spec.scriptName,
      spec.cronExpression,
      spec.intervalMs,
      spec.timezone,
      canonicalJson(spec.scriptArgs),
    ]),
  );
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function liveScheduleSpec(schedule: ScheduledTask): ScheduleSpec {
  return {
    name: schedule.name,
    // An update writes "" for a missing description; hash it as missing.
    description: schedule.description || null,
    scriptName: schedule.scriptName ?? "",
    cronExpression: schedule.cronExpression ?? null,
    intervalMs: schedule.intervalMs ?? null,
    timezone: schedule.timezone,
    scriptArgs: schedule.scriptArgs ?? {},
  };
}

// ─── Preflight (outside any transaction) ────────────────────────────────────

export async function preflightAssets(
  manifest: ExtensionManifest,
  files: Record<string, string>,
): Promise<PreflightResult> {
  const diagnostics: string[] = [];
  const scripts: ScriptPlan[] = [];
  for (const script of manifest.assets.scripts ?? []) {
    const source = files[script.file];
    if (source === undefined) {
      diagnostics.push(`script ${script.name}: file "${script.file}" is missing from the bundle`);
      continue;
    }
    const imports = validateScriptImports(source);
    if (!imports.ok) {
      diagnostics.push(`script ${script.name}: ${imports.diagnostic}`);
      continue;
    }
    const typecheck = await typecheckScript(source);
    if (!typecheck.ok) {
      diagnostics.push(
        ...typecheck.diagnostics.map((line) => `script ${script.name} (${script.file}): ${line}`),
      );
      continue;
    }
    scripts.push({
      kind: "script",
      name: script.name,
      source,
      description: script.description,
      intent: script.intent ?? script.description,
      signatureJson: JSON.stringify(extractScriptSignature(source)),
      argsJsonSchema: await extractArgsJsonSchema(source),
      hash: computeContentHash(source),
    });
  }

  const schedules: SchedulePlan[] = [];
  for (const schedule of manifest.assets.schedules ?? []) {
    const spec: ScheduleSpec = {
      name: schedule.name,
      description: schedule.description || null,
      scriptName: schedule.script,
      cronExpression: schedule.cronExpression ?? null,
      intervalMs: schedule.intervalMs ?? null,
      timezone: schedule.timezone ?? "UTC",
      scriptArgs: schedule.args ?? {},
    };
    try {
      calculateNextRun(timingOf(spec));
    } catch (error) {
      diagnostics.push(
        `schedule ${schedule.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    schedules.push({ kind: "schedule", name: schedule.name, spec, hash: scheduleHash(spec) });
  }

  return diagnostics.length > 0
    ? { ok: false, diagnostics }
    : { ok: true, plan: { scripts, schedules } };
}

function timingOf(spec: {
  cronExpression: string | null;
  intervalMs: number | null;
  timezone: string;
}): ScheduledTask {
  return {
    cronExpression: spec.cronExpression ?? undefined,
    intervalMs: spec.intervalMs ?? undefined,
    timezone: spec.timezone,
  } as ScheduledTask;
}

// ─── Adapters ───────────────────────────────────────────────────────────────

type Live = { id: string; hash: string };

async function findLiveScript(name: string): Promise<Live | null> {
  const script = await getScript({ name, scope: "global" });
  return script ? { id: script.id, hash: script.contentHash } : null;
}

async function findLiveSchedule(name: string): Promise<(Live & { row: ScheduledTask }) | null> {
  const schedule = await getScheduledTaskByName(name);
  return schedule
    ? { id: schedule.id, hash: scheduleHash(liveScheduleSpec(schedule)), row: schedule }
    : null;
}

async function writeScript(plan: ScriptPlan, agentId: string, actor: string | null) {
  const result = await upsertScriptByName({
    name: plan.name,
    scope: "global",
    scopeId: null,
    source: plan.source,
    description: plan.description,
    intent: plan.intent,
    signatureJson: plan.signatureJson,
    argsJsonSchema: plan.argsJsonSchema,
    fsMode: "none",
    agentId,
    isScratch: false,
    typeChecked: true,
    changeReason: "Installed by extension",
    embeddingMode: "skip",
    createdBy: actor,
  });
  // Embedding calls out to a provider; never inside the write lock.
  const script = result.script;
  getDbClient().afterCommit(() => embedScript(script));
  return script.id;
}

async function createSchedule(plan: SchedulePlan, agentId: string, actor: string | null) {
  const schedule = await createScheduledTask({
    name: plan.spec.name,
    description: plan.spec.description ?? undefined,
    cronExpression: plan.spec.cronExpression ?? undefined,
    intervalMs: plan.spec.intervalMs ?? undefined,
    timezone: plan.spec.timezone,
    targetType: "script",
    scriptName: plan.spec.scriptName,
    scriptArgs: plan.spec.scriptArgs,
    enabled: false,
    nextRunAt: undefined,
    createdByAgentId: agentId,
    createdBy: actor ?? undefined,
  });
  return schedule.id;
}

async function updateSchedule(plan: SchedulePlan, live: ScheduledTask, actor: string | null) {
  const spec = plan.spec;
  const timingChanged =
    (live.cronExpression ?? null) !== spec.cronExpression ||
    (live.intervalMs ?? null) !== spec.intervalMs ||
    live.timezone !== spec.timezone;
  await updateScheduledTask(live.id, {
    description: spec.description ?? "",
    cronExpression: spec.cronExpression,
    intervalMs: spec.intervalMs,
    timezone: spec.timezone,
    scriptName: spec.scriptName,
    scriptArgs: spec.scriptArgs,
    ...(live.enabled && timingChanged ? { nextRunAt: calculateNextRun(timingOf(spec)) } : {}),
    ...(actor ? { updatedBy: actor } : {}),
  });
}

// ─── Provenance ─────────────────────────────────────────────────────────────

async function listAssetRows(extensionId: string): Promise<ExtensionAssetRow[]> {
  return await getDbClient().query<ExtensionAssetRow>(
    "SELECT * FROM extension_assets WHERE extensionId = ? ORDER BY kind, name",
    [extensionId],
  );
}

async function upsertAssetRow(args: {
  extensionId: string;
  kind: ExtensionAssetKind;
  name: string;
  assetId: string;
  seededHash: string;
  enabledBefore: number | null;
  actor: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO extension_assets (
      id, extensionId, kind, assetId, name, seededHash, enabledBefore,
      created_by, updated_by, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(extensionId, kind, name) DO UPDATE SET
      assetId = excluded.assetId, seededHash = excluded.seededHash,
      enabledBefore = excluded.enabledBefore, updated_by = excluded.updated_by,
      updatedAt = excluded.updatedAt`,
    [
      crypto.randomUUID(),
      args.extensionId,
      args.kind,
      args.assetId,
      args.name,
      args.seededHash,
      args.enabledBefore,
      args.actor,
      args.actor,
      now,
      now,
    ],
  );
}

async function deleteAssetRow(id: string): Promise<void> {
  await getDbClient().run("DELETE FROM extension_assets WHERE id = ?", [id]);
}

async function deleteLive(row: ExtensionAssetRow): Promise<void> {
  if (row.kind === "script") await deleteScript({ name: row.name, scope: "global" });
  else if (row.kind === "schedule") await deleteScheduledTask(row.assetId);
}

async function findLive(kind: ExtensionAssetKind, name: string): Promise<Live | null> {
  if (kind === "script") return await findLiveScript(name);
  if (kind === "schedule") return await findLiveSchedule(name);
  return null;
}

// ─── Reconcile (inside the caller's transaction) ────────────────────────────

/**
 * Bring the extension's assets in line with `plan`. Must run inside a transaction:
 * a name collision throws `ExtensionAssetConflictError` and the caller's rollback
 * discards everything written so far, including the extension row.
 */
export async function reconcileAssets(args: {
  extensionId: string;
  agentId: string;
  plan: AssetPlan;
  actor?: string | null;
}): Promise<ReconcileResult> {
  const actor = args.actor ?? null;
  const result: ReconcileResult = {
    created: [],
    updated: [],
    skipped: [],
    deleted: [],
    detached: [],
  };
  const tracked = new Map(
    (await listAssetRows(args.extensionId)).map((row) => [`${row.kind}:${row.name}`, row]),
  );

  const conflicts: string[] = [];
  const desired = [...args.plan.scripts, ...args.plan.schedules];
  for (const item of desired) {
    if (tracked.has(`${item.kind}:${item.name}`)) continue;
    if (await findLive(item.kind, item.name)) {
      conflicts.push(
        `${item.kind} "${item.name}" already exists and does not belong to this extension`,
      );
    }
  }
  if (conflicts.length > 0) throw new ExtensionAssetConflictError(conflicts);

  // Scripts first: schedules refer to them by name.
  for (const item of desired) {
    const ref = { kind: item.kind, name: item.name };
    const row = tracked.get(`${item.kind}:${item.name}`);
    tracked.delete(`${item.kind}:${item.name}`);
    const live = await findLive(item.kind, item.name);

    if (row && live && live.hash === item.hash) {
      // Already what this version ships (possibly because a user made the same edit): adopt it.
      if (row.seededHash !== item.hash) {
        await upsertAssetRow({ ...row, seededHash: item.hash, actor });
      }
      continue;
    }
    if (row && live && live.hash !== row.seededHash) {
      result.skipped.push(ref);
      continue;
    }

    let assetId: string;
    if (item.kind === "script") {
      assetId = await writeScript(item, args.agentId, actor);
    } else if (live) {
      const schedule = await getScheduledTaskByName(item.name);
      if (!schedule) throw new Error(`schedule ${item.name} vanished during reconcile`);
      await updateSchedule(item, schedule, actor);
      assetId = schedule.id;
    } else {
      assetId = await createSchedule(item, args.agentId, actor);
    }
    await upsertAssetRow({
      extensionId: args.extensionId,
      kind: item.kind,
      name: item.name,
      assetId,
      seededHash: item.hash,
      enabledBefore: enabledBeforeAfterWrite(item.kind, Boolean(live), row),
      actor,
    });
    (live ? result.updated : result.created).push(ref);
  }

  // Rows the manifest no longer declares.
  for (const row of tracked.values()) {
    const outcome = await removeTrackedAsset(row);
    if (outcome) result[outcome].push({ kind: row.kind, name: row.name });
  }
  return result;
}

/** A (re)created schedule starts disabled and turns on at the next enable; an updated one keeps its state. */
function enabledBeforeAfterWrite(
  kind: ExtensionAssetKind,
  existed: boolean,
  row: ExtensionAssetRow | undefined,
): number | null {
  if (kind !== "schedule") return null;
  return existed ? (row?.enabledBefore ?? null) : 1;
}

async function removeTrackedAsset(row: ExtensionAssetRow): Promise<"deleted" | "detached" | null> {
  const live = await findLive(row.kind, row.name);
  await deleteAssetRow(row.id);
  if (!live) return null;
  if (live.hash !== row.seededHash) return "detached";
  await deleteLive(row);
  return "deleted";
}

// ─── Enable / disable / uninstall ───────────────────────────────────────────

/**
 * Pause or resume the extension's schedules. Disable records each schedule's live
 * state, so one a user turned off stays off after the next enable. Scripts have no
 * enabled state and are skipped.
 */
export async function setAssetsEnabled(
  extensionId: string,
  on: boolean,
  actor?: string | null,
): Promise<void> {
  await getDbClient().transaction(async () => {
    for (const row of await listAssetRows(extensionId)) {
      if (row.kind !== "schedule") continue;
      const schedule = await getScheduledTaskByName(row.name);
      if (!schedule || schedule.id !== row.assetId) continue;
      const now = new Date().toISOString();
      if (on) {
        // NULL: never paused by us, the live state is the user's. Leave it.
        if (row.enabledBefore === null) continue;
        const restore = row.enabledBefore === 1;
        if (restore !== schedule.enabled) {
          await updateScheduledTask(schedule.id, {
            enabled: restore,
            nextRunAt: restore ? calculateNextRun(schedule) : null,
            ...(actor ? { updatedBy: actor } : {}),
          });
        }
        await getDbClient().run(
          "UPDATE extension_assets SET enabledBefore = NULL, updated_by = ?, updatedAt = ? WHERE id = ?",
          [actor ?? null, now, row.id],
        );
      } else {
        // Already paused by us: keep the first recorded state.
        if (row.enabledBefore !== null) {
          if (schedule.enabled) {
            await updateScheduledTask(schedule.id, {
              enabled: false,
              nextRunAt: null,
              ...(actor ? { updatedBy: actor } : {}),
            });
          }
          continue;
        }
        await getDbClient().run(
          "UPDATE extension_assets SET enabledBefore = ?, updated_by = ?, updatedAt = ? WHERE id = ?",
          [schedule.enabled ? 1 : 0, actor ?? null, now, row.id],
        );
        if (schedule.enabled) {
          await updateScheduledTask(schedule.id, {
            enabled: false,
            nextRunAt: null,
            ...(actor ? { updatedBy: actor } : {}),
          });
        }
      }
    }
  });
}

/** Uninstall: delete pristine assets, detach edited ones. Call inside the delete transaction. */
export async function removeAssets(extensionId: string): Promise<RemoveResult> {
  const result: RemoveResult = { deleted: [], detached: [] };
  // Schedules before the scripts they call.
  const rows = (await listAssetRows(extensionId)).sort(
    (a, b) => Number(a.kind === "script") - Number(b.kind === "script"),
  );
  for (const row of rows) {
    const outcome = await removeTrackedAsset(row);
    if (outcome) result[outcome].push({ kind: row.kind, name: row.name });
  }
  return result;
}

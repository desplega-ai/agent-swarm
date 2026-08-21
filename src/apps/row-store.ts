import { deleteKv, getDbClient, getKv, listKv, upsertKv } from "../be/db";
import {
  AppDefinitionSchema,
  type AppValidationIssue,
  type ColumnDef,
  isIso8601Date,
  type ModelDef,
} from "./definition";
import { upgradeAppDefinition } from "./format-upgrades";

export type AppRow = {
  id: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  /** Sync provenance — present only on rows a source owns. */
  source?: string;
  syncedAt?: string;
  stale?: boolean;
} & Record<string, unknown>;

export type AppRowEnvelope = { source: string; syncedAt: string; stale: boolean };

export interface AppRowWriteOptions {
  skipUpdatedAt?: boolean;
  /**
   * Stable id of the acting principal (`user:<id>`, `agent:<id>`, `operator`,
   * or `sync:<source>` for engine writes) for row provenance.
   */
  actor?: string;
  /**
   * Sync-engine escape hatch. External write paths leave this false so
   * source-bound and join-key columns stay read-only projections.
   */
  allowSourceManaged?: boolean;
  /** Row provenance stamped after value preparation; honoured only with `allowSourceManaged`. */
  envelope?: AppRowEnvelope;
}

export class AppRowValidationError extends Error {
  readonly issues: AppValidationIssue[];

  constructor(issues: AppValidationIssue[]) {
    super("invalid row values");
    this.name = "AppRowValidationError";
    this.issues = issues;
  }
}

export class AppRowAppNotFoundError extends Error {
  constructor(appId: string) {
    super(`app "${appId}" not found`);
    this.name = "AppRowAppNotFoundError";
  }
}

const mutationChains = new Map<string, Promise<unknown>>();
let lastCreatedAtMs = 0;

export function appsNamespace(appId: string): string {
  return `apps:${appId}`;
}

function rowKey(model: string, rowId: string): string {
  return `${model}/row/${rowId}`;
}

function encodedIndexValue(value: unknown): string {
  const wellFormed = Array.from(String(value), (character) => {
    const codePoint = character.charCodeAt(0);
    return character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff
      ? "\uFFFD"
      : character;
  }).join("");
  return encodeURIComponent(wellFormed)
    .replace(/[!'()*~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .slice(0, 128);
}

export function appIndexKey(model: string, column: string, value: unknown, rowId: string): string {
  return `${model}/idx/${column}/${encodedIndexValue(value)}/${rowId}`;
}

function isIndexed(column: ColumnDef): boolean {
  if (column.hidden === true) return false;
  if (column.kind === "enum") return true;
  return column.index === true && (column.kind === "string" || column.kind === "boolean");
}

function indexKeys(model: string, definition: ModelDef, row: AppRow): string[] {
  const keys: string[] = [];
  for (const [columnName, column] of Object.entries(definition.columns)) {
    const value = Object.hasOwn(row, columnName) ? row[columnName] : undefined;
    if (isIndexed(column) && value !== undefined && value !== null) {
      keys.push(appIndexKey(model, columnName, value, row.id));
    }
  }
  return keys;
}

function validValue(column: ColumnDef, value: unknown): boolean {
  if (value === null) return column.required !== true;
  if (column.kind === "string") return typeof value === "string";
  if (column.kind === "number") return typeof value === "number" && Number.isFinite(value);
  if (column.kind === "boolean") return typeof value === "boolean";
  if (column.kind === "date") return typeof value === "string" && isIso8601Date(value);
  return typeof value === "string" && Boolean(column.enum?.includes(value));
}

function joinKeyColumnNames(definition: ModelDef): Set<string> {
  const names = new Set<string>();
  for (const source of Object.values(definition.sources ?? {})) names.add(source.joinKey);
  return names;
}

/** Row provenance to stamp, when the caller is the sync engine. */
function sourceEnvelope(options: AppRowWriteOptions): AppRowEnvelope | undefined {
  return options.allowSourceManaged === true ? options.envelope : undefined;
}

function prepareValues(
  definition: ModelDef,
  values: Record<string, unknown>,
  mode: "create" | "patch",
  options: AppRowWriteOptions = {},
): Record<string, unknown> {
  const issues: AppValidationIssue[] = [];
  const prepared: Record<string, unknown> = { ...values };
  const sourceManaged = options.allowSourceManaged === true;
  if (sourceManaged && !options.envelope) {
    // Without provenance the privileged write would produce a row
    // indistinguishable from a user-owned one.
    throw new Error("allowSourceManaged writes must carry an envelope");
  }
  const joinKeys = sourceManaged ? new Set<string>() : joinKeyColumnNames(definition);

  for (const name of Object.keys(values)) {
    const column = Object.hasOwn(definition.columns, name) ? definition.columns[name] : undefined;
    if (!column || column.hidden === true) {
      issues.push({ path: `values.${name}`, message: `unknown or hidden column "${name}"` });
      continue;
    }
    if (sourceManaged) continue;
    if (column.source) {
      issues.push({
        path: `values.${name}`,
        message: `column is a read-only projection from source "${column.source.of}"; mutate it via the source or a sync refresh`,
      });
    } else if (joinKeys.has(name)) {
      issues.push({
        path: `values.${name}`,
        message: "column is the sync join key and is managed by the sync engine",
      });
    }
  }

  if (mode === "create") {
    for (const [name, column] of Object.entries(definition.columns)) {
      if (column.hidden === true) continue;
      if (!Object.hasOwn(prepared, name) && column.default !== undefined)
        prepared[name] = column.default;
      // A source pull supplies only the fields the record carried; a bound
      // column with no projected value is the source's business, not the row's.
      if (sourceManaged && column.source) continue;
      if (
        column.required === true &&
        (!Object.hasOwn(prepared, name) || prepared[name] === undefined || prepared[name] === null)
      ) {
        issues.push({ path: `values.${name}`, message: "required column is missing" });
      }
    }
  }

  for (const [name, value] of Object.entries(prepared)) {
    if (!Object.hasOwn(definition.columns, name)) continue;
    const column = definition.columns[name]!;
    if (!validValue(column, value)) {
      issues.push({ path: `values.${name}`, message: `must be a valid ${column.kind} value` });
    }
  }

  if (issues.length > 0) throw new AppRowValidationError(issues);
  return prepared;
}

/**
 * Lock ordering: this per-app/model lock is always acquired BEFORE the DbClient
 * transaction lock, never the other way round. Awaiting `withMutationLock` (or
 * anything that calls it, such as `purgeAppRows`) from inside an open client
 * transaction inverts that order and deadlocks.
 */
export function withMutationLock<T>(
  appId: string,
  model: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const lockKey = `${appId}:${model}`;
  const previous = mutationChains.get(lockKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  mutationChains.set(lockKey, current);
  return current.finally(() => {
    if (mutationChains.get(lockKey) === current) mutationChains.delete(lockKey);
  });
}

async function writeRow(
  appId: string,
  model: string,
  definition: ModelDef,
  row: AppRow,
): Promise<AppRow> {
  const namespace = appsNamespace(appId);
  await upsertKv({ namespace, key: rowKey(model, row.id), value: row, valueType: "json" });
  for (const key of indexKeys(model, definition, row)) {
    await upsertKv({ namespace, key, value: "1", valueType: "json" });
  }
  return row;
}

async function appExists(appId: string): Promise<boolean> {
  const row = await getDbClient().get<{ present: number }>(
    "SELECT 1 AS present FROM apps WHERE id = ?",
    [appId],
  );
  return row !== null;
}

async function currentModelDefinition(appId: string, model: string): Promise<ModelDef | null> {
  const row = await getDbClient().get<{ definition: string }>(
    "SELECT definition FROM apps WHERE id = ?",
    [appId],
  );
  if (!row) return null;
  try {
    const definition = AppDefinitionSchema.safeParse(
      upgradeAppDefinition(JSON.parse(row.definition)),
    );
    return definition.success && Object.hasOwn(definition.data.models, model)
      ? (definition.data.models[model] ?? null)
      : null;
  } catch {
    return null;
  }
}

async function createRowUnlocked(
  appId: string,
  model: string,
  definition: ModelDef,
  prepared: Record<string, unknown>,
  options: AppRowWriteOptions,
): Promise<AppRow> {
  const issuedMs = Math.max(Date.now(), lastCreatedAtMs + 1);
  lastCreatedAtMs = issuedMs;
  const now = new Date(issuedMs).toISOString();
  const actor = options.actor;
  return writeRow(appId, model, definition, {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    ...(actor !== undefined ? { createdBy: actor, updatedBy: actor } : {}),
    ...prepared,
    ...sourceEnvelope(options),
  });
}

/** Caller must already hold the app/model mutation lock. */
export async function createAppRowUnlocked(
  appId: string,
  model: string,
  definition: ModelDef,
  values: Record<string, unknown>,
  options: AppRowWriteOptions = {},
): Promise<AppRow> {
  const prepared = prepareValues(definition, values, "create", options);
  if (!(await appExists(appId))) throw new AppRowAppNotFoundError(appId);
  return createRowUnlocked(appId, model, definition, prepared, options);
}

export function createAppRow(
  appId: string,
  model: string,
  _definition: ModelDef,
  values: Record<string, unknown>,
  options: AppRowWriteOptions = {},
): Promise<AppRow> {
  return withMutationLock(appId, model, async () => {
    const currentDefinition = await currentModelDefinition(appId, model);
    if (!currentDefinition) throw new AppRowAppNotFoundError(appId);
    const prepared = prepareValues(currentDefinition, values, "create", options);
    return createRowUnlocked(appId, model, currentDefinition, prepared, options);
  });
}

export function createAppRows(
  appId: string,
  model: string,
  _definition: ModelDef,
  rows: Array<Record<string, unknown>>,
  options: AppRowWriteOptions = {},
): Promise<AppRow[]> {
  return withMutationLock(appId, model, async () => {
    const currentDefinition = await currentModelDefinition(appId, model);
    if (!currentDefinition) throw new AppRowAppNotFoundError(appId);
    const prepared = rows.map((values) =>
      prepareValues(currentDefinition, values, "create", options),
    );
    const created: AppRow[] = [];
    for (const values of prepared) {
      created.push(await createRowUnlocked(appId, model, currentDefinition, values, options));
    }
    return created;
  });
}

export async function getAppRow(
  appId: string,
  model: string,
  rowId: string,
): Promise<AppRow | null> {
  const entry = await getKv(appsNamespace(appId), rowKey(model, rowId));
  if (
    !entry ||
    typeof entry.value !== "object" ||
    entry.value === null ||
    Array.isArray(entry.value)
  ) {
    return null;
  }
  return entry.value as AppRow;
}

export async function listAppRows(appId: string, model: string): Promise<AppRow[]> {
  const entries = await listKv(appsNamespace(appId), {
    prefix: `${model}/row/`,
    limit: 100000,
    offset: 0,
  });
  return entries
    .map((entry) => entry.value)
    .filter(
      (value): value is AppRow =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    );
}

const MIGRATION_KV_BATCH_SIZE = 1000;

/** Caller must already hold the app/model mutation lock. */
export async function listAllAppRowsForMigrationUnlocked(
  appId: string,
  model: string,
): Promise<AppRow[]> {
  const rows: AppRow[] = [];
  const namespace = appsNamespace(appId);
  const prefix = `${model}/row/`;
  let offset = 0;
  while (true) {
    const entries = await listKv(namespace, { prefix, limit: MIGRATION_KV_BATCH_SIZE, offset });
    for (const entry of entries) {
      const value = entry.value;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        rows.push(value as AppRow);
      }
    }
    if (entries.length < MIGRATION_KV_BATCH_SIZE) return rows;
    offset += entries.length;
  }
}

export function patchAppRow(
  appId: string,
  model: string,
  _definition: ModelDef,
  rowId: string,
  values: Record<string, unknown>,
  options: AppRowWriteOptions = {},
): Promise<AppRow | null> {
  return withMutationLock(appId, model, async () => {
    const currentDefinition = await currentModelDefinition(appId, model);
    if (!currentDefinition) throw new AppRowAppNotFoundError(appId);
    const prepared = prepareValues(currentDefinition, values, "patch", options);
    return patchPreparedRowUnlocked(appId, model, currentDefinition, rowId, prepared, options);
  });
}

async function patchPreparedRowUnlocked(
  appId: string,
  model: string,
  definition: ModelDef,
  rowId: string,
  prepared: Record<string, unknown>,
  options: AppRowWriteOptions,
): Promise<AppRow | null> {
  if (!(await appExists(appId))) return null;
  const existing = await getAppRow(appId, model, rowId);
  if (!existing) return null;
  const oldKeys = new Set(indexKeys(model, definition, existing));
  const previousMs = Date.parse(existing.updatedAt);
  const updatedAt =
    options.skipUpdatedAt === true
      ? existing.updatedAt
      : new Date(Math.max(Date.now(), previousMs + 1)).toISOString();
  const updated: AppRow = { ...existing, id: existing.id, updatedAt };
  if (options.actor !== undefined && options.skipUpdatedAt !== true) {
    updated.updatedBy = options.actor;
  }
  for (const [name, value] of Object.entries(prepared)) {
    if (value === null) {
      delete updated[name];
    } else {
      updated[name] = value;
    }
  }
  Object.assign(updated, sourceEnvelope(options));
  const newKeys = new Set(indexKeys(model, definition, updated));
  const namespace = appsNamespace(appId);
  for (const key of oldKeys) if (!newKeys.has(key)) await deleteKv(namespace, key);
  await upsertKv({ namespace, key: rowKey(model, rowId), value: updated, valueType: "json" });
  for (const key of newKeys) {
    if (!oldKeys.has(key)) await upsertKv({ namespace, key, value: "1", valueType: "json" });
  }
  return updated;
}

/** Caller must already hold the app/model mutation lock. */
export async function patchAppRowUnlocked(
  appId: string,
  model: string,
  definition: ModelDef,
  rowId: string,
  values: Record<string, unknown>,
  options: AppRowWriteOptions = {},
): Promise<AppRow | null> {
  const prepared = prepareValues(definition, values, "patch", options);
  return patchPreparedRowUnlocked(appId, model, definition, rowId, prepared, options);
}

/**
 * Caller must already hold the app/model mutation lock.
 */
export async function writeAppRowForMigrationUnlocked(
  appId: string,
  model: string,
  row: AppRow,
): Promise<void> {
  await upsertKv({
    namespace: appsNamespace(appId),
    key: rowKey(model, row.id),
    value: row,
    valueType: "json",
  });
}

/** Caller must already hold the app/model mutation lock. */
export async function rebuildAppColumnIndexUnlocked(
  appId: string,
  model: string,
  columnName: string,
  column: ColumnDef | undefined,
  rows: AppRow[],
): Promise<void> {
  const namespace = appsNamespace(appId);
  const prefix = `${model}/idx/${columnName}/`;
  while (true) {
    const keys = (
      await listKv(namespace, { prefix, limit: MIGRATION_KV_BATCH_SIZE, offset: 0 })
    ).map((entry) => entry.key);
    if (keys.length === 0) break;
    for (const key of keys) await deleteKv(namespace, key);
  }
  if (!column || !isIndexed(column)) return;
  for (const row of rows) {
    if (!Object.hasOwn(row, columnName)) continue;
    const value = row[columnName];
    if (value === undefined || value === null) continue;
    await upsertKv({
      namespace,
      key: appIndexKey(model, columnName, value, row.id),
      value: "1",
      valueType: "json",
    });
  }
}

export function deleteAppRow(
  appId: string,
  model: string,
  _definition: ModelDef,
  rowId: string,
): Promise<boolean> {
  return withMutationLock(appId, model, async () => {
    const currentDefinition = await currentModelDefinition(appId, model);
    if (!currentDefinition) return false;
    const namespace = appsNamespace(appId);
    const row = await getAppRow(appId, model, rowId);
    if (!row) return false;
    for (const key of indexKeys(model, currentDefinition, row)) await deleteKv(namespace, key);
    await deleteKv(namespace, rowKey(model, rowId));
    return true;
  });
}

async function purgeNamespace(appId: string): Promise<void> {
  const namespace = appsNamespace(appId);
  while (true) {
    const entries = await listKv(namespace, { prefix: "", limit: 100000, offset: 0 });
    if (entries.length === 0) return;
    for (const entry of entries) await deleteKv(namespace, entry.key);
  }
}

export function purgeAppRows(
  appId: string,
  models: string[],
  afterPurge?: () => void | Promise<void>,
): Promise<void> {
  const lockNames = models.length > 0 ? [...new Set(models)].sort() : ["*"];
  const acquire = (index: number): Promise<void> => {
    if (index >= lockNames.length) {
      // Purge KV first while every model lock is held. If the purge is
      // interrupted, the relational app remains reachable and deletion can be
      // retried instead of leaving orphaned KV entries.
      return (async () => {
        await purgeNamespace(appId);
        await afterPurge?.();
      })();
    }
    return withMutationLock(appId, lockNames[index]!, () => acquire(index + 1));
  };
  return acquire(0);
}

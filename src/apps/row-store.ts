import { deleteKv, getDb, getKv, listKv, upsertKv } from "../be/db";
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
} & Record<string, unknown>;

export interface AppRowWriteOptions {
  skipUpdatedAt?: boolean;
  /** Stable id of the acting principal (`user:<id>`, `agent:<id>`, `operator`) for row provenance. */
  actor?: string;
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

function prepareValues(
  definition: ModelDef,
  values: Record<string, unknown>,
  mode: "create" | "patch",
): Record<string, unknown> {
  const issues: AppValidationIssue[] = [];
  const prepared: Record<string, unknown> = { ...values };

  for (const name of Object.keys(values)) {
    const column = Object.hasOwn(definition.columns, name) ? definition.columns[name] : undefined;
    if (!column || column.hidden === true) {
      issues.push({ path: `values.${name}`, message: `unknown or hidden column "${name}"` });
    }
  }

  if (mode === "create") {
    for (const [name, column] of Object.entries(definition.columns)) {
      if (column.hidden === true) continue;
      if (!Object.hasOwn(prepared, name) && column.default !== undefined)
        prepared[name] = column.default;
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

function writeRow(appId: string, model: string, definition: ModelDef, row: AppRow): AppRow {
  const namespace = appsNamespace(appId);
  upsertKv({ namespace, key: rowKey(model, row.id), value: row, valueType: "json" });
  for (const key of indexKeys(model, definition, row)) {
    upsertKv({ namespace, key, value: "1", valueType: "json" });
  }
  return row;
}

function appExists(appId: string): boolean {
  return (
    getDb()
      .prepare<{ present: number }, [string]>("SELECT 1 AS present FROM apps WHERE id = ?")
      .get(appId) !== null
  );
}

function currentModelDefinition(appId: string, model: string): ModelDef | null {
  const row = getDb()
    .prepare<{ definition: string }, [string]>("SELECT definition FROM apps WHERE id = ?")
    .get(appId);
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

function createRowUnlocked(
  appId: string,
  model: string,
  definition: ModelDef,
  prepared: Record<string, unknown>,
  actor?: string,
): AppRow {
  const issuedMs = Math.max(Date.now(), lastCreatedAtMs + 1);
  lastCreatedAtMs = issuedMs;
  const now = new Date(issuedMs).toISOString();
  return writeRow(appId, model, definition, {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    ...(actor !== undefined ? { createdBy: actor, updatedBy: actor } : {}),
    ...prepared,
  });
}

/** Caller must already hold the app/model mutation lock. */
export function createAppRowUnlocked(
  appId: string,
  model: string,
  definition: ModelDef,
  values: Record<string, unknown>,
  options: AppRowWriteOptions = {},
): AppRow {
  const prepared = prepareValues(definition, values, "create");
  if (!appExists(appId)) throw new AppRowAppNotFoundError(appId);
  return createRowUnlocked(appId, model, definition, prepared, options.actor);
}

export function createAppRow(
  appId: string,
  model: string,
  _definition: ModelDef,
  values: Record<string, unknown>,
  options: AppRowWriteOptions = {},
): Promise<AppRow> {
  return withMutationLock(appId, model, () => {
    const currentDefinition = currentModelDefinition(appId, model);
    if (!currentDefinition) throw new AppRowAppNotFoundError(appId);
    const prepared = prepareValues(currentDefinition, values, "create");
    return createRowUnlocked(appId, model, currentDefinition, prepared, options.actor);
  });
}

export function createAppRows(
  appId: string,
  model: string,
  _definition: ModelDef,
  rows: Array<Record<string, unknown>>,
  options: AppRowWriteOptions = {},
): Promise<AppRow[]> {
  return withMutationLock(appId, model, () => {
    const currentDefinition = currentModelDefinition(appId, model);
    if (!currentDefinition) throw new AppRowAppNotFoundError(appId);
    const prepared = rows.map((values) => prepareValues(currentDefinition, values, "create"));
    return prepared.map((values) =>
      createRowUnlocked(appId, model, currentDefinition, values, options.actor),
    );
  });
}

export function getAppRow(appId: string, model: string, rowId: string): AppRow | null {
  const entry = getKv(appsNamespace(appId), rowKey(model, rowId));
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

export function listAppRows(appId: string, model: string): AppRow[] {
  return listKv(appsNamespace(appId), { prefix: `${model}/row/`, limit: 100000, offset: 0 })
    .map((entry) => entry.value)
    .filter(
      (value): value is AppRow =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    );
}

const MIGRATION_KV_BATCH_SIZE = 1000;

/** Caller must already hold the app/model mutation lock. */
export function listAllAppRowsForMigrationUnlocked(appId: string, model: string): AppRow[] {
  const rows: AppRow[] = [];
  const namespace = appsNamespace(appId);
  const prefix = `${model}/row/`;
  let offset = 0;
  while (true) {
    const entries = listKv(namespace, { prefix, limit: MIGRATION_KV_BATCH_SIZE, offset });
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
  return withMutationLock(appId, model, () => {
    const currentDefinition = currentModelDefinition(appId, model);
    if (!currentDefinition) throw new AppRowAppNotFoundError(appId);
    const prepared = prepareValues(currentDefinition, values, "patch");
    return patchPreparedRowUnlocked(appId, model, currentDefinition, rowId, prepared, options);
  });
}

function patchPreparedRowUnlocked(
  appId: string,
  model: string,
  definition: ModelDef,
  rowId: string,
  prepared: Record<string, unknown>,
  options: AppRowWriteOptions,
): AppRow | null {
  if (!appExists(appId)) return null;
  const existing = getAppRow(appId, model, rowId);
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
  const newKeys = new Set(indexKeys(model, definition, updated));
  const namespace = appsNamespace(appId);
  for (const key of oldKeys) if (!newKeys.has(key)) deleteKv(namespace, key);
  upsertKv({ namespace, key: rowKey(model, rowId), value: updated, valueType: "json" });
  for (const key of newKeys) {
    if (!oldKeys.has(key)) upsertKv({ namespace, key, value: "1", valueType: "json" });
  }
  return updated;
}

/** Caller must already hold the app/model mutation lock. */
export function patchAppRowUnlocked(
  appId: string,
  model: string,
  definition: ModelDef,
  rowId: string,
  values: Record<string, unknown>,
  options: AppRowWriteOptions = {},
): AppRow | null {
  const prepared = prepareValues(definition, values, "patch");
  return patchPreparedRowUnlocked(appId, model, definition, rowId, prepared, options);
}

/** Caller must already hold the app/model mutation lock. */
export function writeAppRowForMigrationUnlocked(appId: string, model: string, row: AppRow): void {
  upsertKv({
    namespace: appsNamespace(appId),
    key: rowKey(model, row.id),
    value: row,
    valueType: "json",
  });
}

/** Caller must already hold the app/model mutation lock. */
export function rebuildAppColumnIndexUnlocked(
  appId: string,
  model: string,
  columnName: string,
  column: ColumnDef | undefined,
  rows: AppRow[],
): void {
  const namespace = appsNamespace(appId);
  const prefix = `${model}/idx/${columnName}/`;
  while (true) {
    const entries = listKv(namespace, {
      prefix,
      limit: MIGRATION_KV_BATCH_SIZE,
      offset: 0,
    });
    if (entries.length === 0) break;
    for (const entry of entries) deleteKv(namespace, entry.key);
  }
  if (!column || !isIndexed(column)) return;
  for (const row of rows) {
    if (!Object.hasOwn(row, columnName)) continue;
    const value = row[columnName];
    if (value === undefined || value === null) continue;
    upsertKv({
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
  return withMutationLock(appId, model, () => {
    const currentDefinition = currentModelDefinition(appId, model);
    if (!currentDefinition) return false;
    const namespace = appsNamespace(appId);
    const row = getAppRow(appId, model, rowId);
    if (!row) return false;
    for (const key of indexKeys(model, currentDefinition, row)) deleteKv(namespace, key);
    deleteKv(namespace, rowKey(model, rowId));
    return true;
  });
}

function purgeNamespace(appId: string): void {
  const namespace = appsNamespace(appId);
  while (true) {
    const entries = listKv(namespace, { prefix: "", limit: 100000, offset: 0 });
    if (entries.length === 0) return;
    for (const entry of entries) deleteKv(namespace, entry.key);
  }
}

export function purgeAppRows(
  appId: string,
  models: string[],
  afterPurge?: () => void,
): Promise<void> {
  const lockNames = models.length > 0 ? [...new Set(models)].sort() : ["*"];
  const acquire = (index: number): Promise<void> => {
    if (index >= lockNames.length) {
      // Purge KV first while every model lock is held. If the purge is
      // interrupted, the relational app remains reachable and deletion can be
      // retried instead of leaving orphaned KV entries.
      purgeNamespace(appId);
      afterPurge?.();
      return Promise.resolve();
    }
    return withMutationLock(appId, lockNames[index]!, () => acquire(index + 1));
  };
  return acquire(0);
}

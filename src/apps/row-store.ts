import {
  deleteKv,
  getKv,
  kvPrefixUpperBound,
  listKv,
  literalPrefixPattern,
  upsertKv,
} from "../be/db";
import { deleteKvMany, getKvMany, upsertKvMany } from "../be/db/kv";
import { kvKeyAfter } from "../be/db/kv-windows";
import { isInTransaction } from "../be/db-client";
import { getStorage } from "../be/storage";
import { removeNamespaceFamilyRooms } from "../realtime/rooms";
import {
  AppDefinitionSchema,
  type AppValidationIssue,
  type ColumnDef,
  isIso8601Date,
  isValidColumnValue,
  jsonColumnSizeLabel,
  jsonColumnValueIssue,
  type ModelDef,
} from "./definition";
import { upgradeAppDefinition } from "./format-upgrades";
import { publishAppRowsChanged } from "./realtime-events";

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

/**
 * Let queued I/O and other requests run. DB calls are synchronous, so a loop
 * of awaited statements otherwise only drains microtasks and holds the event
 * loop until it finishes.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
  if (column.kind === "json") return false;
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

export function validValue(column: ColumnDef, value: unknown): boolean {
  if (value === null) return column.required !== true;
  return isValidColumnValue(column, value);
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
    if (column.kind === "json" && value !== null) {
      // Asked directly so the value is serialized once and the size cap gets its own message.
      const issue = jsonColumnValueIssue(value);
      if (issue === "unserializable") {
        issues.push({ path: `values.${name}`, message: "must be a valid json value" });
      } else if (issue === "non-finite") {
        issues.push({ path: `values.${name}`, message: "json value contains a non-finite number" });
      } else if (issue === "oversized") {
        issues.push({
          path: `values.${name}`,
          message: `json value exceeds the ${jsonColumnSizeLabel()} size limit`,
        });
      }
    } else if (!validValue(column, value)) {
      issues.push({ path: `values.${name}`, message: `must be a valid ${column.kind} value` });
    }
  }

  if (issues.length > 0) throw new AppRowValidationError(issues);
  return prepared;
}

/**
 * One DbClient transaction for the KV writes of one request: a row key plus its
 * index keys, or every row of a bulk request. Each autocommit write is its own
 * commit, and a commit on Postgres waits for a WAL flush. Call it only while the
 * mutation lock is held (see the lock ordering below). A Postgres serialization
 * failure runs the callback again, whole, so the callback must have no side
 * effect outside the database.
 */
function inRowTransaction<T>(operation: () => Promise<T>): Promise<T> {
  return getStorage().transaction(operation);
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
  // Every row write runs under this lock: tell open app surfaces once it lands.
  const current = previous
    .catch(() => undefined)
    .then(operation)
    .then((result) => {
      if (model !== "*") publishAppRowsChanged(appId, model);
      return result;
    });
  mutationChains.set(lockKey, current);
  return current.finally(() => {
    if (mutationChains.get(lockKey) === current) mutationChains.delete(lockKey);
  });
}

type KvWrite = Parameters<typeof upsertKvMany>[0][number];

function indexEntry(namespace: string, key: string): KvWrite {
  return { namespace, key, value: "1", valueType: "json" };
}

/** The row key plus its index keys, for one multi-row upsert. */
function rowEntries(
  namespace: string,
  model: string,
  definition: ModelDef,
  row: AppRow,
): KvWrite[] {
  return [
    { namespace, key: rowKey(model, row.id), value: row, valueType: "json" },
    ...indexKeys(model, definition, row).map((key) => indexEntry(namespace, key)),
  ];
}

/**
 * Whether the app row exists. A caller that writes many rows in one
 * transaction (sync chunks) reads it once and passes the answer down.
 */
export async function appExists(appId: string): Promise<boolean> {
  return getStorage().repos.pages.appExists(appId);
}

async function currentModelDefinition(appId: string, model: string): Promise<ModelDef | null> {
  const definitionJson = await getStorage().repos.pages.getAppDefinition(appId);
  if (definitionJson === null) return null;
  const row = { definition: definitionJson };
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

function newRow(prepared: Record<string, unknown>, options: AppRowWriteOptions): AppRow {
  const issuedMs = Math.max(Date.now(), lastCreatedAtMs + 1);
  lastCreatedAtMs = issuedMs;
  const now = new Date(issuedMs).toISOString();
  const actor = options.actor;
  return {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    ...(actor !== undefined ? { createdBy: actor, updatedBy: actor } : {}),
    ...prepared,
    ...sourceEnvelope(options),
  };
}

async function createRowUnlocked(
  appId: string,
  model: string,
  definition: ModelDef,
  prepared: Record<string, unknown>,
  options: AppRowWriteOptions,
): Promise<AppRow> {
  const row = newRow(prepared, options);
  await upsertKvMany(rowEntries(appsNamespace(appId), model, definition, row));
  return row;
}

/**
 * Caller must already hold the app/model mutation lock. `appPresent` is an
 * `appExists` answer read earlier in the same transaction; without it the
 * check runs here.
 */
export async function createAppRowUnlocked(
  appId: string,
  model: string,
  definition: ModelDef,
  values: Record<string, unknown>,
  options: AppRowWriteOptions = {},
  appPresent?: boolean,
): Promise<AppRow> {
  const prepared = prepareValues(definition, values, "create", options);
  if (!(appPresent ?? (await appExists(appId)))) throw new AppRowAppNotFoundError(appId);
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
    return inRowTransaction(() =>
      createRowUnlocked(appId, model, currentDefinition, prepared, options),
    );
  });
}

/**
 * All or nothing: the rows are validated before the first write, and the writes
 * share one transaction, so a database error leaves no row of the request.
 */
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
    return inRowTransaction(async () => {
      // A retried attempt starts again with new row ids and timestamps.
      const created = prepared.map((values) => newRow(values, options));
      const namespace = appsNamespace(appId);
      await upsertKvMany(
        created.flatMap((row) => rowEntries(namespace, model, currentDefinition, row)),
      );
      return created;
    });
  });
}

export async function getAppRow(
  appId: string,
  model: string,
  rowId: string,
): Promise<AppRow | null> {
  return asAppRow((await getKv(appsNamespace(appId), rowKey(model, rowId)))?.value);
}

/** A stored row value, or null when it is not a JSON object. */
function asAppRow(value: unknown): AppRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as AppRow;
}

/** Rows one `listAppRows` statement scans. A full-model scan was one 0.5 s+ sync stall. */
const LIST_SCAN_WINDOW = 2000;
const LIST_ROW_CAP = 100000;
/** Index keys a filtered list will follow; a bigger bucket is cheaper to scan than to point-read. */
const INDEX_LIST_MAX_KEYS = 20000;
const INDEX_FETCH_BATCH = 500;

/**
 * Row ids behind the smallest equality-filter bucket of an indexed column, in
 * row-id order, or null when no filter is indexed or every bucket is too big.
 * Index values are truncated and SQL equality is loose, so the ids are a
 * superset of the matches.
 */
async function indexedRowIds(
  namespace: string,
  model: string,
  columns: Record<string, ColumnDef>,
  equals: Array<{ column: string; value: string | number | boolean }>,
): Promise<string[] | null> {
  let best: string[] | null = null;
  for (const { column, value } of equals) {
    if (typeof value === "number" || column.includes("/")) continue;
    const definition = Object.hasOwn(columns, column) ? columns[column] : undefined;
    if (!definition || !isIndexed(definition)) continue;
    const prefix = appIndexKey(model, column, value, "");
    const keys = await getStorage().repos.kv.listLiveKeys(
      namespace,
      prefix,
      kvPrefixUpperBound(prefix)!,
      Date.now(),
      INDEX_LIST_MAX_KEYS + 1,
    );
    if (keys.length > INDEX_LIST_MAX_KEYS) continue;
    if (best === null || keys.length < best.length) {
      best = keys.map((key) => key.slice(key.lastIndexOf("/") + 1));
    }
  }
  return best;
}

/**
 * `equals` pre-filters rows in SQL on top-level fields so a filtered list
 * does not decode the whole model. The match is looser than `===` (JSON
 * `true` equals `1`); callers re-check the returned rows.
 *
 * The scan runs in key windows with a yield between them: one statement over
 * a six-figure model blocks the event loop for every other request.
 *
 * With `columns`, an equality filter on an indexed column reads that column's
 * index keys and fetches only those rows instead of scanning the model. The
 * rows are then a superset of the matches (other filters are not applied).
 */
export async function listAppRows(
  appId: string,
  model: string,
  equals: Array<{ column: string; value: string | number | boolean }> = [],
  columns?: Record<string, ColumnDef>,
): Promise<AppRow[]> {
  const namespace = appsNamespace(appId);
  const prefix = `${model}/row/`;
  const ids = columns ? await indexedRowIds(namespace, model, columns, equals) : null;
  if (ids) {
    const rows: AppRow[] = [];
    for (let start = 0; start < ids.length; start += INDEX_FETCH_BATCH) {
      const batch = ids.slice(start, start + INDEX_FETCH_BATCH);
      const entries = await getStorage().repos.kv.listLiveValues(
        namespace,
        batch.map((id) => rowKey(model, id)),
        Date.now(),
      );
      for (const entry of entries) {
        if (entry.value_type !== "json") continue;
        try {
          const value: unknown = JSON.parse(entry.value);
          if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            rows.push(value as AppRow);
          }
        } catch {} // corrupt row: the scan path drops it too
      }
      if (!isInTransaction()) await yieldToEventLoop();
    }
    return rows;
  }
  const upper = kvPrefixUpperBound(prefix)!;
  const jsonFieldEquals = equals
    .filter((filter) => !/["\\]/.test(filter.column))
    .map((filter) => ({ field: filter.column, value: filter.value }));
  const rows: AppRow[] = [];
  let afterKey = prefix;
  while (rows.length < LIST_ROW_CAP) {
    const through = await kvKeyAfter(namespace, upper, afterKey, LIST_SCAN_WINDOW - 1);
    const entries = await listKv(namespace, {
      prefix,
      limit: LIST_ROW_CAP - rows.length,
      offset: 0,
      jsonFieldEquals,
      keyAfter: afterKey,
      keyThrough: through ?? undefined,
    });
    for (const { value } of entries) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        rows.push(value as AppRow);
      }
    }
    if (through === null) break;
    afterKey = through;
    // Inside a transaction a timer would stall every DB caller; only yield outside one.
    if (!isInTransaction()) await yieldToEventLoop();
  }
  return rows;
}

/** System fields a stored row carries besides its model columns, with their value check. */
const IMPORT_SYSTEM_FIELDS: Record<string, (value: unknown) => boolean> = {
  createdBy: (value) => typeof value === "string",
  updatedBy: (value) => typeof value === "string",
  source: (value) => typeof value === "string",
  syncedAt: (value) => typeof value === "string" && isIso8601Date(value),
  stale: (value) => typeof value === "boolean",
};
const IMPORT_ROW_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Check rows copied from another swarm (an app bundle) against a model, keeping
 * their ids, timestamps and provenance. Unlike `createAppRows` it does not
 * apply defaults, required checks or the source-managed column guard: the rows
 * are a snapshot of stored state, not a new write. Keys the model does not
 * declare are dropped and counted. Throws `AppRowValidationError` on a bad row.
 */
export function prepareImportedRows(
  model: string,
  definition: ModelDef,
  rows: readonly unknown[],
): { rows: AppRow[]; droppedKeys: number } {
  const issues: AppValidationIssue[] = [];
  const prepared: AppRow[] = [];
  const seen = new Set<string>();
  let droppedKeys = 0;
  const now = new Date().toISOString();
  rows.forEach((raw, index) => {
    const path = `rows.${model}.${index}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      issues.push({ path, message: "row must be an object" });
      return;
    }
    const input = raw as Record<string, unknown>;
    const id = input.id;
    if (typeof id !== "string" || !IMPORT_ROW_ID.test(id)) {
      issues.push({ path: `${path}.id`, message: "row id must be 1-128 of [A-Za-z0-9_-]" });
      return;
    }
    if (seen.has(id)) {
      issues.push({ path: `${path}.id`, message: `duplicate row id "${id}"` });
      return;
    }
    seen.add(id);
    const row: AppRow = { id, createdAt: now, updatedAt: now };
    for (const field of ["createdAt", "updatedAt"] as const) {
      const value = input[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || !isIso8601Date(value)) {
        issues.push({ path: `${path}.${field}`, message: "must be an ISO-8601 date" });
      } else {
        row[field] = value;
      }
    }
    for (const [name, value] of Object.entries(input)) {
      if (name === "id" || name === "createdAt" || name === "updatedAt") continue;
      if (value === null || value === undefined) continue;
      const systemCheck = Object.hasOwn(IMPORT_SYSTEM_FIELDS, name)
        ? IMPORT_SYSTEM_FIELDS[name]
        : undefined;
      if (systemCheck) {
        if (systemCheck(value)) row[name] = value;
        else issues.push({ path: `${path}.${name}`, message: `invalid ${name}` });
        continue;
      }
      const column = Object.hasOwn(definition.columns, name) ? definition.columns[name] : undefined;
      if (!column) {
        droppedKeys++;
        continue;
      }
      const ok =
        column.kind === "json" ? jsonColumnValueIssue(value) === null : validValue(column, value);
      if (ok) row[name] = value;
      else
        issues.push({ path: `${path}.${name}`, message: `must be a valid ${column.kind} value` });
    }
    prepared.push(row);
  });
  if (issues.length > 0) throw new AppRowValidationError(issues.slice(0, 50));
  return { rows: prepared, droppedKeys };
}

const IMPORT_WRITE_BATCH = 500;

/**
 * Write rows from `prepareImportedRows` as they are, ids included, with their
 * index keys. One transaction per batch with a yield between batches, so a
 * large import does not hold the event loop or one giant transaction. Not all
 * or nothing across batches: the importer deletes the app when a batch fails.
 */
export function writeImportedAppRows(
  appId: string,
  model: string,
  definition: ModelDef,
  rows: readonly AppRow[],
): Promise<void> {
  return withMutationLock(appId, model, async () => {
    const namespace = appsNamespace(appId);
    for (let start = 0; start < rows.length; start += IMPORT_WRITE_BATCH) {
      const batch = rows.slice(start, start + IMPORT_WRITE_BATCH);
      await inRowTransaction(() =>
        upsertKvMany(batch.flatMap((row) => rowEntries(namespace, model, definition, row))),
      );
      await yieldToEventLoop();
    }
  });
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
  // Row keys are `<model>/row/<uuid>`, so this bound always exists.
  const upper = kvPrefixUpperBound(prefix)!;
  // Keyset paging on the (namespace, key) primary key: OFFSET re-walked every
  // skipped row on each page. Same rows, order and TTL filter as `listKv`.
  let afterKey = "";
  while (true) {
    const page = await getStorage().repos.kv.listLiveEntriesAfter(
      namespace,
      prefix,
      upper,
      afterKey,
      Date.now(),
      MIGRATION_KV_BATCH_SIZE,
    );
    for (const entry of page) {
      if (entry.value_type !== "json") continue;
      let value: unknown;
      try {
        value = JSON.parse(entry.value);
      } catch {
        continue;
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        rows.push(value as AppRow);
      }
    }
    if (page.length < MIGRATION_KV_BATCH_SIZE) return rows;
    afterKey = page[page.length - 1]!.key;
    // Schema migrations call this inside an open DbClient transaction, where a
    // timer would stall every DB caller; only yield outside one.
    if (!isInTransaction()) await yieldToEventLoop();
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
    return inRowTransaction(() =>
      patchPreparedRowUnlocked(appId, model, currentDefinition, rowId, prepared, options),
    );
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
  const [updated] = await patchPreparedRowsUnlocked(appId, model, definition, [
    { rowId, prepared, options },
  ]);
  return updated ?? null;
}

function patchedRow(
  existing: AppRow,
  prepared: Record<string, unknown>,
  options: AppRowWriteOptions,
): AppRow {
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
  return updated;
}

type PreparedRowPatch = {
  rowId: string;
  prepared: Record<string, unknown>;
  options: AppRowWriteOptions;
  prior?: AppRow;
};

/**
 * Patch rows with one read for the rows that came without a `prior`, at most
 * one index delete and one multi-row upsert (chunked by the KV helpers).
 * Results follow `patches`; null marks a missing row or app. A row patched
 * twice starts its second patch from the first one's result.
 */
async function patchPreparedRowsUnlocked(
  appId: string,
  model: string,
  definition: ModelDef,
  patches: readonly PreparedRowPatch[],
  appPresent?: boolean,
): Promise<Array<AppRow | null>> {
  if (patches.length === 0) return [];
  if (!(appPresent ?? (await appExists(appId)))) return patches.map(() => null);
  const namespace = appsNamespace(appId);
  const stored = await getKvMany(
    namespace,
    patches.filter((patch) => patch.prior === undefined).map((patch) => rowKey(model, patch.rowId)),
  );
  const current = new Map<string, AppRow | null>();
  const storedIndexKeys = new Map<string, Set<string>>();
  const results = patches.map((patch) => {
    let existing: AppRow | null | undefined = current.get(patch.rowId);
    if (!current.has(patch.rowId)) {
      existing = patch.prior ?? asAppRow(stored.get(rowKey(model, patch.rowId))?.value);
      if (existing)
        storedIndexKeys.set(patch.rowId, new Set(indexKeys(model, definition, existing)));
    }
    const updated = existing ? patchedRow(existing, patch.prepared, patch.options) : null;
    current.set(patch.rowId, updated);
    return updated;
  });
  const staleIndexKeys: string[] = [];
  const writes: KvWrite[] = [];
  for (const [rowId, row] of current) {
    const oldKeys = storedIndexKeys.get(rowId);
    if (!row || !oldKeys) continue;
    const newKeys = new Set(indexKeys(model, definition, row));
    staleIndexKeys.push(...[...oldKeys].filter((key) => !newKeys.has(key)));
    writes.push(
      { namespace, key: rowKey(model, rowId), value: row, valueType: "json" },
      ...[...newKeys].filter((key) => !oldKeys.has(key)).map((key) => indexEntry(namespace, key)),
    );
  }
  await deleteKvMany(namespace, staleIndexKeys);
  await upsertKvMany(writes);
  return results;
}

/** One row of a `patchAppRowsUnlocked` batch. */
export interface AppRowPatch {
  rowId: string;
  values: Record<string, unknown>;
  options?: AppRowWriteOptions;
  /**
   * The stored row, when the caller read it under the same mutation lock. Every
   * write to an app namespace holds that lock (generic KV writes to `apps:*` are
   * refused), so the row cannot have moved; without it the batch reads it.
   */
  prior?: AppRow;
}

/**
 * Caller must already hold the app/model mutation lock, and run the batch in
 * one transaction when it must be all or nothing. Every value is validated
 * before the first write. `appPresent`: as in `createAppRowUnlocked`.
 */
export async function patchAppRowsUnlocked(
  appId: string,
  model: string,
  definition: ModelDef,
  patches: readonly AppRowPatch[],
  appPresent?: boolean,
): Promise<Array<AppRow | null>> {
  const prepared = patches.map((patch) => {
    const options = patch.options ?? {};
    return {
      rowId: patch.rowId,
      prepared: prepareValues(definition, patch.values, "patch", options),
      options,
      ...(patch.prior === undefined ? {} : { prior: patch.prior }),
    };
  });
  return patchPreparedRowsUnlocked(appId, model, definition, prepared, appPresent);
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

/** `matches` re-checks the row under the lock; a row that no longer matches is kept. */
export function deleteAppRow(
  appId: string,
  model: string,
  _definition: ModelDef,
  rowId: string,
  matches?: (row: AppRow) => boolean,
): Promise<boolean> {
  return deleteAppRows(appId, model, _definition, [rowId], matches).then((count) => count > 0);
}

/**
 * Delete rows under one lock and in one transaction; returns how many went.
 * `matches` re-checks each row under the lock; a row that no longer matches is kept.
 */
export function deleteAppRows(
  appId: string,
  model: string,
  _definition: ModelDef,
  rowIds: readonly string[],
  matches?: (row: AppRow) => boolean,
): Promise<number> {
  return withMutationLock(appId, model, async () => {
    const currentDefinition = await currentModelDefinition(appId, model);
    if (!currentDefinition) return 0;
    return inRowTransaction(async () => {
      const namespace = appsNamespace(appId);
      const ids = [...new Set(rowIds)];
      const stored = await getKvMany(
        namespace,
        ids.map((rowId) => rowKey(model, rowId)),
      );
      const keys: string[] = [];
      let deleted = 0;
      for (const rowId of ids) {
        const row = asAppRow(stored.get(rowKey(model, rowId))?.value);
        if (!row || (matches && !matches(row))) continue;
        keys.push(...indexKeys(model, currentDefinition, row), rowKey(model, rowId));
        deleted++;
      }
      await deleteKvMany(namespace, keys);
      return deleted;
    });
  });
}

const PURGE_BATCH_SIZE = 1000;

/**
 * Batched DELETEs with an event-loop yield between them: one statement per
 * row blocked every other request for the whole purge, and a single DELETE of
 * the namespace would block for its full duration too. Expired entries go as
 * well; a TTL-filtered listing would leave them orphaned.
 */
async function purgeNamespace(appId: string): Promise<void> {
  const namespace = appsNamespace(appId);
  while (true) {
    const changes = await getStorage().repos.kv.deleteNamespaceBatch(namespace, PURGE_BATCH_SIZE);
    if (changes === 0) return;
    await yieldToEventLoop();
  }
}

/**
 * Drops the app's page presence rooms (`presence:app:<appId>:<page>`): the
 * live rooms first, so no pending flush writes a row back, then every
 * persisted room row. Run it after the app row is gone, so no new join passes
 * the app check.
 */
export async function purgeAppPresenceRooms(appId: string): Promise<void> {
  const prefix = `presence:app:${appId}:`;
  removeNamespaceFamilyRooms(prefix);
  const pattern = literalPrefixPattern(prefix);
  while (true) {
    const changes = await getStorage().repos.kv.deleteNamespacesLikeBatch(
      pattern,
      PURGE_BATCH_SIZE,
    );
    if (changes === 0) return;
    await yieldToEventLoop();
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

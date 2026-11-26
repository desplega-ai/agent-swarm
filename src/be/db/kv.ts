import type { KvEntry, KvValueType } from "../../types";
import { getStorage } from "../storage";

/**
 * KV row codec, the batch helpers (`upsertKvMany`, `getKvMany`,
 * `deleteKvMany`) that write or read many keys in a few statements, and the
 * compare-and-set writes (`replaceKvIfValue`, `deleteKvIfValue`).
 */

export interface KvRow {
  namespace: string;
  key: string;
  value: string;
  value_type: KvValueType;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export function decodeKvRow(row: KvRow): KvEntry {
  let value: unknown;
  if (row.value_type === "json") {
    try {
      value = JSON.parse(row.value);
    } catch {
      // Stored JSON is corrupt — surface as raw string rather than throwing
      // on read; the row is still recoverable by the caller.
      value = row.value;
    }
  } else if (row.value_type === "integer") {
    value = Number(row.value);
  } else {
    value = row.value;
  }
  return {
    namespace: row.namespace,
    key: row.key,
    value,
    valueType: row.value_type,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function encodeKvValue(value: unknown, valueType: KvValueType): string {
  if (valueType === "json") {
    return JSON.stringify(value);
  }
  if (valueType === "integer") {
    if (typeof value === "number") {
      if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
        throw new Error("integer value must be a JS-safe integer");
      }
      return String(value);
    }
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
      return value;
    }
    throw new Error("integer value must be a JS-safe integer");
  }
  // 'string'
  if (typeof value !== "string") {
    throw new Error("string value must be a string");
  }
  return value;
}

/**
 * `upsertKv` for many entries in multi-row statements (chunked under the
 * SQLite parameter limit). A repeated (namespace, key) keeps its last entry.
 * Over one chunk it is several statements: call it inside a transaction when
 * the write must be all or nothing.
 */
export async function upsertKvMany(
  inputs: ReadonlyArray<{
    namespace: string;
    key: string;
    value: unknown;
    valueType: KvValueType;
    expiresAt?: number | null;
  }>,
): Promise<void> {
  if (inputs.length === 0) return;
  const now = Date.now();
  await getStorage().repos.kv.upsertEntries(
    inputs.map((input) => ({
      namespace: input.namespace,
      key: input.key,
      value: encodeKvValue(input.value, input.valueType),
      value_type: input.valueType,
      expires_at: input.expiresAt ?? null,
      created_at: now,
      updated_at: now,
    })),
  );
}

/**
 * `getKv` for many keys of one namespace: the live entries by key. Missing
 * and expired keys are absent; expired rows are deleted inline, as `getKv` does.
 */
export async function getKvMany(
  namespace: string,
  keys: readonly string[],
): Promise<Map<string, KvEntry>> {
  const entries = new Map<string, KvEntry>();
  if (keys.length === 0) return entries;
  const kv = getStorage().repos.kv;
  const rows = (await kv.findEntries(namespace, [...new Set(keys)])) as KvRow[];
  const now = Date.now();
  const expired: string[] = [];
  for (const row of rows) {
    if (row.expires_at !== null && row.expires_at <= now) expired.push(row.key);
    else entries.set(row.key, decodeKvRow(row));
  }
  if (expired.length > 0) await kv.deleteEntries(namespace, expired);
  return entries;
}

/** `deleteKv` for many keys of one namespace; returns how many rows went. */
export async function deleteKvMany(namespace: string, keys: readonly string[]): Promise<number> {
  if (keys.length === 0) return 0;
  return getStorage().repos.kv.deleteEntries(namespace, [...new Set(keys)]);
}

/**
 * Replace a KV entry only while it still holds `expected`, expired or not: a
 * compare-and-set for a claim owner (renew, finalize). Returns true on a write.
 */
export async function replaceKvIfValue(input: {
  namespace: string;
  key: string;
  expected: unknown;
  value: unknown;
  valueType: KvValueType;
  expiresAt?: number | null;
}): Promise<boolean> {
  const changes = await getStorage().repos.kv.replaceEntryIfValue(
    {
      namespace: input.namespace,
      key: input.key,
      value: encodeKvValue(input.value, input.valueType),
      value_type: input.valueType,
      expires_at: input.expiresAt ?? null,
      created_at: Date.now(),
      updated_at: Date.now(),
    },
    encodeKvValue(input.expected, input.valueType),
  );
  return changes > 0;
}

/** Delete a KV entry only while it still holds `expected`. Returns true on a delete. */
export async function deleteKvIfValue(
  namespace: string,
  key: string,
  expected: unknown,
  valueType: KvValueType,
): Promise<boolean> {
  return (
    (await getStorage().repos.kv.deleteEntryIfValue(
      namespace,
      key,
      encodeKvValue(expected, valueType),
    )) > 0
  );
}

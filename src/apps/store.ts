import { defaultAssetKey } from "../assets/key";
import { getDb, getDbClient } from "../be/db";
import type { AppDefinition, AppValidationIssue } from "./definition";
import { AppDefinitionSchema, appDefinitionIssues } from "./definition";
import {
  CURRENT_APP_SCHEMA_VERSION,
  stampAppDefinition,
  upgradeAppDefinition,
} from "./format-upgrades";

interface AppDbRow {
  id: string;
  name: string;
  description: string | null;
  definition: string;
  created_at: string;
  updated_at: string;
}

export interface AppRecord {
  id: string;
  name: string;
  description?: string;
  definition: AppDefinition & { schemaVersion: number };
  definitionError?: AppValidationIssue[];
  createdAt: string;
  updatedAt: string;
}

function invalidJsonIssue(error: unknown): AppValidationIssue {
  return {
    path: "definition",
    message: `invalid stored JSON${error instanceof Error ? `: ${error.message}` : ""}`,
  };
}

export function decodeAppDefinition(raw: unknown): {
  definition: AppRecord["definition"];
  definitionError?: AppValidationIssue[];
} {
  const upgraded = upgradeAppDefinition(raw);
  const parsed = AppDefinitionSchema.safeParse(upgraded);
  if (!parsed.success) {
    return {
      definition: raw as AppRecord["definition"],
      definitionError: appDefinitionIssues(parsed.error),
    };
  }
  return {
    definition: {
      ...parsed.data,
      schemaVersion: CURRENT_APP_SCHEMA_VERSION,
    },
  };
}

export function decodeApp(row: AppDbRow): AppRecord {
  let rawDefinition: unknown;
  try {
    rawDefinition = JSON.parse(row.definition);
  } catch (error) {
    return {
      id: row.id,
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      definition: row.definition as unknown as AppRecord["definition"],
      definitionError: [invalidJsonIssue(error)],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  const decoded = decodeAppDefinition(rawDefinition);
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    definition: decoded.definition,
    ...(decoded.definitionError ? { definitionError: decoded.definitionError } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function appDefinitionNeedsRepair(
  app: AppRecord,
): app is AppRecord & { definitionError: AppValidationIssue[] } {
  return app.definitionError !== undefined;
}

function encodeDefinition(definition: AppDefinition): string {
  return JSON.stringify(stampAppDefinition(definition));
}

function nextTimestamp(previous?: string): string {
  const now = Date.now();
  const previousMs = previous ? Date.parse(previous) : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(now, previousMs + 1)).toISOString();
}

export async function createApp(input: {
  id?: string;
  name: string;
  description?: string;
  definition: AppDefinition;
}): Promise<AppRecord> {
  const id = input.id ?? crypto.randomUUID();
  const now = nextTimestamp();
  const row = await getDbClient().get<AppDbRow>(
    `INSERT INTO apps (id, name, description, definition, created_at, updated_at, "key")
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id, name, description, definition, created_at, updated_at`,
    [
      id,
      input.name,
      input.description ?? null,
      encodeDefinition(input.definition),
      now,
      now,
      defaultAssetKey("app", id),
    ],
  );
  if (!row) throw new Error("Failed to create app");
  return decodeApp(row);
}

/**
 * DEFERRED (transaction rule): called synchronously by `updateApp` below,
 * which every `migrateAppSchema` caller (tools/app-patch.ts, tools/app-upsert.ts,
 * src/apps/version.ts, src/http/apps.ts) passes as the `writeDefinition`
 * closure invoked inside schema-migrate.ts's synchronous `getDb().transaction()`
 * callback — stays on the raw sync handle.
 */
export function getApp(id: string): AppRecord | null {
  const row = getDb()
    .prepare<AppDbRow, [string]>(
      `SELECT id, name, description, definition, created_at, updated_at FROM apps WHERE id = ?`,
    )
    .get(id);
  return row ? decodeApp(row) : null;
}

export async function listApps(): Promise<Array<Omit<AppRecord, "definition">>> {
  const rows = await getDbClient().query<AppDbRow>(
    `SELECT id, name, description, definition, created_at, updated_at
     FROM apps ORDER BY created_at DESC, id`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function listAppRecords(): Promise<AppRecord[]> {
  const rows = await getDbClient().query<AppDbRow>(
    `SELECT id, name, description, definition, created_at, updated_at
     FROM apps ORDER BY created_at ASC, id ASC`,
  );
  return rows.map(decodeApp);
}

/**
 * DEFERRED (transaction rule): passed as `writeDefinition` inside every
 * `migrateAppSchema` call (tools/app-patch.ts, tools/app-upsert.ts,
 * src/apps/version.ts, src/http/apps.ts), invoked synchronously from
 * schema-migrate.ts's synchronous `getDb().transaction()` callback — stays on
 * the raw sync handle via `getApp` above.
 */
export function updateApp(
  id: string,
  patch: { name?: string; description?: string | null; definition?: AppDefinition },
): AppRecord | null {
  const existing = getApp(id);
  if (!existing) return null;
  const updatedAt = nextTimestamp(existing.updatedAt);
  const row = getDb()
    .prepare<AppDbRow, [string, string | null, string, string, string]>(
      `UPDATE apps
       SET name = ?, description = ?, definition = ?, updated_at = ?
       WHERE id = ?
       RETURNING id, name, description, definition, created_at, updated_at`,
    )
    .get(
      patch.name ?? existing.name,
      patch.description === undefined ? (existing.description ?? null) : patch.description,
      encodeDefinition(patch.definition ?? existing.definition),
      updatedAt,
      id,
    );
  return row ? decodeApp(row) : null;
}

export async function deleteApp(id: string): Promise<boolean> {
  return (await getDbClient().run("DELETE FROM apps WHERE id = ?", [id])).changes > 0;
}

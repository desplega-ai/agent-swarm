import { defaultAssetKey } from "../assets/key";
import { getDbClient } from "../be/db";
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

export async function getApp(id: string): Promise<AppRecord | null> {
  const row = await getDbClient().get<AppDbRow>(
    `SELECT id, name, description, definition, created_at, updated_at FROM apps WHERE id = ?`,
    [id],
  );
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

export async function updateApp(
  id: string,
  patch: { name?: string; description?: string | null; definition?: AppDefinition },
): Promise<AppRecord | null> {
  const existing = await getApp(id);
  if (!existing) return null;
  const updatedAt = nextTimestamp(existing.updatedAt);
  const row = await getDbClient().get<AppDbRow>(
    `UPDATE apps
     SET name = ?, description = ?, definition = ?, updated_at = ?
     WHERE id = ?
     RETURNING id, name, description, definition, created_at, updated_at`,
    [
      patch.name ?? existing.name,
      patch.description === undefined ? (existing.description ?? null) : patch.description,
      encodeDefinition(patch.definition ?? existing.definition),
      updatedAt,
      id,
    ],
  );
  return row ? decodeApp(row) : null;
}

export async function deleteApp(id: string): Promise<boolean> {
  return (await getDbClient().run("DELETE FROM apps WHERE id = ?", [id])).changes > 0;
}

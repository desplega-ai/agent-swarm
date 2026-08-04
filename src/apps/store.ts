import { getDb } from "../be/db";
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

export function createApp(input: {
  id?: string;
  name: string;
  description?: string;
  definition: AppDefinition;
}): AppRecord {
  const id = input.id ?? crypto.randomUUID();
  const now = nextTimestamp();
  const row = getDb()
    .prepare<AppDbRow, [string, string, string | null, string, string, string]>(
      `INSERT INTO apps (id, name, description, definition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id, name, description, definition, created_at, updated_at`,
    )
    .get(id, input.name, input.description ?? null, encodeDefinition(input.definition), now, now);
  if (!row) throw new Error("Failed to create app");
  return decodeApp(row);
}

export function getApp(id: string): AppRecord | null {
  const row = getDb()
    .prepare<AppDbRow, [string]>(
      `SELECT id, name, description, definition, created_at, updated_at FROM apps WHERE id = ?`,
    )
    .get(id);
  return row ? decodeApp(row) : null;
}

export function listApps(): Array<Omit<AppRecord, "definition">> {
  return getDb()
    .prepare<AppDbRow, []>(
      `SELECT id, name, description, definition, created_at, updated_at
       FROM apps ORDER BY created_at DESC, id`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

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

export function deleteApp(id: string): boolean {
  return getDb().prepare<unknown, [string]>("DELETE FROM apps WHERE id = ?").run(id).changes > 0;
}

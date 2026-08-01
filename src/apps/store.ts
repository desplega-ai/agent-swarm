import { getDb } from "../be/db";
import type { AppDefinition } from "./definition";
import { AppDefinitionSchema } from "./definition";

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
  definition: AppDefinition;
  createdAt: string;
  updatedAt: string;
}

function decodeApp(row: AppDbRow): AppRecord {
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    definition: AppDefinitionSchema.parse(JSON.parse(row.definition)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    .get(id, input.name, input.description ?? null, JSON.stringify(input.definition), now, now);
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
      JSON.stringify(patch.definition ?? existing.definition),
      updatedAt,
      id,
    );
  return row ? decodeApp(row) : null;
}

export function deleteApp(id: string): boolean {
  return getDb().prepare<unknown, [string]>("DELETE FROM apps WHERE id = ?").run(id).changes > 0;
}

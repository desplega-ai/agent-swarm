import { getDb } from "../be/db";
import { isIso8601Date, type UserConfigField } from "./definition";

export type UserConfigValue = string | number | boolean | null;
export type UserConfigValues = Record<string, UserConfigValue>;
export type UserConfigSchema = Record<string, UserConfigField>;

interface AppUserConfigRow {
  storedValues: string;
}

function accepts(field: UserConfigField, value: unknown): value is Exclude<UserConfigValue, null> {
  if (field.kind === "string") return typeof value === "string";
  if (field.kind === "number") return typeof value === "number" && Number.isFinite(value);
  if (field.kind === "boolean") return typeof value === "boolean";
  if (field.kind === "date") return typeof value === "string" && isIso8601Date(value);
  return typeof value === "string" && Boolean(field.enum?.includes(value));
}

/**
 * Reconciles persisted preferences with the current definition. Definitions
 * intentionally evolve independently: removed keys disappear and malformed or
 * obsolete values fall back to their declared default (or null).
 */
export function mergeUserConfigValues(schema: UserConfigSchema, stored: unknown): UserConfigValues {
  const source =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries(schema).map(([name, field]) => {
      const value = source[name];
      return [name, accepts(field, value) ? value : (field.default ?? null)];
    }),
  );
}

export function userConfigValueIssues(
  schema: UserConfigSchema,
  values: Record<string, unknown>,
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  for (const [name, value] of Object.entries(values)) {
    const field = schema[name];
    if (!field) {
      issues.push({ path: `values.${name}`, message: `unknown userConfig field "${name}"` });
    } else if (!accepts(field, value)) {
      issues.push({
        path: `values.${name}`,
        message:
          field.kind === "enum"
            ? `must be a valid enum value (${field.enum?.join(", ") ?? ""})`
            : `must be a valid ${field.kind} value`,
      });
    }
  }
  return issues;
}

export function getAppUserConfigValues(appId: string, scope: string): unknown {
  const row = getDb()
    .prepare<AppUserConfigRow, [string, string]>(
      'SELECT "values" AS storedValues FROM app_user_config WHERE appId = ? AND scope = ?',
    )
    .get(appId, scope);
  if (!row) return {};
  try {
    return JSON.parse(row.storedValues);
  } catch {
    return {};
  }
}

export function upsertAppUserConfigValues(
  appId: string,
  scope: string,
  values: Record<string, unknown>,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO app_user_config (id, appId, scope, "values", createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(appId, scope) DO UPDATE SET "values" = excluded."values", updatedAt = excluded.updatedAt`,
    )
    .run(crypto.randomUUID(), appId, scope, JSON.stringify(values), now, now);
}

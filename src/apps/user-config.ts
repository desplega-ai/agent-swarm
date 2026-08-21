import { getDbClient } from "../be/db";
import { isIso8601Date, type UserConfigField } from "./definition";

export type UserConfigValue = string | number | boolean | null;
export type UserConfigValues = Record<string, UserConfigValue>;
export type UserConfigSchema = Record<string, UserConfigField>;

/**
 * Reserved, system-owned user-config keys. They ride the same per-(app, user)
 * storage row as author-declared fields but are NOT part of the app's
 * `userConfig` schema — `AppNameSchema` forbids `$`, so no declared field can
 * ever collide. `$theme` holds the viewer's preset-theme override for the app
 * (same slug shape as `definition.theme`; the dashboard resolves unknown ids
 * to its default preset).
 */
export const USER_CONFIG_THEME_KEY = "$theme";
const RESERVED_KEY_PATTERNS: Record<string, RegExp> = {
  [USER_CONFIG_THEME_KEY]: /^[a-z][a-z0-9-]{0,39}$/,
};

export function isReservedUserConfigKey(key: string): boolean {
  return Object.hasOwn(RESERVED_KEY_PATTERNS, key);
}

function acceptedReservedEntries(stored: Record<string, unknown>): UserConfigValues {
  const entries: UserConfigValues = {};
  for (const [key, pattern] of Object.entries(RESERVED_KEY_PATTERNS)) {
    const value = stored[key];
    if (typeof value === "string" && pattern.test(value)) entries[key] = value;
  }
  return entries;
}

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
 * obsolete values fall back to their declared default (or null). Reserved
 * system keys (`$theme`) survive the merge regardless of the schema — they are
 * never declared in it.
 */
export function mergeUserConfigValues(schema: UserConfigSchema, stored: unknown): UserConfigValues {
  const source =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  return {
    ...acceptedReservedEntries(source),
    ...Object.fromEntries(
      Object.entries(schema).map(([name, field]) => {
        const value = source[name];
        return [name, accepts(field, value) ? value : (field.default ?? null)];
      }),
    ),
  };
}

export function userConfigValueIssues(
  schema: UserConfigSchema,
  values: Record<string, unknown>,
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  for (const [name, value] of Object.entries(values)) {
    // Own-key lookup only: a prototype-named field ("toString", …) must fall
    // through to unknown-field validation, not resolve an inherited function
    // that `.test()` then throws on (turning bad client input into a 500).
    const reservedPattern = Object.hasOwn(RESERVED_KEY_PATTERNS, name)
      ? RESERVED_KEY_PATTERNS[name]
      : undefined;
    if (reservedPattern) {
      // `null` is the explicit "clear" form — PUT replaces wholesale, but a
      // schema-less app rejects an empty body, so clearing needs a value.
      if (value !== null && (typeof value !== "string" || !reservedPattern.test(value))) {
        issues.push({
          path: `values.${name}`,
          message: "must be a lowercase slug (letters, digits, dashes) or null to clear",
        });
      }
      continue;
    }
    const field = Object.hasOwn(schema, name) ? schema[name] : undefined;
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

export async function getAppUserConfigValues(appId: string, scope: string): Promise<unknown> {
  const row = await getDbClient().get<AppUserConfigRow>(
    'SELECT "values" AS storedValues FROM app_user_config WHERE appId = ? AND scope = ?',
    [appId, scope],
  );
  if (!row) return {};
  try {
    return JSON.parse(row.storedValues);
  } catch {
    return {};
  }
}

export async function upsertAppUserConfigValues(
  appId: string,
  scope: string,
  values: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO app_user_config (id, appId, scope, "values", createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(appId, scope) DO UPDATE SET "values" = excluded."values", updatedAt = excluded.updatedAt`,
    [crypto.randomUUID(), appId, scope, JSON.stringify(values), now, now],
  );
}

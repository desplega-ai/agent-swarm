import { defaultAssetKey } from "../assets/key";
import { literalPrefixPattern } from "../be/db";
import { getStorage } from "../be/storage";
import type { AppIcon } from "../types";
import { AppIconSchema } from "../types";
import type { AppDefinition, AppValidationIssue } from "./definition";
import { AppDefinitionSchema, appDefinitionIssues } from "./definition";
import {
  CURRENT_APP_SCHEMA_VERSION,
  stampAppDefinition,
  upgradeAppDefinition,
} from "./format-upgrades";

const repo = () => getStorage().repos.pages;

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
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- invalid JSON keeps the raw string; definitionError flags it.
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
  const row = await repo().insertApp({
    id,
    name: input.name,
    description: input.description ?? null,
    definition: encodeDefinition(input.definition),
    now,
    key: defaultAssetKey("app", id),
  });
  if (!row) throw new Error("Failed to create app");
  return decodeApp(row);
}

export async function getApp(id: string): Promise<AppRecord | null> {
  const row = await repo().findApp(id);
  return row ? decodeApp(row) : null;
}

/** Best-effort `definition.icon` extraction: a malformed or absent value just means no custom icon. */
function extractIcon(rawDefinitionJson: string): AppIcon | undefined {
  try {
    const parsed: unknown = JSON.parse(rawDefinitionJson);
    const candidate =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).icon
        : undefined;
    return AppIconSchema.safeParse(candidate).data;
  } catch {
    return undefined;
  }
}

export async function listApps(filters?: {
  /** Matches the name or description anywhere, case-insensitive. */
  q?: string;
  limit?: number;
}): Promise<Array<Omit<AppRecord, "definition"> & { icon?: AppIcon }>> {
  const rows = await repo().listApps({
    pattern: filters?.q ? `%${literalPrefixPattern(filters.q)}` : undefined,
    limit: filters?.limit,
  });
  return rows.map((row) => {
    const icon = extractIcon(row.definition);
    return {
      id: row.id,
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      ...(icon ? { icon } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export async function listAppRecords(): Promise<AppRecord[]> {
  const rows = await repo().listAllApps();
  return rows.map(decodeApp);
}

export async function updateApp(
  id: string,
  patch: { name?: string; description?: string | null; definition?: AppDefinition },
): Promise<AppRecord | null> {
  const existing = await getApp(id);
  if (!existing) return null;
  const updatedAt = nextTimestamp(existing.updatedAt);
  const row = await repo().updateApp(id, {
    name: patch.name ?? existing.name,
    description:
      patch.description === undefined ? (existing.description ?? null) : patch.description,
    definition: encodeDefinition(patch.definition ?? existing.definition),
    updatedAt,
  });
  return row ? decodeApp(row) : null;
}

export async function deleteApp(id: string): Promise<boolean> {
  const storage = getStorage();
  return storage.transaction(async () => {
    await storage.repos.pages.deleteAppFavorites(id);
    return (await storage.repos.pages.deleteApp(id)) > 0;
  });
}

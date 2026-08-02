import { getAllTasks } from "../be/db";
import type { AgentTaskStatus } from "../types";
import { AgentTaskStatusSchema } from "../types";
import type { ColumnDef, ModelDef, SourceDef } from "./definition";
import { isIso8601Date } from "./definition";
import {
  type AppRow,
  createAppRowUnlocked,
  listAppRows,
  patchAppRowUnlocked,
  withMutationLock,
} from "./row-store";
import type { AppRecord } from "./store";

export interface SourceRecord {
  key: string;
  fields: Record<string, unknown>;
}

export interface Connector {
  pull(config: Record<string, string | number | boolean>): Promise<SourceRecord[]>;
}

export interface SyncWarning {
  key: string;
  column: string;
  message: string;
}

export interface SyncPassResult {
  model: string;
  source: string;
  connector: SourceDef["connector"];
  pulled: number;
  created: number;
  updated: number;
  unchanged: number;
  markedStale: number;
  warnings: SyncWarning[];
  durationMs: number;
  error?: string;
}

export interface AppSyncResult {
  ok: boolean;
  passes: SyncPassResult[];
}

export class SyncSelectionError extends Error {
  readonly issues: Array<{ path: string; message: string }>;

  constructor(issues: Array<{ path: string; message: string }>) {
    super("invalid sync selection");
    this.name = "SyncSelectionError";
    this.issues = issues;
  }
}

const MAX_WARNINGS = 20;
// listAppRows is the existing full-model scan and is capped at 100,000 rows.
const MAX_ROWS_PER_MODEL = 100_000;

function positiveLimit(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), maximum)
    : fallback;
}

const swarmTasksConnector: Connector = {
  async pull(config) {
    let statuses: AgentTaskStatus[] | undefined;
    if (typeof config.status === "string" && config.status.trim()) {
      statuses = config.status
        .split(",")
        .map((status) => status.trim())
        .filter(Boolean)
        .map((status) => {
          const parsed = AgentTaskStatusSchema.safeParse(status);
          if (!parsed.success) throw new Error(`invalid swarm-tasks status "${status}"`);
          return parsed.data;
        });
    }
    const tasks = getAllTasks({
      status: statuses,
      limit: positiveLimit(config.limit, 100, 200),
      includeHeartbeat: config.includeHeartbeat === true,
    });
    return tasks.map((task) => ({
      key: task.id,
      fields: {
        id: task.id,
        status: task.status,
        prompt: task.task.slice(0, 1000),
        source: task.source,
        agentId: task.agentId,
        tags: task.tags,
        priority: task.priority,
        createdAt: task.createdAt,
        updatedAt: task.lastUpdatedAt,
        vcsProvider: task.vcsProvider,
        vcsNumber: task.vcsNumber,
        vcsUrl: task.vcsUrl,
        vcsAuthor: task.vcsAuthor,
      },
    }));
  },
};

interface GitHubIssue {
  number?: unknown;
  id?: unknown;
  title?: unknown;
  state?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
  labels?: Array<{ name?: unknown } | string>;
  comments?: unknown;
  html_url?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  pull_request?: unknown;
}

const githubIssuesConnector: Connector = {
  async pull(config) {
    if (typeof config.repo !== "string") throw new Error("github-issues requires config.repo");
    const [owner, name] = config.repo.split("/");
    if (!owner || !name) throw new Error('github-issues repo must use "owner/name" form');
    const state = config.state ?? "open";
    if (state !== "open" && state !== "closed" && state !== "all") {
      throw new Error('github-issues state must be "open", "closed", or "all"');
    }
    const limit = positiveLimit(config.limit, 50, 100);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let payload: unknown;
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?state=${state}&per_page=${limit}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "agent-swarm-apps-sync",
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(`GitHub issues pull failed with status ${response.status}`);
      payload = await response.json();
    } finally {
      clearTimeout(timeout);
    }
    if (!Array.isArray(payload))
      throw new Error("GitHub issues pull returned a non-array response");
    return (payload as GitHubIssue[])
      .filter((issue) => !Object.hasOwn(issue, "pull_request"))
      .map((issue) => {
        if (typeof issue.number !== "number") {
          throw new Error("GitHub issue is missing a numeric number");
        }
        return {
          key: String(issue.number),
          fields: {
            number: issue.number,
            id: issue.id,
            title: issue.title,
            state: issue.state,
            body: typeof issue.body === "string" ? issue.body.slice(0, 1000) : issue.body,
            userLogin: issue.user?.login,
            labelsCsv: Array.isArray(issue.labels)
              ? issue.labels
                  .map((label) => (typeof label === "string" ? label : label.name))
                  .filter((label): label is string => typeof label === "string")
                  .join(",")
              : "",
            comments: issue.comments,
            htmlUrl: issue.html_url,
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
          },
        };
      });
  },
};

export const CONNECTORS: Record<SourceDef["connector"], Connector> = {
  "swarm-tasks": swarmTasksConnector,
  "github-issues": githubIssuesConnector,
};

function getByDottedPath(record: Record<string, unknown>, path: string): unknown {
  let value: unknown = record;
  for (const segment of path.split(".")) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.hasOwn(value, segment)
    ) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function validColumnValue(column: ColumnDef, value: unknown): boolean {
  if (value === null) return true;
  if (column.kind === "string") return typeof value === "string";
  if (column.kind === "number") return typeof value === "number" && Number.isFinite(value);
  if (column.kind === "boolean") return typeof value === "boolean";
  if (column.kind === "date") return typeof value === "string" && isIso8601Date(value);
  return typeof value === "string" && Boolean(column.enum?.includes(value));
}

function projectValue(raw: unknown, column: ColumnDef): { value: unknown; warning?: string } {
  if (raw === null) return { value: null };
  if (raw === undefined) return { value: null, warning: "source field is missing" };
  const transform = column.source?.transform;
  let value = raw;
  try {
    if (transform === "slug") {
      value = String(raw)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    } else if (transform === "lower") {
      value = String(raw).toLowerCase();
    } else if (transform === "upper") {
      value = String(raw).toUpperCase();
    } else if (transform === "cents") {
      const numeric = Number(raw);
      if (Number.isNaN(numeric)) throw new Error("value is not numeric");
      value = Math.round(numeric * 100);
    } else if (transform === "date-parse") {
      const timestamp = new Date(raw as string | number).toISOString();
      value = timestamp;
    }
  } catch {
    return { value: null, warning: `failed ${transform ?? "value"} transform` };
  }
  if (!validColumnValue(column, value)) {
    return { value: null, warning: `value is not a valid ${column.kind}` };
  }
  return { value };
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    (Array.isArray(left) && Array.isArray(right)) ||
    (typeof left === "object" && left !== null && typeof right === "object" && right !== null)
  ) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

function passError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSyncPass(
  app: AppRecord,
  modelName: string,
  sourceName: string,
): Promise<SyncPassResult> {
  const startedAt = Date.now();
  const model = app.definition.models[modelName];
  const source = model?.sources?.[sourceName];
  if (!model || !source) throw new Error(`unknown sync pair ${modelName}.${sourceName}`);
  const result: SyncPassResult = {
    model: modelName,
    source: sourceName,
    connector: source.connector,
    pulled: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    markedStale: 0,
    warnings: [],
    durationMs: 0,
  };

  try {
    const records = await CONNECTORS[source.connector].pull(source.config ?? {});
    result.pulled = records.length;
    await withMutationLock(app.id, modelName, () => {
      const existing = listAppRows(app.id, modelName);
      const mine = new Map<string, AppRow>();
      for (const row of existing) {
        const key = row[source.joinKey];
        if (row.source === sourceName && typeof key === "string") mine.set(key, row);
      }
      const seen = new Set<string>();
      const now = new Date().toISOString();

      for (const record of records) {
        const values: Record<string, unknown> = { [source.joinKey]: record.key };
        for (const [columnName, column] of Object.entries(model.columns)) {
          if (column.source?.of !== sourceName) continue;
          const projected = projectValue(
            getByDottedPath(record.fields, column.source.field),
            column,
          );
          values[columnName] = projected.value;
          if (projected.warning && result.warnings.length < MAX_WARNINGS) {
            result.warnings.push({
              key: record.key,
              column: columnName,
              message: projected.warning,
            });
          }
        }

        const match = mine.get(record.key);
        if (match) {
          const changed = Object.entries(values).some(
            ([name, value]) => !valuesEqual(match[name], value),
          );
          const updated = patchAppRowUnlocked(
            app.id,
            modelName,
            model,
            match.id,
            changed || match.stale === true
              ? { ...values, syncedAt: now, stale: false }
              : { syncedAt: now },
            {
              allowSourceManaged: true,
              skipUpdatedAt: !changed && match.stale !== true,
            },
          );
          if (!updated) throw new Error(`synced row ${match.id} disappeared during the pass`);
          mine.set(record.key, updated);
          if (changed || match.stale === true) result.updated += 1;
          else result.unchanged += 1;
        } else {
          if (existing.length + result.created >= MAX_ROWS_PER_MODEL) {
            throw new Error(`model "${modelName}" reached the ${MAX_ROWS_PER_MODEL} row limit`);
          }
          const created = createAppRowUnlocked(
            app.id,
            modelName,
            model,
            { ...values, source: sourceName, syncedAt: now, stale: false },
            { allowSourceManaged: true },
          );
          mine.set(record.key, created);
          result.created += 1;
        }
        seen.add(record.key);
      }

      for (const [key, row] of mine) {
        if (seen.has(key) || row.stale === true) continue;
        const updated = patchAppRowUnlocked(
          app.id,
          modelName,
          model,
          row.id,
          { stale: true },
          { allowSourceManaged: true },
        );
        if (!updated) throw new Error(`synced row ${row.id} disappeared during the pass`);
        result.markedStale += 1;
      }
    });
  } catch (error) {
    result.error = passError(error);
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}

function matchingPairs(
  app: AppRecord,
  selection: { model?: string; source?: string },
): Array<[string, string]> {
  const issues: Array<{ path: string; message: string }> = [];
  let models: Array<[string, ModelDef]>;
  if (selection.model !== undefined) {
    const model = app.definition.models[selection.model];
    if (!model) {
      throw new SyncSelectionError([
        { path: "model", message: `unknown model "${selection.model}"` },
      ]);
    }
    models = [[selection.model, model]];
  } else {
    models = Object.entries(app.definition.models);
  }

  const pairs: Array<[string, string]> = [];
  for (const [modelName, model] of models) {
    for (const sourceName of Object.keys(model.sources ?? {})) {
      if (selection.source === undefined || selection.source === sourceName) {
        pairs.push([modelName, sourceName]);
      }
    }
  }
  if (pairs.length === 0) {
    issues.push({
      path: selection.source === undefined ? "model" : "source",
      message:
        selection.source === undefined
          ? "sync selection matches no model sources"
          : `unknown source "${selection.source}" for the sync selection`,
    });
    throw new SyncSelectionError(issues);
  }
  return pairs;
}

export async function runAppSync(
  app: AppRecord,
  selection: { model?: string; source?: string } = {},
): Promise<AppSyncResult> {
  const passes: SyncPassResult[] = [];
  for (const [modelName, sourceName] of matchingPairs(app, selection)) {
    passes.push(await runSyncPass(app, modelName, sourceName));
  }
  return { ok: passes.every((pass) => pass.error === undefined), passes };
}

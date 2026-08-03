import * as z from "zod";
import { getAllTasks } from "../be/db";
import { getScriptById } from "../be/scripts/db";
import { getSavedScriptOwnerAgentId, runSavedScriptAsAgent } from "../be/scripts/run-saved";
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
const MAX_SOURCE_RECORDS = 500;
const GLOBAL_SCRIPT_SYNC_AGENT_ID = "app-sync";
// listAppRows is the existing full-model scan and is capped at 100,000 rows.
const MAX_ROWS_PER_MODEL = 100_000;

const ScriptSourceRecordsSchema = z
  .array(
    z.object({
      key: z.union([z.string(), z.number(), z.boolean()]).transform(String),
      fields: z.record(z.string(), z.unknown()),
    }),
  )
  .max(MAX_SOURCE_RECORDS);

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

export const CONNECTORS: Record<"swarm-tasks", Connector> = {
  "swarm-tasks": swarmTasksConnector,
};

function scriptFailure(
  output: Awaited<ReturnType<typeof runSavedScriptAsAgent>>,
): string | undefined {
  if (output.exitCode === 0 && !output.error && !output.runtimeError) return undefined;
  if (output.runtimeError) return `${output.runtimeError.name}: ${output.runtimeError.message}`;
  return output.error ?? `Script exited with code ${output.exitCode}`;
}

async function pullScriptSource(
  app: AppRecord,
  modelName: string,
  sourceName: string,
  source: Extract<SourceDef, { connector: "script" }>,
): Promise<SourceRecord[]> {
  const script = getScriptById(source.scriptId);
  if (!script) throw new Error(`script "${source.scriptId}" no longer exists`);

  // Agent-owned sources match script actions exactly. Built-in global scripts have no owner;
  // run them under an isolated principal so they cannot inherit an arbitrary agent's bindings.
  const runAsAgentId = getSavedScriptOwnerAgentId(script) ?? GLOBAL_SCRIPT_SYNC_AGENT_ID;
  const output = await runSavedScriptAsAgent({
    script,
    input: {
      ...source.args,
      app: { id: app.id },
      model: modelName,
      source: sourceName,
    },
    agentId: runAsAgentId,
  });
  const failure = scriptFailure(output);
  if (failure) throw new Error(failure);

  const parsed = ScriptSourceRecordsSchema.safeParse(output.result);
  if (!parsed.success) {
    throw new Error(`script source returned invalid records: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

async function pullSource(
  app: AppRecord,
  modelName: string,
  sourceName: string,
  source: SourceDef,
): Promise<SourceRecord[]> {
  if (source.connector === "script") {
    return pullScriptSource(app, modelName, sourceName, source);
  }
  return CONNECTORS["swarm-tasks"].pull(source.config ?? {});
}

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
    // External/script work must finish before taking the per-model reconciliation lock.
    const records = await pullSource(app, modelName, sourceName, source);
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

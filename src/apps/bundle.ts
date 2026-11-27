import * as z from "zod";
import { computeContentHash, getResolvedConfig } from "../be/db";
import {
  isScriptConnectionReachable,
  listRelationalCredentialBindings,
} from "../be/script-connections";
import { deleteScript, getScript, getScriptById, insertScript } from "../be/scripts/db";
import { extractArgsJsonSchema } from "../be/scripts/extract-schema";
import { getSavedScriptOwnerAgentId } from "../be/scripts/run-saved";
import { refuseSourceWithSecrets } from "../be/scripts/source-secrets";
import { isExecutorAllowedByDeployment } from "../scripts-runtime/executors/registry";
import { extractScriptSignature } from "../scripts-runtime/extract-signature";
import { ScriptExecutorNameSchema, ScriptFsModeSchema, type ScriptRecord } from "../types";
import {
  type AppDefinition,
  type AppValidationIssue,
  collectScriptReferences,
  parseAppDefinition,
  scriptCompatWarnings,
} from "./definition";
import {
  type AppRow,
  AppRowValidationError,
  listAllAppRowsForMigrationUnlocked,
  prepareImportedRows,
  purgeAppRows,
  writeImportedAppRows,
} from "./row-store";
import { type AppRecord, createApp, deleteApp, getApp } from "./store";
import { resolveSyncRunAs } from "./sync-run-as";

export const APP_BUNDLE_FORMAT = "swarm-app-bundle/v1";

/**
 * Rows one export may carry across all models.
 * shortcut: the whole bundle is built in memory; stream it (NDJSON) if apps outgrow this cap.
 */
export const MAX_EXPORT_ROWS = 200_000;

export const AppBundleScriptSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  intent: z.string(),
  source: z.string().min(1),
  /** Informational: the importer derives the args schema from `source` again. */
  argsSchema: z.unknown().optional(),
  fsMode: ScriptFsModeSchema.optional(),
  executor: ScriptExecutorNameSchema.nullable().optional(),
});
export type AppBundleScript = z.infer<typeof AppBundleScriptSchema>;

export const AppBundleSchema = z.object({
  format: z.literal(APP_BUNDLE_FORMAT),
  exportedAt: z.string().optional(),
  app: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    definition: z.record(z.string(), z.unknown()),
  }),
  rows: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  scripts: z.array(AppBundleScriptSchema),
});
export type AppBundle = z.infer<typeof AppBundleSchema>;

export type AppExportResult =
  | {
      ok: true;
      bundle: Omit<AppBundle, "rows"> & { rows: Record<string, AppRow[]> };
      warnings: string[];
    }
  | { ok: false; status: 404 | 409 | 413; error: string; issues?: AppValidationIssue[] };

/** Every row of every model, the definition, and the scripts it references. */
export async function exportAppBundle(appId: string): Promise<AppExportResult> {
  const app = await getApp(appId);
  if (!app) return { ok: false, status: 404, error: "app not found" };
  if (app.definitionError) {
    return {
      ok: false,
      status: 409,
      error: "definition needs repair",
      issues: app.definitionError,
    };
  }
  const rows: Record<string, AppRow[]> = {};
  let total = 0;
  for (const model of Object.keys(app.definition.models)) {
    // Read without the model lock: a concurrent write lands before or after
    // the page that holds its row, never half-applied.
    const modelRows = await listAllAppRowsForMigrationUnlocked(appId, model);
    total += modelRows.length;
    if (total > MAX_EXPORT_ROWS) {
      return {
        ok: false,
        status: 413,
        error: `app has more than ${MAX_EXPORT_ROWS} rows; export is capped`,
      };
    }
    rows[model] = modelRows;
  }
  const warnings: string[] = [];
  const scripts: AppBundleScript[] = [];
  for (const [scriptId, paths] of collectScriptReferences(app.definition)) {
    const script = await getScriptById(scriptId);
    if (!script) {
      warnings.push(`script ${scriptId} (${paths.join(", ")}) not found; the bundle omits it`);
      continue;
    }
    scripts.push({
      id: script.id,
      name: script.name,
      description: script.description,
      intent: script.intent,
      source: script.source,
      argsSchema: parseJsonOrNull(script.argsJsonSchema),
      fsMode: script.fsMode,
      executor: script.executor,
    });
  }
  const { schemaVersion: _schemaVersion, ...definition } = app.definition;
  return {
    ok: true,
    bundle: {
      format: APP_BUNDLE_FORMAT,
      exportedAt: new Date().toISOString(),
      app: {
        id: app.id,
        name: app.name,
        ...(app.description !== undefined ? { description: app.description } : {}),
        definition,
      },
      rows,
      scripts,
    },
    warnings,
  };
}

function parseJsonOrNull(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Who the import writes as. Scripts land in the agent's scope, or global for the operator. */
export type AppImportWriter =
  | { kind: "agent"; agentId: string; writerIsUser: boolean }
  | { kind: "operator" }
  | { kind: "other" };

export type AppImportResult =
  | {
      ok: true;
      app: AppRecord;
      /** Bundle script id -> local script id, for every script the bundle carried. */
      scriptIds: Record<string, string>;
      rows: Record<string, number>;
      warnings: string[];
    }
  | {
      ok: false;
      status: 400 | 403 | 409;
      error: string;
      issues?: AppValidationIssue[];
    };

type ScriptPlan =
  | { kind: "reuse"; bundleId: string; script: ScriptRecord }
  | { kind: "create"; bundleId: string; script: AppBundleScript };

function scriptVisibleTo(script: ScriptRecord, writer: AppImportWriter): boolean {
  if (writer.kind === "operator") return true;
  if (script.scope === "global") return true;
  return writer.kind === "agent" && script.scopeId === writer.agentId;
}

/**
 * Create an app from a bundle: its scripts, its definition with script ids
 * rewritten, and its rows with their ids. Nothing is overwritten: a bundle
 * script reuses a local script with the same id (when the writer may wire it)
 * or the same name and source in the writer's scope, and is created otherwise.
 * A same-name script with other source is a 409. On failure every script and
 * row this call created is removed again.
 */
export async function importAppBundle(
  bundle: AppBundle,
  options: { keepId: boolean; writer: AppImportWriter },
): Promise<AppImportResult> {
  const { writer } = options;
  if (options.keepId && (await getApp(bundle.app.id))) {
    return { ok: false, status: 409, error: `app "${bundle.app.id}" already exists` };
  }
  if (bundle.scripts.length > 0 && writer.kind === "other") {
    return {
      ok: false,
      status: 403,
      error: "importing scripts needs an agent identity (X-Agent-ID) or the operator key",
    };
  }
  const scope = writer.kind === "agent" ? "agent" : "global";
  const scopeId = writer.kind === "agent" ? writer.agentId : null;
  const warnings: string[] = [];

  // Plan every script before the first write, so a conflict writes nothing.
  const plans: ScriptPlan[] = [];
  const issues: AppValidationIssue[] = [];
  let nameConflict = false;
  const planned = new Map<string, string>(); // name -> content hash planned for creation
  for (const [index, script] of bundle.scripts.entries()) {
    const path = `scripts.${index}`;
    const hash = computeContentHash(script.source);
    const byId = await getScriptById(script.id);
    if (byId && scriptVisibleTo(byId, writer)) {
      if (byId.contentHash !== hash) {
        warnings.push(
          `script "${byId.name}" (${byId.id}) exists here with other source; the import uses the local version`,
        );
      }
      plans.push({ kind: "reuse", bundleId: script.id, script: byId });
      continue;
    }
    const byName = await getScript({ name: script.name, scope, scopeId });
    if (byName) {
      if (byName.contentHash === hash) {
        plans.push({ kind: "reuse", bundleId: script.id, script: byName });
      } else {
        nameConflict = true;
        issues.push({
          path: `${path}.name`,
          message: `a ${scope} script named "${script.name}" already exists with other source; rename it in the bundle`,
        });
      }
      continue;
    }
    const plannedHash = planned.get(script.name);
    if (plannedHash !== undefined && plannedHash !== hash) {
      issues.push({
        path: `${path}.name`,
        message: `the bundle has two scripts named "${script.name}" with different source`,
      });
      continue;
    }
    const refusal = refuseSourceWithSecrets(script.source);
    if (refusal) {
      issues.push({ path: `${path}.source`, message: refusal.message });
      continue;
    }
    if (scope !== "global" && extractScriptSignature(script.source).kind === "durable") {
      issues.push({
        path: `${path}.source`,
        message: "DurableObject scripts must be global scope",
      });
      continue;
    }
    if (!isExecutorAllowedByDeployment(script.executor)) {
      issues.push({
        path: `${path}.executor`,
        message: `executor "${script.executor}" is not permitted by this deployment`,
      });
      continue;
    }
    planned.set(script.name, hash);
    plans.push({ kind: "create", bundleId: script.id, script });
  }
  if (nameConflict) {
    return { ok: false, status: 409, error: "script name conflict", issues };
  }
  if (issues.length > 0) return { ok: false, status: 400, error: "invalid bundle scripts", issues };

  const created: ScriptRecord[] = [];
  const cleanupScripts = async () => {
    for (const script of created) {
      await deleteScript({ name: script.name, scope: script.scope, scopeId: script.scopeId });
    }
  };

  const scriptIds: Record<string, string> = {};
  const createdByName = new Map<string, ScriptRecord>();
  for (const plan of plans) {
    if (plan.kind === "reuse") {
      scriptIds[plan.bundleId] = plan.script.id;
      continue;
    }
    const existing = createdByName.get(plan.script.name);
    if (existing) {
      scriptIds[plan.bundleId] = existing.id;
      continue;
    }
    const script = await insertScript({
      name: plan.script.name,
      scope,
      scopeId,
      source: plan.script.source,
      description: plan.script.description,
      intent: plan.script.intent,
      signatureJson: JSON.stringify(extractScriptSignature(plan.script.source)),
      argsJsonSchema: await extractArgsJsonSchema(plan.script.source),
      fsMode: plan.script.fsMode,
      executor: plan.script.executor ?? null,
      agentId: writer.kind === "agent" ? writer.agentId : null,
      isScratch: false,
      // Not typechecked: the connections the source calls may not exist here.
      typeChecked: false,
      changeReason: `Imported with app "${bundle.app.name}"`,
    });
    created.push(script);
    createdByName.set(script.name, script);
    scriptIds[plan.bundleId] = script.id;
  }

  try {
    const definition = structuredClone(bundle.app.definition);
    warnings.push(...(await rewriteScriptRefs(definition, scriptIds)));
    const parsed = await parseAppDefinition(definition, {
      resolveApp: getApp,
      writerAgentId: writer.kind === "agent" ? writer.agentId : null,
      writerIsUser: writer.kind === "agent" ? writer.writerIsUser : writer.kind === "other",
    });
    if (!parsed.success) {
      await cleanupScripts();
      return { ok: false, status: 400, error: "invalid app definition", issues: parsed.issues };
    }

    const preparedRows: Array<{ model: string; rows: AppRow[] }> = [];
    const rowIssues: AppValidationIssue[] = [];
    let droppedKeys = 0;
    for (const [model, rows] of Object.entries(bundle.rows)) {
      const modelDef = Object.hasOwn(parsed.definition.models, model)
        ? parsed.definition.models[model]
        : undefined;
      if (!modelDef) {
        rowIssues.push({
          path: `rows.${model}`,
          message: `model "${model}" is not in the definition`,
        });
        continue;
      }
      try {
        const prepared = prepareImportedRows(model, modelDef, rows);
        droppedKeys += prepared.droppedKeys;
        preparedRows.push({ model, rows: prepared.rows });
      } catch (error) {
        if (!(error instanceof AppRowValidationError)) throw error;
        rowIssues.push(...error.issues);
      }
    }
    if (rowIssues.length > 0) {
      await cleanupScripts();
      return {
        ok: false,
        status: 400,
        error: "invalid bundle rows",
        issues: rowIssues.slice(0, 50),
      };
    }
    if (droppedKeys > 0) {
      warnings.push(
        `${droppedKeys} row value(s) for columns the definition does not declare were dropped`,
      );
    }

    let app: AppRecord;
    try {
      app = await createApp({
        ...(options.keepId ? { id: bundle.app.id } : {}),
        name: bundle.app.name,
        description: bundle.app.description,
        definition: parsed.definition,
      });
    } catch (error) {
      // keepId lost a race with another create of the same id.
      if (options.keepId && (await getApp(bundle.app.id))) {
        await cleanupScripts();
        return { ok: false, status: 409, error: `app "${bundle.app.id}" already exists` };
      }
      throw error;
    }

    const counts: Record<string, number> = {};
    try {
      for (const { model, rows } of preparedRows) {
        await writeImportedAppRows(app.id, model, parsed.definition.models[model]!, rows);
        counts[model] = rows.length;
      }
    } catch (error) {
      await purgeAppRows(app.id, Object.keys(parsed.definition.models), async () => {
        await deleteApp(app.id);
      });
      throw error;
    }

    warnings.push(...(await requirementWarnings(parsed.definition)));
    warnings.push(...(await scriptCompatWarnings(parsed.definition)));
    return { ok: true, app, scriptIds, rows: counts, warnings };
  } catch (error) {
    await cleanupScripts();
    throw error;
  }
}

/**
 * Point script actions and sync sources at the local script ids. A sync
 * source whose connection is not reachable here loses the `connection` key
 * (definition validation would refuse it) and gets a warning.
 */
async function rewriteScriptRefs(
  definition: Record<string, unknown>,
  scriptIds: Record<string, string>,
): Promise<string[]> {
  const warnings: string[] = [];
  const remap = (target: Record<string, unknown>) => {
    if (typeof target.scriptId === "string" && Object.hasOwn(scriptIds, target.scriptId)) {
      target.scriptId = scriptIds[target.scriptId];
    }
  };
  const actions = asObject(definition.actions);
  for (const action of Object.values(actions ?? {})) {
    const record = asObject(action);
    if (record) remap(record);
  }
  for (const [modelName, model] of Object.entries(asObject(definition.models) ?? {})) {
    const sources = asObject(asObject(model)?.sources);
    for (const [sourceName, source] of Object.entries(sources ?? {})) {
      const record = asObject(source);
      if (!record) continue;
      remap(record);
      if (typeof record.connection !== "string" || typeof record.scriptId !== "string") continue;
      const script = await getScriptById(record.scriptId);
      if (!script) continue;
      const runAs = await resolveSyncRunAs(script);
      if (!(await isScriptConnectionReachable(record.connection, { agentId: runAs }))) {
        warnings.push(
          `sync source ${modelName}.${sourceName}: connection "${record.connection}" is missing here; the import dropped it, so a sync pulls without it`,
        );
        delete record.connection;
      }
    }
  }
  return warnings;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const CONNECTION_REF =
  /\bctx\.(api|mcp)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])/g;
const BINDING_PLACEHOLDER = /\[REDACTED:([A-Za-z0-9_.:-]+)\]/g;
const CONFIG_GET = /\bconfig\s*\.\s*get\s*\(\s*["'`]([A-Za-z0-9_.:-]+)["'`]\s*\)/g;

/** What a script's source names that must exist where it runs. A static scan: dynamic names are missed. */
export function scriptRequirements(source: string): {
  connections: string[];
  bindings: string[];
  configKeys: string[];
} {
  const connections = new Set<string>();
  for (const match of source.matchAll(CONNECTION_REF)) {
    const slug = match[2] ?? match[3];
    if (slug) connections.add(slug);
  }
  return {
    connections: [...connections].sort(),
    bindings: [...new Set([...source.matchAll(BINDING_PLACEHOLDER)].map((m) => m[1]!))].sort(),
    configKeys: [...new Set([...source.matchAll(CONFIG_GET)].map((m) => m[1]!))].sort(),
  };
}

/**
 * One warning per script action or sync source whose script calls a
 * connection, a credential binding or a config key this swarm lacks for the
 * identity the script runs as.
 */
async function requirementWarnings(definition: AppDefinition): Promise<string[]> {
  const warnings: string[] = [];
  for (const [scriptId, paths] of collectScriptReferences(definition)) {
    const script = await getScriptById(scriptId);
    if (!script) continue;
    const required = scriptRequirements(script.source);
    if (required.connections.length + required.bindings.length + required.configKeys.length === 0) {
      continue;
    }
    const runAs = getSavedScriptOwnerAgentId(script) ?? (await resolveSyncRunAs(script));
    const missing: string[] = [];
    for (const slug of required.connections) {
      if (!(await isScriptConnectionReachable(slug, { agentId: runAs }))) {
        missing.push(`connection "${slug}"`);
      }
    }
    if (required.bindings.length > 0) {
      const keys = new Set(
        (await listRelationalCredentialBindings({ agentId: runAs })).map((b) => b.configKey),
      );
      for (const key of required.bindings) {
        if (!keys.has(key)) missing.push(`credential binding "${key}"`);
      }
    }
    if (required.configKeys.length > 0) {
      const keys = new Set((await getResolvedConfig(runAs)).map((config) => config.key));
      for (const key of required.configKeys) {
        if (!keys.has(key)) missing.push(`config key "${key}"`);
      }
    }
    if (missing.length > 0) {
      warnings.push(
        `${paths.join(", ")} (script "${script.name}") needs ${missing.join(", ")}, missing here`,
      );
    }
  }
  return warnings;
}

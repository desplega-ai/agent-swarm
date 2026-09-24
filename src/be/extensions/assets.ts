/**
 * Assets an extension ships: scripts, schedules, workflows and skills.
 *
 * Two stages, because script checks spawn processes and must not hold the write lock:
 * `preflightAssets` runs outside any transaction and returns a write plan;
 * `reconcileAssets` runs inside the caller's transaction and only writes.
 *
 * Every asset the extension created has an `extension_assets` row. Its `seededHash`
 * lets upgrades and uninstall tell pristine rows (safe to update or delete) from rows
 * a user edited (kept, and reported). The rule is the seed runner's (`src/be/seed/runner.ts`).
 *
 * Each kind is a small adapter (find, create, update, delete, and for the kinds that
 * run on their own, get/set enabled). Scripts have no enabled state: they run only
 * when called.
 */
import { parseWorkflowText, skillDirs } from "../../extensions/manifest-format";
import { calculateNextRun } from "../../scheduler/scheduler";
import { extractScriptSignature } from "../../scripts-runtime/extract-signature";
import { validateScriptImports } from "../../scripts-runtime/import-allowlist";
import type {
  ExtensionManifest,
  ExtensionWorkflowFile,
  ScheduledTask,
  Workflow,
} from "../../types";
import { getExecutorRegistry } from "../../workflows";
import { validateDefinition } from "../../workflows/definition";
import {
  computeContentHash,
  createScheduledTask,
  createSkill,
  createWorkflow,
  deleteScheduledTask,
  deleteSkill,
  deleteSkillFile,
  deleteWorkflow,
  getDbClient,
  getScheduledTaskById,
  getScheduledTaskByName,
  getSkillById,
  getSkillFiles,
  getWorkflow,
  updateScheduledTask,
  updateSkill,
  updateWorkflow,
  upsertSkillFiles,
} from "../db";
import { deleteScript, getScript, upsertScriptByName } from "../scripts/db";
import { embedScript } from "../scripts/embeddings";
import { extractArgsJsonSchema } from "../scripts/extract-schema";
import { typecheckScript } from "../scripts/typecheck";
import { type ParsedSkill, parseSkillContent } from "../skill-parser";

export type ExtensionAssetKind = "script" | "schedule" | "workflow" | "skill";

type ScriptPlan = {
  kind: "script";
  name: string;
  source: string;
  description: string;
  intent: string;
  signatureJson: string;
  argsJsonSchema: string | null;
  hash: string;
};

type ScheduleSpec = {
  name: string;
  description: string | null;
  scriptName: string;
  cronExpression: string | null;
  intervalMs: number | null;
  timezone: string;
  scriptArgs: Record<string, unknown>;
};
type SchedulePlan = { kind: "schedule"; name: string; spec: ScheduleSpec; hash: string };

type WorkflowSpec = {
  name: string;
  description: string | null;
  definition: ExtensionWorkflowFile["definition"];
  triggers: NonNullable<ExtensionWorkflowFile["triggers"]>;
  cooldown: ExtensionWorkflowFile["cooldown"] | null;
  input: ExtensionWorkflowFile["input"] | null;
  triggerSchema: ExtensionWorkflowFile["triggerSchema"] | null;
};
type WorkflowPlan = { kind: "workflow"; name: string; spec: WorkflowSpec; hash: string };

type SkillFileSpec = { path: string; content: string };
type SkillPlan = {
  kind: "skill";
  name: string;
  content: string;
  parsed: ParsedSkill;
  files: SkillFileSpec[];
  hash: string;
};

type Plan = ScriptPlan | SchedulePlan | WorkflowPlan | SkillPlan;

export type AssetPlan = {
  scripts: ScriptPlan[];
  schedules: SchedulePlan[];
  workflows: WorkflowPlan[];
  skills: SkillPlan[];
};

export type PreflightResult = { ok: true; plan: AssetPlan } | { ok: false; diagnostics: string[] };

export type AssetRef = { kind: ExtensionAssetKind; name: string };

export type ReconcileResult = {
  created: AssetRef[];
  updated: AssetRef[];
  /** Edited by a user since install: left as is. */
  skipped: AssetRef[];
  /** Dropped from the manifest and pristine: deleted. */
  deleted: AssetRef[];
  /** Dropped from the manifest but edited: kept and no longer tracked. */
  detached: AssetRef[];
};

export type RemoveResult = { deleted: AssetRef[]; detached: AssetRef[] };

type ExtensionAssetRow = {
  id: string;
  extensionId: string;
  kind: ExtensionAssetKind;
  assetId: string;
  name: string;
  seededHash: string;
  enabledBefore: number | null;
};

/** Raised inside the install transaction; rolls back every write. */
export class ExtensionAssetConflictError extends Error {
  constructor(readonly diagnostics: string[]) {
    super(diagnostics.join("\n"));
    this.name = "ExtensionAssetConflictError";
  }
}

// ─── Hashing (never includes enabled state) ─────────────────────────────────

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function hashOf(value: unknown): string {
  return computeContentHash(JSON.stringify(canonicalJson(value)));
}

/** Kept byte-compatible with the first release: stored seededHash values depend on it. */
function scheduleHash(spec: ScheduleSpec): string {
  return computeContentHash(
    JSON.stringify([
      spec.name,
      spec.description,
      spec.scriptName,
      spec.cronExpression,
      spec.intervalMs,
      spec.timezone,
      canonicalJson(spec.scriptArgs),
    ]),
  );
}

function liveScheduleSpec(schedule: ScheduledTask): ScheduleSpec {
  return {
    name: schedule.name,
    description: schedule.description ?? null,
    scriptName: schedule.scriptName ?? "",
    cronExpression: schedule.cronExpression ?? null,
    intervalMs: schedule.intervalMs ?? null,
    timezone: schedule.timezone,
    scriptArgs: schedule.scriptArgs ?? {},
  };
}

function liveWorkflowSpec(workflow: Workflow): WorkflowSpec {
  return {
    name: workflow.name,
    description: workflow.description ?? null,
    definition: workflow.definition,
    triggers: workflow.triggers ?? [],
    cooldown: workflow.cooldown ?? null,
    input: workflow.input ?? null,
    triggerSchema: workflow.triggerSchema ?? null,
  };
}

function skillHash(content: string, files: SkillFileSpec[]): string {
  return hashOf({
    content,
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.content]),
  });
}

// ─── Preflight (outside any transaction) ────────────────────────────────────

export async function preflightAssets(
  manifest: ExtensionManifest,
  files: Record<string, string>,
): Promise<PreflightResult> {
  const diagnostics: string[] = [];
  const prefix = `${manifest.name}-`;

  const scripts: ScriptPlan[] = [];
  for (const script of manifest.assets.scripts ?? []) {
    const source = files[script.file];
    if (source === undefined) {
      diagnostics.push(`script ${script.name}: file "${script.file}" is missing from the bundle`);
      continue;
    }
    const imports = validateScriptImports(source);
    if (!imports.ok) {
      diagnostics.push(`script ${script.name}: ${imports.diagnostic}`);
      continue;
    }
    const typecheck = await typecheckScript(source);
    if (!typecheck.ok) {
      diagnostics.push(
        ...typecheck.diagnostics.map((line) => `script ${script.name} (${script.file}): ${line}`),
      );
      continue;
    }
    scripts.push({
      kind: "script",
      name: script.name,
      source,
      description: script.description,
      intent: script.intent ?? script.description,
      signatureJson: JSON.stringify(extractScriptSignature(source)),
      argsJsonSchema: await extractArgsJsonSchema(source),
      hash: computeContentHash(source),
    });
  }

  const schedules: SchedulePlan[] = [];
  for (const schedule of manifest.assets.schedules ?? []) {
    const spec: ScheduleSpec = {
      name: schedule.name,
      description: schedule.description ?? null,
      scriptName: schedule.script,
      cronExpression: schedule.cronExpression ?? null,
      intervalMs: schedule.intervalMs ?? null,
      timezone: schedule.timezone ?? "UTC",
      scriptArgs: schedule.args ?? {},
    };
    try {
      calculateNextRun(timingOf(spec));
    } catch (error) {
      diagnostics.push(`schedule ${schedule.name}: ${errorText(error)}`);
      continue;
    }
    schedules.push({ kind: "schedule", name: schedule.name, spec, hash: scheduleHash(spec) });
  }

  const workflows: WorkflowPlan[] = [];
  for (const asset of manifest.assets.workflows ?? []) {
    const text = files[asset.file];
    if (text === undefined) {
      diagnostics.push(`workflow ${asset.file}: file is missing from the bundle`);
      continue;
    }
    let parsed: ExtensionWorkflowFile;
    try {
      parsed = parseWorkflowText(asset.file, text, manifest.name);
    } catch (error) {
      diagnostics.push(errorText(error));
      continue;
    }
    const validation = validateDefinition(parsed.definition, getExecutorRegistry());
    if (!validation.valid) {
      diagnostics.push(`workflow ${parsed.name}: ${validation.errors.join("; ")}`);
      continue;
    }
    const spec: WorkflowSpec = {
      name: parsed.name,
      description: parsed.description ?? null,
      definition: parsed.definition,
      triggers: parsed.triggers ?? [],
      cooldown: parsed.cooldown ?? null,
      input: parsed.input ?? null,
      triggerSchema: parsed.triggerSchema ?? null,
    };
    workflows.push({ kind: "workflow", name: parsed.name, spec, hash: hashOf(spec) });
  }

  const skills: SkillPlan[] = [];
  for (const dir of skillDirs(manifest)) {
    const content = files[`${dir}/SKILL.md`];
    if (content === undefined) {
      diagnostics.push(`skill ${dir}: SKILL.md is missing from the bundle`);
      continue;
    }
    let parsed: ParsedSkill;
    try {
      parsed = parseSkillContent(content);
    } catch (error) {
      diagnostics.push(`skill ${dir}: ${errorText(error)}`);
      continue;
    }
    if (!parsed.name.startsWith(prefix)) {
      diagnostics.push(`skill ${dir}: name "${parsed.name}" must start with "${prefix}"`);
      continue;
    }
    const filesPrefix = `${dir}/files/`;
    const skillFiles = Object.entries(files)
      .filter(([path]) => path.startsWith(filesPrefix))
      .map(([path, fileContent]) => ({
        path: path.slice(filesPrefix.length),
        content: fileContent,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    skills.push({
      kind: "skill",
      name: parsed.name,
      content,
      parsed,
      files: skillFiles,
      hash: skillHash(content, skillFiles),
    });
  }

  const seen = new Set<string>();
  for (const item of [...workflows, ...skills]) {
    const key = `${item.kind}:${item.name}`;
    if (seen.has(key)) diagnostics.push(`duplicate ${item.kind} name "${item.name}"`);
    seen.add(key);
  }

  return diagnostics.length > 0
    ? { ok: false, diagnostics }
    : { ok: true, plan: { scripts, schedules, workflows, skills } };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timingOf(spec: {
  cronExpression: string | null;
  intervalMs: number | null;
  timezone: string;
}): ScheduledTask {
  return {
    cronExpression: spec.cronExpression ?? undefined,
    intervalMs: spec.intervalMs ?? undefined,
    timezone: spec.timezone,
  } as ScheduledTask;
}

// ─── Adapters ───────────────────────────────────────────────────────────────

type Live = { id: string; hash: string };
type Actor = string | null;

type Adapter<P extends Plan> = {
  /** The live row with this name, whoever owns it. */
  find(name: string): Promise<Live | null>;
  create(plan: P, agentId: string, actor: Actor): Promise<string>;
  update(plan: P, id: string, agentId: string, actor: Actor): Promise<void>;
  remove(row: ExtensionAssetRow): Promise<void>;
  /** Kinds that run on their own; scripts have no enabled state. */
  enabled?: {
    get(id: string): Promise<boolean | null>;
    set(id: string, on: boolean, actor: Actor): Promise<void>;
  };
};

const scriptAdapter: Adapter<ScriptPlan> = {
  async find(name) {
    const script = await getScript({ name, scope: "global" });
    return script ? { id: script.id, hash: script.contentHash } : null;
  },
  async create(plan, agentId, actor) {
    return await writeScript(plan, agentId, actor);
  },
  async update(plan, _id, agentId, actor) {
    // upsertScriptByName keeps the original creator and records agentId on the new version.
    await writeScript(plan, agentId, actor);
  },
  async remove(row) {
    await deleteScript({ name: row.name, scope: "global" });
  },
};

async function writeScript(plan: ScriptPlan, agentId: string, actor: Actor) {
  const result = await upsertScriptByName({
    name: plan.name,
    scope: "global",
    scopeId: null,
    source: plan.source,
    description: plan.description,
    intent: plan.intent,
    signatureJson: plan.signatureJson,
    argsJsonSchema: plan.argsJsonSchema,
    fsMode: "none",
    agentId,
    isScratch: false,
    typeChecked: true,
    changeReason: "Installed by extension",
    embeddingMode: "skip",
    createdBy: actor,
  });
  // Embedding calls out to a provider; never inside the write lock.
  const script = result.script;
  getDbClient().afterCommit(() => embedScript(script));
  return script.id;
}

const scheduleAdapter: Adapter<SchedulePlan> = {
  async find(name) {
    const schedule = await getScheduledTaskByName(name);
    return schedule ? { id: schedule.id, hash: scheduleHash(liveScheduleSpec(schedule)) } : null;
  },
  async create(plan, agentId, actor) {
    const schedule = await createScheduledTask({
      name: plan.spec.name,
      description: plan.spec.description ?? undefined,
      cronExpression: plan.spec.cronExpression ?? undefined,
      intervalMs: plan.spec.intervalMs ?? undefined,
      timezone: plan.spec.timezone,
      targetType: "script",
      scriptName: plan.spec.scriptName,
      scriptArgs: plan.spec.scriptArgs,
      enabled: false,
      nextRunAt: undefined,
      createdByAgentId: agentId,
      createdBy: actor ?? undefined,
    });
    return schedule.id;
  },
  async update(plan, id, _agentId, actor) {
    const live = await getScheduledTaskById(id);
    if (!live) return;
    const spec = plan.spec;
    const timingChanged =
      (live.cronExpression ?? null) !== spec.cronExpression ||
      (live.intervalMs ?? null) !== spec.intervalMs ||
      live.timezone !== spec.timezone;
    await updateScheduledTask(id, {
      description: spec.description ?? "",
      cronExpression: spec.cronExpression,
      intervalMs: spec.intervalMs,
      timezone: spec.timezone,
      scriptName: spec.scriptName,
      scriptArgs: spec.scriptArgs,
      ...(live.enabled && timingChanged ? { nextRunAt: calculateNextRun(timingOf(spec)) } : {}),
      ...(actor ? { updatedBy: actor } : {}),
    });
  },
  async remove(row) {
    await deleteScheduledTask(row.assetId);
  },
  enabled: {
    async get(id) {
      return (await getScheduledTaskById(id))?.enabled ?? null;
    },
    async set(id, on, actor) {
      const schedule = await getScheduledTaskById(id);
      if (!schedule) return;
      await updateScheduledTask(id, {
        enabled: on,
        // Disable must null nextRunAt; enable recomputes it (same rule as PUT /api/schedules).
        nextRunAt: on ? calculateNextRun(schedule) : null,
        ...(actor ? { updatedBy: actor } : {}),
      });
    },
  },
};

async function findWorkflowByName(name: string): Promise<Workflow | null> {
  const row = await getDbClient().get<{ id: string }>("SELECT id FROM workflows WHERE name = ?", [
    name,
  ]);
  return row ? await getWorkflow(row.id) : null;
}

const workflowAdapter: Adapter<WorkflowPlan> = {
  async find(name) {
    const workflow = await findWorkflowByName(name);
    return workflow ? { id: workflow.id, hash: hashOf(liveWorkflowSpec(workflow)) } : null;
  },
  async create(plan, agentId, actor) {
    const workflow = await createWorkflow({
      name: plan.spec.name,
      description: plan.spec.description ?? undefined,
      definition: plan.spec.definition,
      triggers: plan.spec.triggers,
      cooldown: plan.spec.cooldown ?? undefined,
      input: plan.spec.input ?? undefined,
      triggerSchema: plan.spec.triggerSchema ?? undefined,
      createdByAgentId: agentId,
      createdBy: actor ?? undefined,
      enabled: false,
    });
    return workflow.id;
  },
  async update(plan, id, _agentId, actor) {
    await updateWorkflow(id, {
      description: plan.spec.description ?? "",
      definition: plan.spec.definition,
      triggers: plan.spec.triggers,
      cooldown: plan.spec.cooldown ?? null,
      input: plan.spec.input ?? null,
      triggerSchema: plan.spec.triggerSchema ?? null,
      ...(actor ? { updatedBy: actor } : {}),
    });
  },
  async remove(row) {
    await deleteWorkflow(row.assetId);
  },
  enabled: {
    async get(id) {
      return (await getWorkflow(id))?.enabled ?? null;
    },
    async set(id, on, actor) {
      await updateWorkflow(id, { enabled: on, ...(actor ? { updatedBy: actor } : {}) });
    },
  },
};

async function findSkillByName(name: string) {
  // Any scope: an extension skill must not shadow a same-named skill anywhere.
  const row = await getDbClient().get<{ id: string }>(
    "SELECT id FROM skills WHERE name = ? ORDER BY createdAt LIMIT 1",
    [name],
  );
  return row ? await getSkillById(row.id) : null;
}

const skillAdapter: Adapter<SkillPlan> = {
  async find(name) {
    const skill = await findSkillByName(name);
    if (!skill) return null;
    const files = (await getSkillFiles(skill.id)).map((file) => ({
      path: file.path,
      content: file.content,
    }));
    return { id: skill.id, hash: skillHash(skill.content, files) };
  },
  async create(plan, agentId) {
    const skill = await createSkill({
      ...skillFields(plan),
      type: "personal",
      // Global, not swarm: visible only to agents it is installed on.
      scope: "global",
      ownerAgentId: agentId,
      systemDefault: false,
      isEnabled: false,
    });
    await upsertSkillFiles(skill.id, plan.files);
    return skill.id;
  },
  async update(plan, id) {
    await updateSkill(id, skillFields(plan));
    const wanted = new Set(plan.files.map((file) => file.path));
    for (const file of await getSkillFiles(id)) {
      if (!wanted.has(file.path)) await deleteSkillFile(id, file.path);
    }
    await upsertSkillFiles(id, plan.files);
  },
  async remove(row) {
    await deleteSkill(row.assetId);
  },
  enabled: {
    async get(id) {
      return (await getSkillById(id))?.isEnabled ?? null;
    },
    async set(id, on) {
      await updateSkill(id, { isEnabled: on });
    },
  },
};

function skillFields(plan: SkillPlan) {
  const { parsed } = plan;
  return {
    name: parsed.name,
    description: parsed.description,
    content: plan.content,
    allowedTools: parsed.allowedTools,
    model: parsed.model,
    effort: parsed.effort,
    context: parsed.context,
    agent: parsed.agent,
    disableModelInvocation: parsed.disableModelInvocation,
    userInvocable: parsed.userInvocable,
  };
}

const ADAPTERS: { [K in ExtensionAssetKind]: Adapter<Extract<Plan, { kind: K }>> } = {
  script: scriptAdapter,
  schedule: scheduleAdapter,
  workflow: workflowAdapter,
  skill: skillAdapter,
};

function adapterFor(kind: ExtensionAssetKind): Adapter<Plan> {
  return ADAPTERS[kind] as unknown as Adapter<Plan>;
}

/** Scripts first (schedules and swarm-script nodes call them), skills last. */
const KIND_ORDER: ExtensionAssetKind[] = ["script", "schedule", "workflow", "skill"];

// ─── Provenance ─────────────────────────────────────────────────────────────

async function listAssetRows(extensionId: string): Promise<ExtensionAssetRow[]> {
  return await getDbClient().query<ExtensionAssetRow>(
    "SELECT * FROM extension_assets WHERE extensionId = ? ORDER BY kind, name",
    [extensionId],
  );
}

async function upsertAssetRow(args: {
  extensionId: string;
  kind: ExtensionAssetKind;
  name: string;
  assetId: string;
  seededHash: string;
  enabledBefore: number | null;
  actor: Actor;
}): Promise<void> {
  const now = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO extension_assets (
      id, extensionId, kind, assetId, name, seededHash, enabledBefore,
      created_by, updated_by, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(extensionId, kind, name) DO UPDATE SET
      assetId = excluded.assetId, seededHash = excluded.seededHash,
      enabledBefore = excluded.enabledBefore, updated_by = excluded.updated_by,
      updatedAt = excluded.updatedAt`,
    [
      crypto.randomUUID(),
      args.extensionId,
      args.kind,
      args.assetId,
      args.name,
      args.seededHash,
      args.enabledBefore,
      args.actor,
      args.actor,
      now,
      now,
    ],
  );
}

async function setEnabledBefore(row: ExtensionAssetRow, value: number | null, actor: Actor) {
  await getDbClient().run(
    "UPDATE extension_assets SET enabledBefore = ?, updated_by = ?, updatedAt = ? WHERE id = ?",
    [value, actor, new Date().toISOString(), row.id],
  );
}

async function deleteAssetRow(id: string): Promise<void> {
  await getDbClient().run("DELETE FROM extension_assets WHERE id = ?", [id]);
}

// ─── Reconcile (inside the caller's transaction) ────────────────────────────

/**
 * Bring the extension's assets in line with `plan`. Must run inside a transaction:
 * a name collision throws `ExtensionAssetConflictError` and the caller's rollback
 * discards everything written so far, including the extension row.
 */
export async function reconcileAssets(args: {
  extensionId: string;
  agentId: string;
  plan: AssetPlan;
  actor?: string | null;
}): Promise<ReconcileResult> {
  const actor = args.actor ?? null;
  const result: ReconcileResult = {
    created: [],
    updated: [],
    skipped: [],
    deleted: [],
    detached: [],
  };
  const tracked = new Map(
    (await listAssetRows(args.extensionId)).map((row) => [`${row.kind}:${row.name}`, row]),
  );

  const desired: Plan[] = [
    ...args.plan.scripts,
    ...args.plan.schedules,
    ...args.plan.workflows,
    ...args.plan.skills,
  ];
  const conflicts: string[] = [];
  for (const item of desired) {
    if (tracked.has(`${item.kind}:${item.name}`)) continue;
    if (await adapterFor(item.kind).find(item.name)) {
      conflicts.push(
        `${item.kind} "${item.name}" already exists and does not belong to this extension`,
      );
    }
  }
  if (conflicts.length > 0) throw new ExtensionAssetConflictError(conflicts);

  for (const item of desired) {
    const adapter = adapterFor(item.kind);
    const ref = { kind: item.kind, name: item.name };
    const row = tracked.get(`${item.kind}:${item.name}`);
    tracked.delete(`${item.kind}:${item.name}`);
    const live = await adapter.find(item.name);

    if (row && live && live.hash === item.hash) {
      // Already what this version ships (possibly because a user made the same edit): adopt it.
      if (row.seededHash !== item.hash) {
        await upsertAssetRow({ ...row, seededHash: item.hash, actor });
      }
      continue;
    }
    if (row && live && live.hash !== row.seededHash) {
      result.skipped.push(ref);
      continue;
    }

    let assetId: string;
    if (live) {
      await adapter.update(item, live.id, args.agentId, actor);
      assetId = live.id;
    } else {
      assetId = await adapter.create(item, args.agentId, actor);
    }
    await upsertAssetRow({
      extensionId: args.extensionId,
      kind: item.kind,
      name: item.name,
      assetId,
      seededHash: item.hash,
      // A (re)created asset starts disabled and turns on at the next enable; an
      // updated one keeps its state. Scripts have none.
      enabledBefore: adapter.enabled ? (live ? (row?.enabledBefore ?? null) : 1) : null,
      actor,
    });
    (live ? result.updated : result.created).push(ref);
  }

  // Rows the manifest no longer declares, dependents first.
  for (const row of sortForRemoval([...tracked.values()])) {
    const outcome = await removeTrackedAsset(row);
    if (outcome) result[outcome].push({ kind: row.kind, name: row.name });
  }
  return result;
}

function sortForRemoval(rows: ExtensionAssetRow[]): ExtensionAssetRow[] {
  return [...rows].sort(
    (a, b) =>
      KIND_ORDER.indexOf(b.kind) - KIND_ORDER.indexOf(a.kind) || a.name.localeCompare(b.name),
  );
}

async function removeTrackedAsset(row: ExtensionAssetRow): Promise<"deleted" | "detached" | null> {
  const live = await adapterFor(row.kind).find(row.name);
  await deleteAssetRow(row.id);
  if (!live || live.id !== row.assetId) return null;
  if (live.hash !== row.seededHash) return "detached";
  await adapterFor(row.kind).remove(row);
  return "deleted";
}

// ─── Enable / disable / uninstall ───────────────────────────────────────────

/**
 * Pause or resume the extension's schedules, workflows and skills. Disable records each
 * asset's live state, so one a user turned off stays off after the next enable. Scripts
 * have no enabled state and are skipped.
 */
export async function setAssetsEnabled(
  extensionId: string,
  on: boolean,
  actor?: string | null,
): Promise<void> {
  const by = actor ?? null;
  await getDbClient().transaction(async () => {
    for (const row of await listAssetRows(extensionId)) {
      const toggle = adapterFor(row.kind).enabled;
      if (!toggle) continue;
      const current = await toggle.get(row.assetId);
      if (current === null) continue;
      if (on) {
        // NULL: never paused by us, the live state is the user's. Leave it.
        if (row.enabledBefore === null) continue;
        const restore = row.enabledBefore === 1;
        if (restore !== current) await toggle.set(row.assetId, restore, by);
        await setEnabledBefore(row, null, by);
      } else {
        // Already paused by us: keep the first recorded state.
        if (row.enabledBefore === null) await setEnabledBefore(row, current ? 1 : 0, by);
        if (current) await toggle.set(row.assetId, false, by);
      }
    }
  });
}

/** Uninstall: delete pristine assets, detach edited ones. Call inside the delete transaction. */
export async function removeAssets(extensionId: string): Promise<RemoveResult> {
  const result: RemoveResult = { deleted: [], detached: [] };
  for (const row of sortForRemoval(await listAssetRows(extensionId))) {
    const outcome = await removeTrackedAsset(row);
    if (outcome) result[outcome].push({ kind: row.kind, name: row.name });
  }
  return result;
}

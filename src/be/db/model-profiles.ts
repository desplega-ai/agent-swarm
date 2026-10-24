/**
 * Model profiles: a named (harness, model, effort) picked per task (`profile`)
 * or applied as an agent's default (agent-scoped `MODEL_PROFILE` config row).
 * Claim resolves them (`src/be/model-tier-resolution.ts`). See
 * runbooks/model-tiers.md § Model profiles.
 */
import {
  type ModelProfile,
  type ModelProfileCredentials,
  ModelProfileCredentialsSchema,
  type ProviderName,
  ProviderNameSchema,
  type ReasoningEffort,
  ReasoningEffortSchema,
} from "../../types";
import {
  checkProfileForAgent,
  formatProfileCheckFailures,
  vcsRepoId,
} from "../model-profile-check";
import { getDbClient } from "./runtime";
import { SUPERSEDED_RESUME_REPAIR_WINDOW_MS } from "./tasks/read";

/** Agent-scoped swarm_config key holding the agent's default profile name. */
export const MODEL_PROFILE_CONFIG_KEY = "MODEL_PROFILE";

type ModelProfileRow = {
  id: string;
  name: string;
  harness: string;
  model: string;
  effort: string | null;
  allowCustomModel: number;
  description: string | null;
  seededFrom: string | null;
  credentialAllowlist: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

/** The stored allowlist JSON as a map, or null when unset or unreadable. */
function parseCredentialAllowlist(value: string | null): ModelProfileCredentials | null {
  if (!value) return null;
  try {
    const parsed = ModelProfileCredentialsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function serializeCredentialAllowlist(
  value: ModelProfileCredentials | null | undefined,
): string | null {
  return value && Object.keys(value).length > 0 ? JSON.stringify(value) : null;
}

function rowToModelProfile(row: ModelProfileRow): ModelProfile {
  return {
    id: row.id,
    name: row.name,
    harness: ProviderNameSchema.parse(row.harness),
    model: row.model,
    effort: ReasoningEffortSchema.safeParse(row.effort).success
      ? (row.effort as ReasoningEffort)
      : null,
    allowCustomModel: row.allowCustomModel === 1,
    description: row.description,
    seededFrom: row.seededFrom,
    credentials: parseCredentialAllowlist(row.credentialAllowlist),
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export async function listModelProfiles(
  filter: { harness?: ProviderName } = {},
): Promise<ModelProfile[]> {
  const rows = filter.harness
    ? await getDbClient().query<ModelProfileRow>(
        "SELECT * FROM model_profiles WHERE harness = ? ORDER BY harness, name",
        [filter.harness],
      )
    : await getDbClient().query<ModelProfileRow>(
        "SELECT * FROM model_profiles ORDER BY harness, name",
      );
  return rows.map(rowToModelProfile);
}

export async function getModelProfileByName(name: string): Promise<ModelProfile | null> {
  const row = await getDbClient().get<ModelProfileRow>(
    "SELECT * FROM model_profiles WHERE name = ?",
    [name.trim()],
  );
  return row ? rowToModelProfile(row) : null;
}

export interface ModelProfileInput {
  name: string;
  harness: ProviderName;
  model: string;
  effort?: ReasoningEffort | null;
  allowCustomModel?: boolean;
  description?: string | null;
  seededFrom?: string | null;
  /** Pooled-key allowlist, stored as `credentialAllowlist`; null uses the whole pool. */
  credentials?: ModelProfileCredentials | null;
}

/** Insert a profile. Returns null when the name is taken. */
export async function createModelProfile(
  input: ModelProfileInput,
  audit: { userId?: string | null } = {},
): Promise<ModelProfile | null> {
  const now = new Date().toISOString();
  const row = await getDbClient().get<ModelProfileRow>(
    `INSERT INTO model_profiles
       (id, name, harness, model, effort, allowCustomModel, description, seededFrom, credentialAllowlist, createdAt, lastUpdatedAt, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO NOTHING
     RETURNING *`,
    [
      crypto.randomUUID(),
      input.name,
      input.harness,
      input.model,
      input.effort ?? null,
      input.allowCustomModel ? 1 : 0,
      input.description ?? null,
      input.seededFrom ?? null,
      serializeCredentialAllowlist(input.credentials),
      now,
      now,
      audit.userId ?? null,
      audit.userId ?? null,
    ],
  );
  return row ? rowToModelProfile(row) : null;
}

export type ModelProfilePatch = Partial<
  Pick<ModelProfileInput, "model" | "effort" | "allowCustomModel" | "description" | "credentials">
>;

/**
 * Update a profile's model, effort, description or credential allowlist
 * (`credentials: null` clears it). The name and harness are fixed.
 */
export async function updateModelProfile(
  name: string,
  patch: ModelProfilePatch,
  audit: { userId?: string | null } = {},
): Promise<ModelProfile | null> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.model !== undefined) {
    sets.push("model = ?");
    params.push(patch.model);
  }
  if (patch.effort !== undefined) {
    sets.push("effort = ?");
    params.push(patch.effort);
  }
  if (patch.allowCustomModel !== undefined) {
    sets.push("allowCustomModel = ?");
    params.push(patch.allowCustomModel ? 1 : 0);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    params.push(patch.description);
  }
  if (patch.credentials !== undefined) {
    sets.push("credentialAllowlist = ?");
    params.push(serializeCredentialAllowlist(patch.credentials));
  }
  sets.push("lastUpdatedAt = ?", "updated_by = ?");
  params.push(new Date().toISOString(), audit.userId ?? null);
  const row = await getDbClient().get<ModelProfileRow>(
    `UPDATE model_profiles SET ${sets.join(", ")} WHERE name = ? RETURNING *`,
    [...params, name],
  );
  return row ? rowToModelProfile(row) : null;
}

/**
 * Tasks (alias `t`) that still hold their profile: unfinished ones, and
 * superseded ones still owed a resume. The resume copies the profile in a
 * later write than the supersede (HTTP supersede, heartbeat remediation), and
 * after a restart the heartbeat's orphan repair makes it, inside the same
 * window (`SUPERSEDED_RESUME_REPAIR_WINDOW_MS`). Binds one parameter: the
 * oldest `finishedAt` the repair still covers.
 */
const TASK_HOLDS_PROFILE_SQL = `(
  t.status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
  OR (t.status = 'superseded'
      AND t.workflowRunStepId IS NULL
      AND (t.finishedAt IS NULL OR t.finishedAt > ?)
      AND NOT EXISTS (
        SELECT 1 FROM agent_tasks c WHERE c.parentTaskId = t.id AND c.taskType = 'resume')))`;

function repairWindowStart(): string {
  return new Date(Date.now() - SUPERSEDED_RESUME_REPAIR_WINDOW_MS).toISOString();
}

/**
 * Who still points at a profile: agents with it as default, tasks that still
 * hold it, and schedules that fire tasks with it.
 */
export async function modelProfileReferences(
  name: string,
): Promise<{ agentIds: string[]; openTaskCount: number; scheduleIds: string[] }> {
  const agents = await getDbClient().query<{ scopeId: string }>(
    "SELECT scopeId FROM swarm_config WHERE scope = 'agent' AND key = ? AND value = ?",
    [MODEL_PROFILE_CONFIG_KEY, name],
  );
  const tasks = await getDbClient().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM agent_tasks t
      WHERE (t.profile = ? OR t.resolvedProfile = ?) AND ${TASK_HOLDS_PROFILE_SQL}`,
    [name, name, repairWindowStart()],
  );
  const schedules = await getDbClient().query<{ id: string }>(
    "SELECT id FROM scheduled_tasks WHERE profile = ? ORDER BY id",
    [name],
  );
  return {
    agentIds: agents.map((a) => a.scopeId),
    openTaskCount: tasks?.n ?? 0,
    scheduleIds: schedules.map((s) => s.id),
  };
}

/**
 * Which reference trigger (migrations 220, 240) refused a write: `missing` when
 * a task, a schedule or an agent default names a profile that does not exist.
 */
export function modelProfileRefError(error: unknown): "missing" | null {
  const message = error instanceof Error ? error.message : "";
  return message.includes("model-profile-missing:") ? "missing" : null;
}

/**
 * Delete a profile unless a task still holds it (`TASK_HOLDS_PROFILE_SQL`) as
 * its ask or as the profile claim applied (`resolvedProfile`, which a paused
 * task's resume re-reads for its credential allowlist), an
 * agent default names it, or a schedule names it. The check is part of the
 * DELETE statement, so a reference written after the caller's own count still
 * makes it `in-use`; the triggers in migrations 220 and 240 refuse the
 * opposite order (a reference written after this delete).
 */
export async function deleteModelProfile(name: string): Promise<"deleted" | "missing" | "in-use"> {
  const row = await getDbClient().get<{ id: string }>(
    `DELETE FROM model_profiles
      WHERE name = ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_tasks t
           WHERE (t.profile = model_profiles.name OR t.resolvedProfile = model_profiles.name)
             AND ${TASK_HOLDS_PROFILE_SQL})
        AND NOT EXISTS (
          SELECT 1 FROM swarm_config
           WHERE scope = 'agent' AND key = ? AND trim(value) = model_profiles.name)
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_tasks s WHERE s.profile = model_profiles.name)
      RETURNING id`,
    [name, repairWindowStart(), MODEL_PROFILE_CONFIG_KEY],
  );
  if (row) return "deleted";
  return (await getModelProfileByName(name)) ? "in-use" : "missing";
}

/** The agent's default profile name (agent-scoped MODEL_PROFILE), or null. */
export async function getAgentDefaultProfileName(agentId: string): Promise<string | null> {
  const row = await getDbClient().get<{ value: string }>(
    "SELECT value FROM swarm_config WHERE scope = 'agent' AND scopeId = ? AND key = ?",
    [agentId, MODEL_PROFILE_CONFIG_KEY],
  );
  return row?.value.trim() || null;
}

/**
 * Which of MODEL_OVERRIDE / REASONING_EFFORT_OVERRIDE the task's repo sets at
 * repo scope, exported or not. The worker env takes a repo row over the
 * agent's own (repo > agent), and a withheld one removes the key, so the
 * agent's default profile must not supply that axis. Finds the repo the way
 * the worker does (`fetchRepoConfig`). `includeSecrets: false` leaves out
 * secret rows, as `/api/config/resolved` does for a worker that cannot read
 * them (`readsRepoSecrets`): that worker's env never gets them.
 */
export async function repoModelOverrideKeys(
  vcsRepo: string | null | undefined,
  { includeSecrets = true }: { includeSecrets?: boolean } = {},
): Promise<Set<string>> {
  const repoId = await vcsRepoId(vcsRepo);
  if (!repoId) return new Set();
  const rows = await getDbClient().query<{ key: string }>(
    `SELECT key FROM swarm_config
      WHERE scope = 'repo' AND scopeId = ? AND key IN ('MODEL_OVERRIDE', 'REASONING_EFFORT_OVERRIDE')
        ${includeSecrets ? "" : "AND isSecret = 0"}`,
    [repoId],
  );
  return new Set(rows.map((row) => row.key));
}

/**
 * Why a task cannot ask for `profile`, or null when it can. The profile must
 * exist and, when the target agent is known, pass `checkProfileForAgent`
 * (harness, model, credentials, allowlist). A pooled task (no agent) is judged
 * per agent at claim instead. `profile` is exclusive with `model` and
 * `modelTier`, which pick the model another way.
 */
export async function taskProfileError(check: {
  profile?: string | null;
  model?: string | null;
  modelTier?: string | null;
  agentId?: string | null;
  /** The task's repo; its scoped credentials count, as on the worker. */
  vcsRepo?: string | null;
}): Promise<string | null> {
  const name = check.profile?.trim();
  if (!name) return null;
  if (check.model?.trim() || check.modelTier?.trim()) {
    return "Pass `profile`, or `model`/`modelTier`, not both.";
  }
  const profile = await getModelProfileByName(name);
  if (!profile) {
    return `Unknown model profile "${name}". List profiles with list-model-profiles.`;
  }
  if (!check.agentId) return null;
  const result = await checkProfileForAgent(check.agentId, name, { vcsRepo: check.vcsRepo });
  if (!result || result.ok) return null;
  return formatProfileCheckFailures(result);
}

/**
 * The profile half of a schedule update. `profile` and `model`/`modelTier`
 * pick the model two ways, so setting one clears the other, and sending both
 * is an error. A new profile, or a move of a profiled schedule to another
 * agent, is judged by `taskProfileError`. Returns the columns to write.
 */
export async function scheduleProfileUpdate(
  existing: { profile?: string | null; targetAgentId?: string | null },
  patch: {
    profile?: string | null;
    model?: string | null;
    modelTier?: string | null;
    targetAgentId?: string | null;
  },
): Promise<
  | { error: string }
  | { error?: undefined; fields: { profile?: string | null; model?: null; modelTier?: null } }
> {
  const profile = patch.profile === undefined ? undefined : patch.profile?.trim() || null;
  const agentId = patch.targetAgentId !== undefined ? patch.targetAgentId : existing.targetAgentId;
  if (profile) {
    const error = await taskProfileError({
      profile,
      model: patch.model,
      modelTier: patch.modelTier,
      agentId,
    });
    if (error) return { error };
    return { fields: { profile, model: null, modelTier: null } };
  }
  if (patch.model?.trim() || patch.modelTier?.trim() || profile === null) {
    return { fields: { profile: null } };
  }
  const agentChanged =
    patch.targetAgentId !== undefined && patch.targetAgentId !== existing.targetAgentId;
  if (agentChanged && existing.profile) {
    const error = await taskProfileError({ profile: existing.profile, agentId });
    if (error) return { error };
  }
  return { fields: {} };
}

type OverrideRowState = { value: string; exportToEnv?: number } | null;

/** What a config row does to the worker env: its value, withheld (exportToEnv off), or absent. */
function effectiveOverride(row: OverrideRowState): string | null {
  if (!row) return null;
  return row.exportToEnv === 0 ? "\u0000withheld" : row.value;
}

/**
 * An agent's default model profile (MODEL_PROFILE) beats its MODEL_OVERRIDE and
 * REASONING_EFFORT_OVERRIDE at claim. An effective change to either override, by
 * any path, drops the profile default, so a stale default never beats a fresh
 * override. Effective means what the worker env sees: the value, and whether
 * the row is exported (`exportToEnv`).
 */
export async function clearAgentModelProfileOnOverrideChange(
  agentId: string,
  key: string,
  before: OverrideRowState,
  after: OverrideRowState,
): Promise<void> {
  if (key !== "MODEL_OVERRIDE" && key !== "REASONING_EFFORT_OVERRIDE") return;
  if (effectiveOverride(before) === effectiveOverride(after)) return;
  await getDbClient().run(
    "DELETE FROM swarm_config WHERE scope = 'agent' AND scopeId = ? AND key = ?",
    [agentId, MODEL_PROFILE_CONFIG_KEY],
  );
}

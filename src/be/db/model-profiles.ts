/**
 * Model profiles: a named (harness, model, effort) picked per task (`profile`)
 * or applied as an agent's default (agent-scoped `MODEL_PROFILE` config row).
 * Claim resolves them (`src/be/model-tier-resolution.ts`). See
 * runbooks/model-tiers.md § Model profiles.
 */
import {
  type ModelProfile,
  type ProviderName,
  ProviderNameSchema,
  type ReasoningEffort,
  ReasoningEffortSchema,
} from "../../types";
import { getDbClient } from "./runtime";

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
  createdAt: string;
  lastUpdatedAt: string;
};

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
}

/** Insert a profile. Returns null when the name is taken. */
export async function createModelProfile(
  input: ModelProfileInput,
  audit: { userId?: string | null } = {},
): Promise<ModelProfile | null> {
  const now = new Date().toISOString();
  const row = await getDbClient().get<ModelProfileRow>(
    `INSERT INTO model_profiles
       (id, name, harness, model, effort, allowCustomModel, description, seededFrom, createdAt, lastUpdatedAt, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      now,
      now,
      audit.userId ?? null,
      audit.userId ?? null,
    ],
  );
  return row ? rowToModelProfile(row) : null;
}

export type ModelProfilePatch = Partial<
  Pick<ModelProfileInput, "model" | "effort" | "allowCustomModel" | "description">
>;

/** Update a profile's model, effort or description. The name and harness are fixed. */
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
  sets.push("lastUpdatedAt = ?", "updated_by = ?");
  params.push(new Date().toISOString(), audit.userId ?? null);
  const row = await getDbClient().get<ModelProfileRow>(
    `UPDATE model_profiles SET ${sets.join(", ")} WHERE name = ? RETURNING *`,
    [...params, name],
  );
  return row ? rowToModelProfile(row) : null;
}

/** Who still points at a profile: agents with it as default, and tasks not yet finished. */
export async function modelProfileReferences(
  name: string,
): Promise<{ agentIds: string[]; openTaskCount: number }> {
  const agents = await getDbClient().query<{ scopeId: string }>(
    "SELECT scopeId FROM swarm_config WHERE scope = 'agent' AND key = ? AND value = ?",
    [MODEL_PROFILE_CONFIG_KEY, name],
  );
  const tasks = await getDbClient().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM agent_tasks
      WHERE profile = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')`,
    [name],
  );
  return { agentIds: agents.map((a) => a.scopeId), openTaskCount: tasks?.n ?? 0 };
}

export async function deleteModelProfile(name: string): Promise<boolean> {
  const row = await getDbClient().get<{ id: string }>(
    "DELETE FROM model_profiles WHERE name = ? RETURNING id",
    [name],
  );
  return row !== null;
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
 * Why a task cannot ask for `profile`, or null when it can. PR 1 validity is
 * the harness only: the profile must exist and, when the target agent is known
 * and has a harness, run on that harness. `profile` is exclusive with `model`
 * and `modelTier`, which pick the model another way.
 */
export async function taskProfileError(check: {
  profile?: string | null;
  model?: string | null;
  modelTier?: string | null;
  agentId?: string | null;
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
  const agent = await getDbClient().get<{ harness: string | null }>(
    "SELECT COALESCE(harness_provider, provider) AS harness FROM agents WHERE id = ?",
    [check.agentId],
  );
  if (agent?.harness && agent.harness !== profile.harness) {
    return `Model profile "${name}" runs on the ${profile.harness} harness; the target agent runs ${agent.harness}.`;
  }
  return null;
}

/**
 * An agent's default model profile (MODEL_PROFILE) beats its MODEL_OVERRIDE and
 * REASONING_EFFORT_OVERRIDE at claim. A change to either override, by any path,
 * drops the profile default, so a stale default never beats a fresh override.
 */
export async function clearAgentModelProfileOnOverrideChange(
  agentId: string,
  key: string,
): Promise<void> {
  if (key !== "MODEL_OVERRIDE" && key !== "REASONING_EFFORT_OVERRIDE") return;
  await getDbClient().run(
    "DELETE FROM swarm_config WHERE scope = 'agent' AND scopeId = ? AND key = ?",
    [agentId, MODEL_PROFILE_CONFIG_KEY],
  );
}

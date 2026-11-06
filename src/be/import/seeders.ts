/**
 * Kind seeders for one import source. Each is a plain {@link Seeder} driven by
 * the shared harness, so change detection and edit preservation are the seed
 * framework's (`seed_state` kind `import:<sourceId>:<kind>`).
 *
 * Before a seeder runs, every item is resolved to its target row:
 *   - the row this source owns for the item key (`import_items`), else
 *   - no row with that name: create, else
 *   - a same-named row this source does not own: a conflict under `noop`, and
 *     adopted under `overwrite`. A row another source owns is always a conflict.
 */

import { matchesDefaultIdentityMd } from "../../prompts/defaults";
import type { Agent } from "../../types";
import { snapshotAndUpdateWorkflow } from "../../workflows/version";
import {
  computeContentHash,
  createSkill,
  createWorkflow,
  deleteSkillFile,
  getAgentById,
  getDbClient,
  getSkillById,
  getSkillFiles,
  getWorkflow,
  NOT_EXTENSION_AGENT_SQL,
  updateAgentProfile,
  updateSkill,
  upsertSkillFiles,
} from "../db";
import {
  hashOf,
  liveScriptSpec,
  liveSkillSpec,
  liveWorkflowSpec,
  scriptHash,
  skillHash,
} from "../extensions/assets";
import { getScript, getScriptById, upsertScriptByName } from "../scripts/db";
import type { Seeder, SeedItem } from "../seed/types";
import type {
  ImportedAgent,
  ImportedScript,
  ImportedSkill,
  ImportedWorkflow,
  ImportPackage,
} from "./dir-source";
import type { ImportSource } from "./schema";

export type ImportKind = "workflow" | "skill" | "script" | "agent";

export const seedKind = (sourceId: string, kind: ImportKind) => `import:${sourceId}:${kind}`;

// ─── Ownership (import_items) ───────────────────────────────────────────────

export async function getOwnedId(
  sourceId: string,
  kind: ImportKind,
  key: string,
): Promise<string | null> {
  const row = await getDbClient().get<{ entityId: string }>(
    "SELECT entityId FROM import_items WHERE sourceId = ? AND kind = ? AND itemKey = ?",
    [sourceId, kind, key],
  );
  return row?.entityId ?? null;
}

async function isOwned(kind: ImportKind, entityId: string): Promise<boolean> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT 1 AS n FROM import_items WHERE kind = ? AND entityId = ? LIMIT 1",
    [kind, entityId],
  );
  return row !== null;
}

export async function recordOwnership(
  sourceId: string,
  kind: ImportKind,
  key: string,
  entityId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO import_items (sourceId, kind, itemKey, entityId, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(sourceId, kind, itemKey) DO UPDATE SET
       entityId = excluded.entityId, updatedAt = excluded.updatedAt`,
    [sourceId, kind, key, entityId, now, now],
  );
}

type Target = { id: string | null } | "conflict";

/** Pick the row an item writes to. Adoption under `overwrite` is recorded right away. */
async function resolveTarget(
  source: ImportSource,
  kind: ImportKind,
  key: string,
  exists: (id: string) => Promise<boolean>,
  findByName: () => Promise<string | null>,
): Promise<Target> {
  const owned = await getOwnedId(source.id, kind, key);
  if (owned && (await exists(owned))) return { id: owned };
  const named = await findByName();
  if (!named) return { id: null };
  if (await isOwned(kind, named)) return "conflict";
  if (source.onConflict !== "overwrite") return "conflict";
  await recordOwnership(source.id, kind, key, named);
  return { id: named };
}

// ─── Agents and skill installs (shared with pending.ts) ─────────────────────

/** Empty or a generated default: nothing user-authored to lose. */
export function identityIsAdoptable(agent: Agent): boolean {
  return !agent.identityMd || matchesDefaultIdentityMd(agent.identityMd, agent);
}

export async function writeInstructions(
  sourceId: string,
  key: string,
  agentId: string,
  text: string,
): Promise<void> {
  await updateAgentProfile(
    agentId,
    { identityMd: text },
    { changeSource: "system", changeReason: `Imported from source ${sourceId}` },
  );
  await recordOwnership(sourceId, "agent", key, agentId);
}

/**
 * Install each imported skill this source owns. An existing install row is
 * left alone, so a user who deactivated the skill on that agent keeps it off.
 * Returns the local ids with no imported skill (conflict or failed write).
 */
export async function installImportedSkills(
  sourceId: string,
  agentId: string,
  skillKeys: readonly string[],
): Promise<{ installed: number; missing: string[] }> {
  let installed = 0;
  const missing: string[] = [];
  for (const key of skillKeys) {
    const skillId = await getOwnedId(sourceId, "skill", key);
    if (!skillId || !(await getSkillById(skillId))) {
      missing.push(key);
      continue;
    }
    const result = await getDbClient().run(
      `INSERT INTO agent_skills (id, agentId, skillId, isActive, installedAt)
       VALUES (?, ?, ?, 1, ?) ON CONFLICT(agentId, skillId) DO NOTHING`,
      [crypto.randomUUID(), agentId, skillId, new Date().toISOString()],
    );
    installed += result.changes;
  }
  return { installed, missing };
}

/** The agent a manifest entry names, `null` when none, or "ambiguous". */
export async function findAgent(entry: {
  agentId: string | null;
  agentName: string | null;
}): Promise<Agent | null | "ambiguous"> {
  if (entry.agentId) return getAgentById(entry.agentId);
  const rows = await getDbClient().query<{ id: string }>(
    `SELECT id FROM agents WHERE name = ? AND ${NOT_EXTENSION_AGENT_SQL} LIMIT 2`,
    [entry.agentName],
  );
  if (rows.length > 1) return "ambiguous";
  return rows[0] ? getAgentById(rows[0].id) : null;
}

// ─── Seeders ────────────────────────────────────────────────────────────────

type Resolved<T> = T & SeedItem & { targetId: string | null };

export type PreparedSeeders = {
  seeders: Seeder[];
  /** `<kind> <key>: <reason>` lines for items no seeder will touch. */
  conflicts: string[];
  /** Agents not registered yet; stored as pending assignments. */
  unresolved: ImportedAgent[];
  /** Resolved agents with skills to install after the skill seeder ran. */
  assignments: { agentId: string; agent: ImportedAgent }[];
};

async function partition<T extends { key: string; hash: string }>(
  source: ImportSource,
  kind: ImportKind,
  items: readonly T[],
  exists: (id: string) => Promise<boolean>,
  findByName: (item: T) => Promise<string | null>,
  conflicts: string[],
): Promise<Resolved<T>[]> {
  const resolved: Resolved<T>[] = [];
  for (const item of items) {
    const target = await resolveTarget(source, kind, item.key, exists, () => findByName(item));
    if (target === "conflict") {
      conflicts.push(
        `${kind} ${item.key}: a same-named ${kind} exists that this source does not own`,
      );
      continue;
    }
    resolved.push({ ...item, contentHash: item.hash, targetId: target.id });
  }
  return resolved;
}

function seeder<T extends SeedItem & { targetId: string | null }>(
  source: ImportSource,
  kind: ImportKind,
  items: T[],
  upstreamHash: (item: T & { targetId: string }) => Promise<string | null>,
  apply: (item: T) => Promise<string>,
): Seeder<T> {
  return {
    kind: seedKind(source.id, kind),
    overwriteUserModified: source.onConflict === "overwrite",
    items: () => items,
    upstreamHash: (item) =>
      item.targetId ? upstreamHash(item as T & { targetId: string }) : Promise.resolve(null),
    async apply(item) {
      const id = await apply(item);
      await recordOwnership(source.id, kind, item.key, id);
    },
  };
}

function scriptsSeeder(source: ImportSource, items: Resolved<ImportedScript>[]) {
  return seeder(
    source,
    "script",
    items,
    async (item) => {
      const live = await getScriptById(item.targetId);
      return live ? scriptHash(liveScriptSpec(live)) : null;
    },
    async (item) => {
      const result = await upsertScriptByName({
        name: item.key,
        scope: "global",
        scopeId: null,
        ...item.spec,
        agentId: null,
        isScratch: false,
        typeChecked: true,
        changeReason: `Imported from source ${source.id}`,
        // The post-listen backfill embeds it; boot must not wait on a provider.
        embeddingMode: "skip",
      });
      return result.script.id;
    },
  );
}

function skillsSeeder(source: ImportSource, items: Resolved<ImportedSkill>[]) {
  return seeder(
    source,
    "skill",
    items,
    async (item) => {
      const live = await getSkillById(item.targetId);
      if (!live) return null;
      const files = (await getSkillFiles(live.id)).map(({ path, content }) => ({ path, content }));
      return skillHash(liveSkillSpec(live), files);
    },
    // One transaction: a row without its files would hash as edited forever.
    (item) =>
      getDbClient().transaction(async () => {
        const { spec } = item;
        if (item.targetId) {
          await updateSkill(item.targetId, spec);
          const wanted = new Set(item.files.map((file) => file.path));
          for (const file of await getSkillFiles(item.targetId)) {
            if (!wanted.has(file.path)) await deleteSkillFile(item.targetId, file.path);
          }
          if (item.files.length > 0) await upsertSkillFiles(item.targetId, item.files);
          return item.targetId;
        }
        const created = await createSkill({
          ...spec,
          allowedTools: spec.allowedTools ?? undefined,
          model: spec.model ?? undefined,
          effort: spec.effort ?? undefined,
          context: spec.context ?? undefined,
          agent: spec.agent ?? undefined,
          sourceUrl: spec.sourceUrl ?? undefined,
          sourceRepo: spec.sourceRepo ?? undefined,
          sourcePath: spec.sourcePath ?? undefined,
          sourceHash: spec.sourceHash ?? undefined,
          type: "personal",
        });
        if (item.files.length > 0) await upsertSkillFiles(created.id, item.files);
        return created.id;
      }),
  );
}

function workflowsSeeder(source: ImportSource, items: Resolved<ImportedWorkflow>[]) {
  return seeder(
    source,
    "workflow",
    items,
    async (item) => {
      const live = await getWorkflow(item.targetId);
      return live ? hashOf(liveWorkflowSpec(live)) : null;
    },
    async (item) => {
      const { spec } = item;
      const fields = {
        name: spec.name,
        definition: spec.definition,
        triggers: spec.triggers,
        triggerSchema: spec.triggerSchema ?? undefined,
      };
      if (!item.targetId) {
        // Created disabled; the operator turns it on.
        const created = await createWorkflow({
          ...fields,
          description: spec.description ?? undefined,
          cooldown: spec.cooldown ?? undefined,
          input: spec.input ?? undefined,
          enabled: false,
        });
        return created.id;
      }
      // Leaves `enabled` alone. Runs already started keep their pinned definition.
      await snapshotAndUpdateWorkflow(item.targetId, {
        ...fields,
        description: spec.description ?? "",
        cooldown: spec.cooldown,
        input: spec.input,
        triggerSchema: spec.triggerSchema,
      });
      return item.targetId;
    },
  );
}

type AgentItem = ImportedAgent & { hash: string };

function agentsSeeder(source: ImportSource, items: Resolved<AgentItem>[]) {
  return seeder(
    source,
    "agent",
    items,
    async (item) => {
      const agent = await getAgentById(item.targetId);
      if (!agent) return null;
      // Unowned with a default identity: write it as if absent.
      const owned = (await getOwnedId(source.id, "agent", item.key)) === agent.id;
      if (!owned && identityIsAdoptable(agent)) return null;
      return computeContentHash(agent.identityMd ?? "");
    },
    async (item) => {
      const agentId = item.targetId as string;
      await writeInstructions(source.id, item.key, agentId, item.instructions?.text ?? "");
      return agentId;
    },
  );
}

/**
 * Resolve every item of a validated package and build its seeders, in write
 * order: scripts, skills, workflows, agent instructions.
 */
export async function prepareSeeders(
  source: ImportSource,
  pkg: ImportPackage,
): Promise<PreparedSeeders> {
  const conflicts: string[] = [];
  const unresolved: ImportedAgent[] = [];
  const assignments: PreparedSeeders["assignments"] = [];

  const scripts = await partition(
    source,
    "script",
    pkg.scripts,
    async (id) => (await getScriptById(id)) !== null,
    async (item) => (await getScript({ name: item.key, scope: "global" }))?.id ?? null,
    conflicts,
  );
  const skills = await partition(
    source,
    "skill",
    pkg.skills,
    async (id) => (await getSkillById(id)) !== null,
    // Any scope: an imported skill must not shadow a same-named skill anywhere.
    async (item) =>
      (
        await getDbClient().get<{ id: string }>(
          "SELECT id FROM skills WHERE name = ? ORDER BY createdAt LIMIT 1",
          [item.spec.name],
        )
      )?.id ?? null,
    conflicts,
  );
  const workflows = await partition(
    source,
    "workflow",
    pkg.workflows,
    async (id) => (await getWorkflow(id)) !== null,
    async (item) =>
      (
        await getDbClient().get<{ id: string }>("SELECT id FROM workflows WHERE name = ?", [
          item.spec.name,
        ])
      )?.id ?? null,
    conflicts,
  );

  const agentItems: Resolved<AgentItem>[] = [];
  for (const entry of pkg.agents) {
    const agent = await findAgent(entry);
    if (agent === "ambiguous") {
      conflicts.push(`agent ${entry.key}: several agents have this name; use id`);
      continue;
    }
    if (!agent) {
      unresolved.push(entry);
      continue;
    }
    if (entry.skills.length > 0) assignments.push({ agentId: agent.id, agent: entry });
    if (!entry.instructions) continue;
    const owned = await getOwnedId(source.id, "agent", entry.key);
    if (owned !== agent.id) {
      const other = await isOwned("agent", agent.id);
      if (other || (!identityIsAdoptable(agent) && source.onConflict !== "overwrite")) {
        conflicts.push(`agent ${entry.key}: IDENTITY.md has content this source does not own`);
        continue;
      }
      if (!identityIsAdoptable(agent)) {
        await recordOwnership(source.id, "agent", entry.key, agent.id);
      }
    }
    agentItems.push({
      ...entry,
      hash: entry.instructions.hash,
      contentHash: entry.instructions.hash,
      targetId: agent.id,
    });
  }

  return {
    seeders: [
      scriptsSeeder(source, scripts),
      skillsSeeder(source, skills),
      workflowsSeeder(source, workflows),
      agentsSeeder(source, agentItems),
    ] as Seeder[],
    conflicts,
    unresolved,
    assignments,
  };
}

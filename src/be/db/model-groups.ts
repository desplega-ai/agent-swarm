/**
 * Model groups: a named, ordered list of model profiles that may span
 * harnesses (runbooks/model-tiers.md § Model groups). Members live in
 * `model_group_members` (migration 301), one row per position. Groups and
 * profiles share one name space (enforced by migration 301's triggers).
 */
import type { ModelGroup } from "../../types";
import { repairWindowStart, TASK_HOLDS_PROFILE_SQL } from "./model-profiles";
import { getDbClient } from "./runtime";

/** Most members a group may list. */
export const MAX_MODEL_GROUP_MEMBERS = 20;

type ModelGroupRow = {
  id: string;
  name: string;
  description: string | null;
  seededFrom: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToModelGroup(row: ModelGroupRow, members: string[]): ModelGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    seededFrom: row.seededFrom,
    members,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

async function membersByGroup(groupId?: string): Promise<Map<string, string[]>> {
  const rows = await getDbClient().query<{ groupId: string; profileName: string }>(
    `SELECT groupId, profileName FROM model_group_members
      ${groupId ? "WHERE groupId = ?" : ""}
      ORDER BY groupId, position`,
    groupId ? [groupId] : [],
  );
  const byGroup = new Map<string, string[]>();
  for (const row of rows) {
    const list = byGroup.get(row.groupId) ?? [];
    list.push(row.profileName);
    byGroup.set(row.groupId, list);
  }
  return byGroup;
}

/** Every group with its members in order, by name. */
export async function listModelGroups(): Promise<ModelGroup[]> {
  const rows = await getDbClient().query<ModelGroupRow>("SELECT * FROM model_groups ORDER BY name");
  const members = await membersByGroup();
  return rows.map((row) => rowToModelGroup(row, members.get(row.id) ?? []));
}

export async function getModelGroupByName(name: string): Promise<ModelGroup | null> {
  const row = await getDbClient().get<ModelGroupRow>("SELECT * FROM model_groups WHERE name = ?", [
    name.trim(),
  ]);
  if (!row) return null;
  return rowToModelGroup(row, (await membersByGroup(row.id)).get(row.id) ?? []);
}

/**
 * Why `members` cannot be a group's member list, or null: at least one, at
 * most `MAX_MODEL_GROUP_MEMBERS`, no repeats, and every one an existing
 * profile. Members may run on any harness. Run it in the write's transaction.
 */
export async function modelGroupMembersError(members: string[]): Promise<string | null> {
  if (members.length === 0) return "A group lists at least one member profile.";
  if (members.length > MAX_MODEL_GROUP_MEMBERS) {
    return `A group lists at most ${MAX_MODEL_GROUP_MEMBERS} members.`;
  }
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member)) return `Member "${member}" is listed twice.`;
    seen.add(member);
  }
  const rows = await getDbClient().query<{ name: string }>(
    `SELECT name FROM model_profiles WHERE name IN (${members.map(() => "?").join(", ")})`,
    members,
  );
  const known = new Set(rows.map((row) => row.name));
  const unknown = members.filter((member) => !known.has(member));
  if (unknown.length > 0) {
    return `Unknown model profile${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. List profiles with list-model-profiles.`;
  }
  return null;
}

async function writeMembers(groupId: string, members: string[]): Promise<void> {
  await getDbClient().run("DELETE FROM model_group_members WHERE groupId = ?", [groupId]);
  for (const [position, profileName] of members.entries()) {
    await getDbClient().run(
      "INSERT INTO model_group_members (groupId, position, profileName) VALUES (?, ?, ?)",
      [groupId, position, profileName],
    );
  }
}

export interface ModelGroupInput {
  name: string;
  description?: string | null;
  seededFrom?: string | null;
  members: string[];
}

export type ModelGroupWriteResult =
  | { ok: true; group: ModelGroup }
  | { ok: false; reason: "invalid" | "exists" | "name-taken" | "missing"; error: string };

/**
 * Insert a group and its members in one transaction. Refused when the name is
 * a group already (`exists`) or a profile (`name-taken`), or the member list
 * is invalid (`modelGroupMembersError`).
 */
export async function createModelGroup(
  input: ModelGroupInput,
  audit: { userId?: string | null } = {},
): Promise<ModelGroupWriteResult> {
  return await getDbClient().transaction(async (tx) => {
    const profile = await tx.get<{ id: string }>("SELECT id FROM model_profiles WHERE name = ?", [
      input.name,
    ]);
    if (profile) {
      return {
        ok: false,
        reason: "name-taken",
        error: `"${input.name}" is a model profile; groups and profiles share one name space.`,
      };
    }
    const membersError = await modelGroupMembersError(input.members);
    if (membersError) return { ok: false, reason: "invalid", error: membersError };
    const now = new Date().toISOString();
    const row = await tx.get<ModelGroupRow>(
      `INSERT INTO model_groups
         (id, name, description, seededFrom, createdAt, lastUpdatedAt, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO NOTHING
       RETURNING *`,
      [
        crypto.randomUUID(),
        input.name,
        input.description ?? null,
        input.seededFrom ?? null,
        now,
        now,
        audit.userId ?? null,
        audit.userId ?? null,
      ],
    );
    if (!row) {
      return {
        ok: false,
        reason: "exists",
        error: `Model group "${input.name}" already exists`,
      };
    }
    await writeMembers(row.id, input.members);
    return { ok: true, group: rowToModelGroup(row, [...input.members]) };
  });
}

/**
 * Change a group's description and/or replace its member list (positions are
 * rewritten in one transaction, so a reader never sees a half-written order).
 * The name is fixed.
 */
export async function updateModelGroup(
  name: string,
  patch: { description?: string | null; members?: string[] },
  audit: { userId?: string | null } = {},
): Promise<ModelGroupWriteResult> {
  return await getDbClient().transaction(async (tx) => {
    const current = await tx.get<ModelGroupRow>("SELECT * FROM model_groups WHERE name = ?", [
      name,
    ]);
    if (!current) return { ok: false, reason: "missing", error: "Model group not found" };
    if (patch.members !== undefined) {
      const membersError = await modelGroupMembersError(patch.members);
      if (membersError) return { ok: false, reason: "invalid", error: membersError };
      await writeMembers(current.id, patch.members);
    }
    const sets = ["lastUpdatedAt = ?", "updated_by = ?"];
    const params: (string | null)[] = [new Date().toISOString(), audit.userId ?? null];
    if (patch.description !== undefined) {
      sets.push("description = ?");
      params.push(patch.description);
    }
    const row = await tx.get<ModelGroupRow>(
      `UPDATE model_groups SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
      [...params, current.id],
    );
    if (!row) return { ok: false, reason: "missing", error: "Model group not found" };
    const members = (await membersByGroup(row.id)).get(row.id) ?? [];
    return { ok: true, group: rowToModelGroup(row, members) };
  });
}

/** Tasks that still hold a group (same rule as profiles) and schedules that name it. */
export async function modelGroupReferences(name: string): Promise<{
  openTaskCount: number;
  scheduleIds: string[];
}> {
  const tasks = await getDbClient().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM agent_tasks t WHERE t.modelGroup = ? AND ${TASK_HOLDS_PROFILE_SQL}`,
    [name, repairWindowStart()],
  );
  const schedules = await getDbClient().query<{ id: string }>(
    "SELECT id FROM scheduled_tasks WHERE modelGroup = ? ORDER BY id",
    [name],
  );
  return { openTaskCount: tasks?.n ?? 0, scheduleIds: schedules.map((s) => s.id) };
}

/**
 * Delete a group (its members cascade) unless a task still holds it or a
 * schedule names it. The check is part of the DELETE statement, so a reference
 * written after the caller's own count still makes it `in-use`; migration
 * 301's triggers refuse the opposite order.
 */
export async function deleteModelGroup(name: string): Promise<"deleted" | "missing" | "in-use"> {
  const row = await getDbClient().get<{ id: string }>(
    `DELETE FROM model_groups
      WHERE name = ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_tasks t
           WHERE t.modelGroup = model_groups.name AND ${TASK_HOLDS_PROFILE_SQL})
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_tasks s WHERE s.modelGroup = model_groups.name)
      RETURNING id`,
    [name, repairWindowStart()],
  );
  if (row) return "deleted";
  return (await getModelGroupByName(name)) ? "in-use" : "missing";
}

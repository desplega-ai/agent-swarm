/**
 * Model groups: a named, ordered list of model profiles that may span
 * harnesses (runbooks/model-tiers.md § Model groups). Members live in
 * `model_group_members` (migration 308), one row per position. Groups and
 * profiles share one name space (enforced by migration 308's triggers).
 */
import type { ModelGroupRow } from "@desplega/storage";
import type { ModelGroup } from "../../types";
import { getStorage } from "../storage";
import { taskHoldWindow } from "./model-profiles";

/** Most members a group may list. */
export const MAX_MODEL_GROUP_MEMBERS = 20;

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
  const rows = await getStorage().repos.models.listGroupMembers(groupId || undefined);
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
  const rows = await getStorage().repos.models.listGroups();
  const members = await membersByGroup();
  return rows.map((row) => rowToModelGroup(row, members.get(row.id) ?? []));
}

export async function getModelGroupByName(name: string): Promise<ModelGroup | null> {
  const row = await getStorage().repos.models.findGroupByName(name.trim());
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
  const known = new Set(await getStorage().repos.models.listExistingProfileNames(members));
  const unknown = members.filter((member) => !known.has(member));
  if (unknown.length > 0) {
    return `Unknown model profile${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. List profiles with list-model-profiles.`;
  }
  return null;
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
  const models = getStorage().repos.models;
  return await getStorage().transaction(async () => {
    const profile = await models.findProfileByName(input.name);
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
    const row = await models.insertGroup({
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description ?? null,
      seededFrom: input.seededFrom ?? null,
      actor: audit.userId ?? null,
      now,
    });
    if (!row) {
      return {
        ok: false,
        reason: "exists",
        error: `Model group "${input.name}" already exists`,
      };
    }
    await models.replaceGroupMembers(row.id, input.members);
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
  const models = getStorage().repos.models;
  return await getStorage().transaction(async () => {
    const current = await models.findGroupByName(name);
    if (!current) return { ok: false, reason: "missing", error: "Model group not found" };
    if (patch.members !== undefined) {
      const membersError = await modelGroupMembersError(patch.members);
      if (membersError) return { ok: false, reason: "invalid", error: membersError };
      await models.replaceGroupMembers(current.id, patch.members);
    }
    const row = await models.updateGroup(
      current.id,
      patch.description !== undefined ? { description: patch.description } : {},
      { actor: audit.userId ?? null, now: new Date().toISOString() },
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
  const openTaskCount = await getStorage().repos.models.countTasksHoldingGroup(
    name,
    taskHoldWindow(),
  );
  const scheduleIds = await getStorage().repos.schedules.listIdsByModelGroup(name);
  return { openTaskCount, scheduleIds };
}

/**
 * Delete a group (its members cascade) unless a task still holds it or a
 * schedule names it. The check is part of the DELETE statement, so a reference
 * written after the caller's own count still makes it `in-use`; migration
 * 308's triggers refuse the opposite order.
 */
export async function deleteModelGroup(name: string): Promise<"deleted" | "missing" | "in-use"> {
  const deleted = await getStorage().repos.models.deleteUnreferencedGroup(name, taskHoldWindow());
  if (deleted) return "deleted";
  return (await getModelGroupByName(name)) ? "in-use" : "missing";
}

import { keyPrefixRange } from "../../assets/key";
import type { AssetEntityType } from "../../types";
import type { AssetKeyAuditResult } from "../asset-key-audit";
import { isInTransaction } from "../db-client";
import { getStorage } from "../storage";
import { getTaskById } from "./tasks/read";

type SessionMoveDependencies = {
  /**
   * The asset key audit. SQLite: the sync boot audit (`auditAssetKeys`) over the
   * raw handle, which only db.ts may use. Postgres: the repository audit.
   */
  auditAssetKeys: () => AssetKeyAuditResult | Promise<AssetKeyAuditResult>;
  insertAssetKeyHistory: (input: {
    entityType: AssetEntityType;
    entityId: string;
    previousKey?: string | null;
    newKey: string;
    changedBy?: string;
  }) => Promise<void>;
};

let insertAssetKeyHistory: SessionMoveDependencies["insertAssetKeyHistory"];
let auditAssetKeys: SessionMoveDependencies["auditAssetKeys"];

export function configureSessionMoveDependencies(value: SessionMoveDependencies): void {
  insertAssetKeyHistory = value.insertAssetKeyHistory;
  auditAssetKeys = value.auditAssetKeys;
}

export class AssetKeyMovesBlockedError extends Error {
  constructor() {
    super(
      "Asset namespace moves are blocked until structural errors, unknown personal users, or provider mapping drift are repaired.",
    );
    this.name = "AssetKeyMovesBlockedError";
  }
}

export async function assertAssetKeyMovesAllowed(): Promise<void> {
  // auditAssetKeys stays sync (shared with the boot audit); run it inside a
  // client transaction so this request-path read cannot observe another
  // request's uncommitted writes on the shared connection.
  const audit = await getStorage().transaction(async () => auditAssetKeys(), {
    readOnly: true,
  });
  if (!audit.ok) {
    throw new AssetKeyMovesBlockedError();
  }
}

/** Move only authorized task ids. The caller owns the transaction and audit gate. */
export async function moveTaskChainKeyInTx(
  rootId: string,
  taskIds: readonly string[],
  key: string,
  changedBy?: string,
): Promise<string[] | false> {
  if (!isInTransaction()) {
    throw new Error("moveTaskChainKeyInTx requires an active transaction");
  }
  const sessions = getStorage().repos.sessions;
  const now = new Date().toISOString();
  const root = await getTaskById(rootId);
  if (!root) return false;
  const tasks = [root];
  for (const id of taskIds) {
    const task = id === root.id ? null : await getTaskById(id);
    if (task) tasks.push(task);
  }
  const movedTaskIds: string[] = [];
  for (const task of tasks) {
    if (task.key === key) continue;
    // A file shared with another task keeps the namespace of the task whose attachment
    // sources its mapping. Mappings with no attachment source follow any attaching task.
    const mappedFiles = await sessions.listTaskAttachmentMappings(task.id);
    // The namespace is metadata, and lastUpdatedAt tracks task activity, as in updateTaskTitle.
    await sessions.setTaskKey(task.id, key, changedBy ?? null);
    for (const mapping of mappedFiles) {
      if (mapping.key === key) continue;
      await sessions.setAssetMappingKey(mapping.id, key, now, changedBy ?? null);
      await insertAssetKeyHistory({
        entityType: "file",
        entityId: mapping.id,
        previousKey: mapping.key,
        newKey: key,
        changedBy,
      });
    }
    await insertAssetKeyHistory({
      entityType: "task",
      entityId: task.id,
      previousKey: task.key,
      newKey: key,
      changedBy,
    });
    movedTaskIds.push(task.id);
  }
  return movedTaskIds;
}

export type SessionKeyMove = { rootId: string; taskIds: string[]; key: string };

/** The caller must complete the key audit before this operation. */
export async function moveSessionChains(input: {
  moves: SessionKeyMove[];
  changedBy?: string;
}): Promise<string[]> {
  const moved: string[] = [];
  for (const move of input.moves) {
    const taskIds = await getStorage().transaction(async () =>
      moveTaskChainKeyInTx(move.rootId, move.taskIds, move.key, input.changedBy),
    );
    if (taskIds && taskIds.length > 0) moved.push(move.rootId);
  }
  return moved;
}

/**
 * Point `key` favorites (stars) and `hidden-key` rows (hidden groups) under
 * `from` at the same path under `to` (a group rename). A principal that already starred the new key keeps that row, and
 * the old row goes. With `scope`, only that favorite scope's stars move.
 */
export async function moveKeyFavorites(input: {
  from: string;
  to: string;
  scope?: string;
}): Promise<void> {
  const range = keyPrefixRange(input.from);
  await getStorage().transaction(async () => {
    await getStorage().repos.sessions.moveKeyFavorites(range, input.to, input.scope);
  });
}

export async function listPrefixRoots(input: {
  from: string;
  userId?: string | null;
  limit: number;
  offset?: number;
}): Promise<{ id: string; key: string }[]> {
  return getStorage().repos.sessions.listPrefixRoots({
    range: keyPrefixRange(input.from),
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    limit: input.limit,
    offset: input.offset ?? 0,
  });
}

export async function listSharedPrefixRoots(input: {
  from: string;
  userId: string | null;
}): Promise<{ id: string }[]> {
  return getStorage().repos.sessions.listVisiblePrefixRoots(keyPrefixRange(input.from), {
    userId: input.userId,
    scope: "shared",
  });
}

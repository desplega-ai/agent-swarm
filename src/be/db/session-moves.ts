import { keyPrefixRange } from "../../assets/key";
import type { AssetEntityType } from "../../types";
import type { AssetKeyAuditResult } from "../asset-key-audit";
import { isInTransaction } from "../db-client";
import { getDbClient } from "./runtime";
import { sessionViewerCondition } from "./session-visibility";
import { getTaskById } from "./tasks/read";

type SessionMoveDependencies = {
  /** The sync boot audit (`auditAssetKeys`) over the raw handle, which only db.ts may use. */
  auditAssetKeys: () => AssetKeyAuditResult;
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
  const audit = await getDbClient().transaction(async () => auditAssetKeys(), {
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
  const client = getDbClient();
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
    const mappedFiles = await client.query<{ id: string; key: string }>(
      `SELECT DISTINCT m.id, m."key" AS key
       FROM asset_key_mappings m
       JOIN task_attachments a
         ON m.provider_id = COALESCE(NULLIF(a.provider_id, ''), 'agent-fs')
        AND m.provider_org_id = COALESCE(a.agent_fs_org_id, '')
        AND m.provider_drive_id = COALESCE(a.agent_fs_drive_id, '')
        AND m.provider_key = COALESCE(NULLIF(a.provider_key, ''), a.path)
       WHERE a.task_id = ?
         AND (m.source_entity_type IS NOT 'task-attachment'
           OR m.source_entity_id IN (SELECT id FROM task_attachments WHERE task_id = ?))`,
      [task.id, task.id],
    );
    // The namespace is metadata, and lastUpdatedAt tracks task activity, as in updateTaskTitle.
    await client.run('UPDATE agent_tasks SET "key" = ?, updated_by = ? WHERE id = ?', [
      key,
      changedBy ?? null,
      task.id,
    ]);
    for (const mapping of mappedFiles) {
      if (mapping.key === key) continue;
      await client.run(
        'UPDATE asset_key_mappings SET "key" = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        [key, now, changedBy ?? null, mapping.id],
      );
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
    const taskIds = await getDbClient().transaction(async () =>
      moveTaskChainKeyInTx(move.rootId, move.taskIds, move.key, input.changedBy),
    );
    if (taskIds && taskIds.length > 0) moved.push(move.rootId);
  }
  return moved;
}

export async function listPrefixRoots(input: {
  from: string;
  userId?: string | null;
  limit: number;
  offset?: number;
}): Promise<{ id: string; key: string }[]> {
  const { lo, hi } = keyPrefixRange(input.from);
  return getDbClient().query<{ id: string; key: string }>(
    `SELECT r.id, r."key" FROM agent_tasks r
     WHERE r.parentTaskId IS NULL AND r."key" >= ? AND r."key" < ?
       ${input.userId !== undefined ? "AND r.requestedByUserId = ?" : ""}
     ORDER BY r.id LIMIT ? OFFSET ?`,
    [lo, hi, ...(input.userId !== undefined ? [input.userId] : []), input.limit, input.offset ?? 0],
  );
}

export async function listSharedPrefixRoots(input: {
  from: string;
  userId: string | null;
}): Promise<{ id: string }[]> {
  const { lo, hi } = keyPrefixRange(input.from);
  const visibility = sessionViewerCondition({ userId: input.userId, scope: "shared" });
  return getDbClient().query<{ id: string }>(
    `SELECT r.id FROM agent_tasks r
     WHERE r.parentTaskId IS NULL AND r."key" >= ? AND r."key" < ?
       AND ${visibility.sql} ORDER BY r.id`,
    [lo, hi, ...visibility.params],
  );
}

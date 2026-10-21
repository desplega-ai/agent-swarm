import { keyPrefixRange } from "../../assets/key";
import { getDbClient, moveTaskChainKeyInTx } from "../db";
import { sessionViewerCondition } from "./session-visibility";

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

import { defaultAssetKey, isGroupKey } from "../assets/key";
import { sourceOfKey } from "../assets/source-key";
import { can } from "../rbac";
import { scrubSecrets } from "../utils/secret-scrubber";
import { resolveCallerTask } from "./audit-user";
import { getAgentById, getRootTaskChain } from "./db";
import {
  AssetKeyMovesBlockedError,
  assertAssetKeyMovesAllowed,
  moveSessionChains,
} from "./db/session-moves";
import { getSessionRoot } from "./session-shares";

/**
 * File the calling task's session into the use-case group `key` that a
 * `create-schedule` or `create-page` call named explicitly, so the planning
 * session, the schedule, its runs and its pages share one key. A session
 * started in the Inbox keeps its default key `shared/task:<rootId>/` until then.
 *
 * Moves only the session of a task the caller owns, and only while that
 * session still has its default key: a session already in a group never
 * moves. Tasks of the chain with a key of their own keep it. Every moved task
 * needs `task.fs.mutate` for the caller, as on `POST /api/session-moves`.
 * `key` must already be authorized for the writer (`authorizeAssetKeyWrite`).
 *
 * Call it after the schedule or page is written, outside a transaction. A
 * failed move never fails the tool: the write already happened. Returns the
 * moved root task id, or null.
 */
export async function fileCallerSessionIntoGroup(input: {
  sourceTaskId: string | undefined;
  agentId: string | undefined;
  key: string;
  changedBy: string | undefined;
}): Promise<string | null> {
  if (!input.agentId || !isGroupKey(input.key) || sourceOfKey(input.key)) return null;
  try {
    const task = await resolveCallerTask(input.sourceTaskId, input.agentId);
    if (!task) return null;
    const root = await getSessionRoot(task.id);
    if (!root) return null;
    const rootKey = defaultAssetKey("task", root.id);
    const hasDefaultKey = (entry: { id: string; key: string }) =>
      entry.key === rootKey || entry.key === defaultAssetKey("task", entry.id);
    if (!hasDefaultKey(task)) return null;
    const chain = await getRootTaskChain(root.id);
    if (chain[0]?.id !== root.id || chain[0].key !== rootKey) return null;

    const agent = await getAgentById(input.agentId);
    const principal = {
      kind: "agent" as const,
      agentId: input.agentId,
      isLead: agent?.isLead ?? false,
    };
    const movable = chain.filter(hasDefaultKey);
    const allowed = movable.every(
      (entry) =>
        can({
          principal,
          verb: "task.fs.mutate",
          resource: {
            kind: "task",
            taskId: entry.id,
            agentId: entry.agentId,
            creatorAgentId: entry.creatorAgentId,
          },
          source: "mcp",
        }).allow,
    );
    if (!allowed) return null;

    await assertAssetKeyMovesAllowed();
    const moved = await moveSessionChains({
      moves: [{ rootId: root.id, taskIds: movable.map((entry) => entry.id), key: input.key }],
      changedBy: input.changedBy,
    });
    return moved.includes(root.id) ? root.id : null;
  } catch (error) {
    if (error instanceof AssetKeyMovesBlockedError) return null;
    console.warn(
      "[caller-session-group] Session move failed:",
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}

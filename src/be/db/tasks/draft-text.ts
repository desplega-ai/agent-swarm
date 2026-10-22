import { getDbClient } from "../runtime";

/**
 * Append a block to a draft's task text (an uploaded voice note's transcript),
 * as its own paragraph. Only a draft: nobody has read its text yet. One
 * statement, so parallel uploads never drop each other's block. Returns
 * whether the task was still a draft.
 */
export async function appendDraftTaskText(taskId: string, block: string): Promise<boolean> {
  const result = await getDbClient().run(
    "UPDATE agent_tasks SET task = task || ?, lastUpdatedAt = ? WHERE id = ? AND status = 'draft'",
    [`\n\n${block}`, new Date().toISOString(), taskId],
  );
  return result.changes > 0;
}

import { getStorage } from "../../storage";

/**
 * Append a block to a draft's task text (an uploaded voice note's transcript),
 * as its own paragraph. Only a draft: nobody has read its text yet. One
 * statement, so parallel uploads never drop each other's block. Returns
 * whether the task was still a draft.
 */
export async function appendDraftTaskText(taskId: string, block: string): Promise<boolean> {
  const changes = await getStorage().repos.tasks.appendDraftTaskText(
    taskId,
    `\n\n${block}`,
    new Date().toISOString(),
  );
  return changes > 0;
}

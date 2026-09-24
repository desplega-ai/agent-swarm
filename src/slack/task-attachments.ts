import { getTaskAttachments } from "../be/db";
import type { TaskAttachment } from "../types";

/** Inputs remain available to workers, but only outputs belong in Slack replies. */
export async function getSlackOutputAttachments(taskId: string): Promise<TaskAttachment[]> {
  return (await getTaskAttachments(taskId)).filter(
    (attachment) => attachment.intent !== "user-upload" && attachment.intent !== "slack-file",
  );
}

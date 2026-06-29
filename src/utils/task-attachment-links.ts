import type { TaskAttachment } from "../types";
import { buildAgentFsLiveUrl, getAppUrl } from "./constants";

export function taskAttachmentDisplayUrl(attachment: TaskAttachment): string {
  if (attachment.kind === "url") return attachment.url ?? "";
  if (attachment.kind === "page") {
    return attachment.pageId ? `${getAppUrl()}/pages/${attachment.pageId}` : "page:";
  }

  if (attachment.providerId === "agent-fs" || attachment.kind === "agent-fs") {
    const liveUrl = buildAgentFsLiveUrl({
      path: attachment.path,
      orgId: attachment.orgId,
      driveId: attachment.driveId,
    });
    return liveUrl ?? `agent-fs:${attachment.path ?? ""}`;
  }

  if (attachment.providerId === "local-fs" || attachment.kind === "shared-fs") {
    return `${getAppUrl()}/api/fs/tasks/${attachment.taskId}/files/${attachment.id}/raw`;
  }

  return attachment.path ?? attachment.providerKey ?? "";
}

import type { TaskAttachment } from "../types";
import { buildAgentFsLiveUrl, getAppUrl } from "./constants";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A ready-to-run command that downloads a task attachment's bytes from inside a
 * worker container through the provider-agnostic raw route — MCP_BASE_URL, the
 * API key and AGENT_ID are already in every worker's env. Each attachment gets
 * its own directory, so two attachments with the same name (every pasted
 * screenshot is "image.png") never overwrite each other; the path is quoted
 * because attachment names come from users.
 */
export function taskAttachmentFetchCommand(
  taskId: string,
  attachmentId: string,
  name: string,
): string {
  const url = `$MCP_BASE_URL/api/fs/tasks/${taskId}/files/${attachmentId}/raw`;
  const outPath = shellQuote(`/tmp/attachments/${attachmentId}/${name.replace(/\//g, "_")}`);
  return `curl -s -H "Authorization: Bearer \${AGENT_SWARM_API_KEY:-$API_KEY}" -H "X-Agent-ID: $AGENT_ID" "${url}" --create-dirs -o ${outPath}`;
}

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

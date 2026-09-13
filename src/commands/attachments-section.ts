/**
 * Build a ready-to-run fetch recipe for each task attachment, so the agent
 * can download the bytes in one call via the provider-agnostic
 * `/api/fs/tasks/{taskId}/files/{attachmentId}/raw` route — instead of having
 * to discover the file's storage provider/org/drive itself (e.g. guessing at
 * the `agent-fs` CLI with no org context). MCP_BASE_URL/API_KEY/AGENT_ID are
 * already present in every worker container's env.
 */
export function buildAttachmentsSection(
  taskId: string | undefined,
  attachmentsRaw: unknown,
): string {
  if (!taskId || !Array.isArray(attachmentsRaw) || attachmentsRaw.length === 0) return "";

  const lines = attachmentsRaw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => {
      const id = typeof a.id === "string" ? a.id : undefined;
      const name = typeof a.name === "string" ? a.name : id;
      if (!id || !name) return null;
      const details = [
        typeof a.mimeType === "string" ? a.mimeType : null,
        typeof a.sizeBytes === "number" ? `${a.sizeBytes} bytes` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const url = `$MCP_BASE_URL/api/fs/tasks/${taskId}/files/${id}/raw`;
      const cmd = `curl -s -H "Authorization: Bearer \${AGENT_SWARM_API_KEY:-$API_KEY}" -H "X-Agent-ID: $AGENT_ID" "${url}" -o /tmp/${name}`;
      return `- ${name}${details ? ` (${details})` : ""}: \`${cmd}\``;
    })
    .filter((line): line is string => line !== null);

  if (lines.length === 0) return "";

  return `\n\n📎 Attachment(s) — fetch directly, no need to discover the storage path yourself:\n${lines.join("\n")}`;
}

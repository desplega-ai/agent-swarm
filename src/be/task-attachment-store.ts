import type { FileObject, FileScope, FileStorageProvider } from "../fs/provider";
import type { TaskAttachment } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { insertTaskAttachment } from "./db";

/** Per-file cap for every path that stores a blob as a task attachment. */
export const MAX_TASK_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export type RecordTaskAttachmentUploadInput = {
  provider: FileStorageProvider;
  scope: FileScope;
  /** What `provider.upload(scope, body, …)` returned. */
  uploaded: FileObject;
  /** Size and sha256 of the body that was uploaded. */
  sizeBytes: number;
  sha256: string;
  contentType: string;
  agentId: string | null;
  intent?: string;
  description?: string;
  isPrimary?: boolean;
  createdBy?: string;
};

/**
 * Record a blob the active provider just stored as a `task_attachments` row.
 * If the row can't be written the blob is deleted, so a failed insert never
 * leaves an orphan in storage, and the insert error is rethrown.
 */
export async function recordTaskAttachmentUpload(
  input: RecordTaskAttachmentUploadInput,
): Promise<TaskAttachment> {
  const { provider, scope, uploaded, contentType } = input;
  try {
    return await insertTaskAttachment({
      taskId: scope.taskId,
      agentId: input.agentId,
      name: scope.name,
      kind: provider.id === "agent-fs" ? "agent-fs" : "shared-fs",
      path: uploaded.key,
      providerId: provider.id,
      providerKey: uploaded.key,
      capabilities: {
        ...provider.capabilities,
        version: uploaded.version,
        etag: uploaded.etag,
      },
      mimeType: uploaded.contentType ?? contentType,
      sizeBytes: uploaded.sizeBytes ?? input.sizeBytes,
      sha256: uploaded.sha256 ?? input.sha256,
      intent: input.intent,
      description: input.description,
      isPrimary: input.isPrimary ?? false,
      createdBy: input.createdBy,
    });
  } catch (error) {
    try {
      await provider.delete(scope);
    } catch (cleanupError) {
      console.warn(
        scrubSecrets(
          `[fs] upload metadata insert failed and blob cleanup failed: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        ),
      );
    }
    throw error;
  }
}

// Resolve against the row's ACTUAL stored key + its own org/drive, rather than
// reconstructing `tasks/<taskId>/<name>`. Attachments written to agent-fs via the
// CLI live at arbitrary paths (`misc/…`, `smoke/…`); reconstruction mis-resolves
// them, which previously caused downloads to 404 and deletes to orphan the real
// file. New uploads have no stored key yet at scope-build time and keep the
// forward-looking layout.
export function scopeFromAttachment(attachment: TaskAttachment): FileScope {
  const storedKey = attachment.providerKey ?? attachment.path ?? "";
  return {
    taskId: attachment.taskId,
    name: attachment.name,
    key: storedKey.trim() ? storedKey : undefined,
    orgId: attachment.orgId,
    driveId: attachment.driveId,
  };
}

// Which file-storage provider (if any) actually holds this attachment's bytes.
// Only agent-fs objects and local-fs uploads are provider-backed; `shared-fs`
// worker-volume pointers, `url`, and `page` attachments have no provider object,
// so they must never be fetched or deleted through a provider (doing so would
// mis-resolve and, on delete, orphan the real target). Note local-fs uploads are
// recorded with kind "shared-fs" but an explicit local-fs providerId, so key off
// both signals rather than kind alone.
export function backingProviderId(attachment: TaskAttachment): string | null {
  if (attachment.kind === "agent-fs") return attachment.providerId ?? "agent-fs";
  if (attachment.providerId === "local-fs") return "local-fs";
  return null;
}

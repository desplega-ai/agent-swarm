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

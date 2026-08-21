import { uploadTaskAttachment } from "@/api/fs";

export interface ComposeAttachmentUploadResult {
  uploaded: number;
  failed: { file: File; error: Error }[];
}

/**
 * How many attachment uploads may be in flight at once. Serial uploads made a
 * multi-file compose take the sum of every round trip; 3 keeps the wall clock
 * down without flooding the browser's per-host connection budget.
 */
export const COMPOSE_UPLOAD_CONCURRENCY = 3;

export async function uploadComposeAttachments({
  taskId,
  files,
  onUploaded,
}: {
  taskId: string;
  files: File[];
  onUploaded?: (count: number) => void;
}): Promise<ComposeAttachmentUploadResult> {
  const failed: ComposeAttachmentUploadResult["failed"] = [];
  let uploaded = 0;
  let next = 0;

  // Workers pull from one shared cursor, so a slow file never blocks the rest.
  async function worker(): Promise<void> {
    while (next < files.length) {
      const file = files[next];
      next += 1;
      try {
        await uploadTaskAttachment({ taskId, file, intent: "user-upload" });
        uploaded += 1;
        onUploaded?.(uploaded);
      } catch (error) {
        failed.push({
          file,
          error: error instanceof Error ? error : new Error("Upload failed"),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(COMPOSE_UPLOAD_CONCURRENCY, files.length) }, () => worker()),
  );

  return { uploaded, failed };
}

export function formatComposeAttachmentUploadError(
  failed: ComposeAttachmentUploadResult["failed"],
): string | null {
  if (failed.length === 0) return null;
  if (failed.length === 1) {
    return `Task created, but ${failed[0].file.name} failed to upload: ${failed[0].error.message}`;
  }
  return `Task created, but ${failed.length} attachments failed to upload.`;
}

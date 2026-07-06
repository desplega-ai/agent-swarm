import { uploadTaskAttachment } from "@/api/fs";

export interface ComposeAttachmentUploadResult {
  uploaded: number;
  failed: { file: File; error: Error }[];
}

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

  for (const file of files) {
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

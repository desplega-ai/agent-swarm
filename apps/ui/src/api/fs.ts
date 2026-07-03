import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getConfig } from "@/lib/config";
import type { TaskAttachment } from "./types";

export interface FsProviderCapability {
  supported: boolean;
  [key: string]: unknown;
}

export interface FsProviderCapabilities {
  signedUrl: FsProviderCapability & { maxExpiresIn?: number };
  search?: boolean;
  comments?: boolean;
  versioning?: boolean;
  [key: string]: unknown;
}

export interface FsCapabilitiesResponse {
  providerId: string;
  capabilities: FsProviderCapabilities;
}

export interface TaskAttachmentsResponse {
  attachments: TaskAttachment[];
}

export interface UploadTaskAttachmentInput {
  taskId: string;
  file: File;
  intent?: string;
  description?: string;
  isPrimary?: boolean;
}

function baseUrl(): string {
  const config = getConfig();
  if (import.meta.env.DEV && config.apiUrl === "http://localhost:3013") return "";
  return config.apiUrl;
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const config = getConfig();
  const headers = new Headers(extra);
  if (config.apiKey) headers.set("Authorization", `Bearer ${config.apiKey}`);
  return headers;
}

async function parseError(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null);
  const message =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : `${fallback}: ${res.status}`;
  return new Error(message);
}

export async function fetchFsCapabilities(): Promise<FsCapabilitiesResponse> {
  const res = await fetch(`${baseUrl()}/api/fs/capabilities`, { headers: authHeaders() });
  if (!res.ok) throw await parseError(res, "Failed to fetch file-storage capabilities");
  return res.json();
}

export async function fetchTaskAttachments(taskId: string): Promise<TaskAttachmentsResponse> {
  const res = await fetch(`${baseUrl()}/api/fs/tasks/${encodeURIComponent(taskId)}/files`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw await parseError(res, "Failed to fetch task attachments");
  return res.json();
}

export async function uploadTaskAttachment({
  taskId,
  file,
  intent,
  description,
  isPrimary,
}: UploadTaskAttachmentInput): Promise<TaskAttachment> {
  const params = new URLSearchParams({ name: file.name });
  if (intent) params.set("intent", intent);
  if (description) params.set("description", description);
  if (isPrimary) params.set("isPrimary", "true");
  const res = await fetch(
    `${baseUrl()}/api/fs/tasks/${encodeURIComponent(taskId)}/files?${params.toString()}`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": file.type || "application/octet-stream" }),
      body: file,
    },
  );
  if (!res.ok) throw await parseError(res, "Failed to upload attachment");
  return res.json();
}

export async function deleteTaskAttachment(taskId: string, attachmentId: string): Promise<void> {
  const res = await fetch(
    `${baseUrl()}/api/fs/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(attachmentId)}`,
    {
      method: "DELETE",
      headers: authHeaders(),
    },
  );
  if (!res.ok) throw await parseError(res, "Failed to delete attachment");
}

export async function fetchTaskAttachmentBlob(taskId: string, attachmentId: string): Promise<Blob> {
  const res = await fetch(
    `${baseUrl()}/api/fs/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(attachmentId)}/raw`,
    {
      headers: authHeaders(),
    },
  );
  if (!res.ok) throw await parseError(res, "Failed to download attachment");
  return res.blob();
}

export function rawTaskAttachmentUrl(taskId: string, attachmentId: string): string {
  return `${baseUrl()}/api/fs/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(attachmentId)}/raw`;
}

export function useFsCapabilities() {
  return useQuery({
    queryKey: ["fs", "capabilities"],
    queryFn: fetchFsCapabilities,
    staleTime: 30_000,
  });
}

export function useTaskAttachments(taskId: string, initialData?: TaskAttachment[]) {
  return useQuery({
    queryKey: ["task", taskId, "attachments"],
    queryFn: () => fetchTaskAttachments(taskId),
    enabled: !!taskId,
    initialData: initialData ? { attachments: initialData } : undefined,
  });
}

export function useUploadAttachment(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<UploadTaskAttachmentInput, "taskId">) =>
      uploadTaskAttachment({ taskId, ...input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      queryClient.invalidateQueries({ queryKey: ["task", taskId, "attachments"] });
      toast.success("Attachment uploaded");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    },
  });
}

export function useDeleteAttachment(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (attachmentId: string) => deleteTaskAttachment(taskId, attachmentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      queryClient.invalidateQueries({ queryKey: ["task", taskId, "attachments"] });
      toast.success("Attachment deleted");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Delete failed");
    },
  });
}

import type { TaskAttachmentWrite } from "@desplega/storage";
import type { TaskAttachment } from "../../../types";
import type { InsertTaskAttachmentInput } from "../../db";

/** The `task_attachments` columns an insert or replace writes, with the provider defaults. */
export function taskAttachmentWrite(
  input: Omit<InsertTaskAttachmentInput, "taskId">,
): TaskAttachmentWrite {
  return {
    agent_id: input.agentId ?? null,
    name: input.name,
    kind: input.kind,
    url: input.url ?? null,
    path: input.path ?? null,
    page_id: input.pageId ?? null,
    provider_id: input.providerId ?? defaultProviderId(input.kind),
    provider_key: input.providerKey ?? defaultProviderKey(input),
    capabilities: stringifyAttachmentCapabilities(input.capabilities),
    agent_fs_org_id: input.orgId ?? null,
    agent_fs_drive_id: input.driveId ?? null,
    mime_type: input.mimeType ?? null,
    size_bytes: input.sizeBytes ?? null,
    sha256: input.sha256 ?? null,
    intent: input.intent ?? null,
    description: input.description ?? null,
    is_primary: !!input.isPrimary,
    updated_by: input.updatedBy ?? null,
  };
}

function stringifyAttachmentCapabilities(
  value: Record<string, unknown> | undefined,
): string | null {
  return value ? JSON.stringify(value) : null;
}

function defaultProviderId(kind: TaskAttachment["kind"]): string {
  if (kind === "agent-fs" || kind === "shared-fs") return "agent-fs";
  return kind;
}

function defaultProviderKey(
  input: Pick<InsertTaskAttachmentInput, "kind" | "path" | "url" | "pageId">,
): string | null {
  if (input.kind === "agent-fs" || input.kind === "shared-fs") return input.path ?? null;
  if (input.kind === "url") return input.url ?? null;
  if (input.kind === "page") return input.pageId ?? null;
  return null;
}

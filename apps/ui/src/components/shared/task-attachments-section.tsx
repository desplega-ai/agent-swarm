import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchTaskAttachmentBlob,
  useDeleteAttachment,
  useFsCapabilities,
  useTaskAttachments,
  useUploadAttachment,
} from "@/api/fs";
import type { TaskAttachment, TaskAttachmentKind } from "@/api/types";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Default agent-fs live host used when the dashboard's runtime config has
 * not been told otherwise. Kept in sync with `DEFAULT_AGENT_FS_LIVE_URL` in
 * `src/utils/constants.ts`.
 */
const DEFAULT_AGENT_FS_LIVE_URL = "https://live.agent-fs.dev";

/**
 * `import.meta.env.VITE_AGENT_FS_LIVE_URL` lets self-hosted deployments point
 * the dashboard at a different agent-fs live host. Falls back to the public
 * production host so the default install keeps rendering working links.
 */
function getAgentFsLiveUrl(): string {
  const raw = import.meta.env.VITE_AGENT_FS_LIVE_URL?.trim();
  return (raw || DEFAULT_AGENT_FS_LIVE_URL).replace(/\/+$/, "");
}

function getAgentFsDefaultOrgId(): string | undefined {
  const raw = import.meta.env.VITE_AGENT_FS_DEFAULT_ORG_ID?.trim();
  return raw || undefined;
}

function getAgentFsDefaultDriveId(): string | undefined {
  const raw = import.meta.env.VITE_AGENT_FS_DEFAULT_DRIVE_ID?.trim();
  return raw || undefined;
}

/**
 * Mirror of `buildAgentFsLiveUrl` in `src/utils/constants.ts`. Returns null
 * when the path is missing or no org/drive pair is available (row-level
 * fields with env-var fallback) — callers fall back to a non-clickable row.
 */
export function buildAgentFsLiveUrl(opts: {
  path?: string | null;
  orgId?: string | null;
  driveId?: string | null;
}): string | null {
  const path = opts.path?.trim();
  if (!path) return null;
  const orgId = opts.orgId?.trim() || getAgentFsDefaultOrgId();
  const driveId = opts.driveId?.trim() || getAgentFsDefaultDriveId();
  if (!orgId || !driveId) return null;
  const host = getAgentFsLiveUrl();
  const normalizedPath = path.replace(/^\/+/, "");
  return `${host}/file/~/${orgId}/${driveId}/${normalizedPath}`;
}

/**
 * Per-row resolution mirrors `resolveAttachmentDisplay` in `src/slack/blocks.ts`.
 * For `agent-fs` we build a public live-URL when the row carries `orgId` and
 * `driveId` (or the operator-set env-var fallbacks supply them); otherwise
 * the row stays non-clickable and we surface the raw path so users can copy
 * it manually.
 */
function resolveHref(a: TaskAttachment): string | null {
  switch (a.kind) {
    case "url":
      return a.url ?? null;
    case "page":
      // SPA-relative — react-router handles `/pages/:id`. We still render as
      // an anchor with target="_blank" so the link survives copy/paste.
      return a.pageId ? `/pages/${a.pageId}` : null;
    case "agent-fs":
      return buildAgentFsLiveUrl({ path: a.path, orgId: a.orgId, driveId: a.driveId });
    case "shared-fs":
      return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function KindBadge({ kind }: { kind: TaskAttachmentKind }) {
  return (
    <Badge variant="outline" size="tag" className="text-muted-foreground">
      {kind}
    </Badge>
  );
}

function ProviderBadge({ providerId }: { providerId?: string }) {
  if (!providerId) return null;
  return (
    <Badge variant="secondary" size="tag" className="text-muted-foreground">
      {providerId}
    </Badge>
  );
}

function CopyPathButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy path"}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={cn(
        "inline-flex h-5 w-5 items-center justify-center rounded-md",
        "border border-border bg-popover/60 text-muted-foreground",
        "opacity-70 transition-opacity hover:opacity-100 hover:text-foreground",
        copied && "opacity-100 text-status-success-strong",
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading"; attachmentId: string }
  | { kind: "text"; attachmentId: string; name: string; text: string }
  | { kind: "image"; attachmentId: string; name: string; url: string }
  | { kind: "unsupported"; attachmentId: string; name: string; message: string };

function looksTextual(attachment: TaskAttachment): boolean {
  const mime = attachment.mimeType?.toLowerCase() ?? "";
  const name = attachment.name.toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("yaml") ||
    mime.includes("javascript") ||
    [".md", ".txt", ".json", ".csv", ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".yml"].some(
      (suffix) => name.endsWith(suffix),
    )
  );
}

function looksImage(attachment: TaskAttachment): boolean {
  return attachment.mimeType?.toLowerCase().startsWith("image/") ?? false;
}

function scrubPreviewText(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, "$1[REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:API|TOKEN|SECRET|KEY)[A-Z0-9_]*\s*=\s*)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/\b(aswt_|sk-|af_)[A-Za-z0-9._-]{12,}/g, "$1[REDACTED]");
}

function AttachmentRow({
  attachment,
  onPreview,
  onDownload,
  onDelete,
  previewing,
  deleting,
}: {
  attachment: TaskAttachment;
  onPreview: (attachment: TaskAttachment) => void;
  onDownload: (attachment: TaskAttachment) => void;
  onDelete: (attachment: TaskAttachment) => void;
  previewing: boolean;
  deleting: boolean;
}) {
  const href = resolveHref(attachment);
  const descriptor = attachment.intent || attachment.description;
  // For agent-fs / shared-fs we show the raw path so users can at least copy
  // it; for `page` and `url` the anchor itself communicates the target.
  const pathDisplay =
    attachment.kind === "shared-fs"
      ? `shared-fs:${attachment.path ?? ""}`
      : attachment.kind === "agent-fs"
        ? `agent-fs:${attachment.path ?? ""}`
        : null;

  return (
    <div className="flex items-start gap-3 py-2 border-b border-border/40 last:border-b-0">
      <Paperclip className="h-3.5 w-3.5 text-muted-foreground mt-1 shrink-0" />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          {attachment.isPrimary && (
            <Star
              className="h-3 w-3 text-status-active-strong shrink-0"
              aria-label="Primary attachment"
            />
          )}
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-primary hover:underline truncate"
            >
              {attachment.name}
              <ExternalLink className="h-3 w-3 inline-block ml-1 -mt-0.5 text-muted-foreground" />
            </a>
          ) : (
            <span className="text-sm font-medium text-foreground truncate">{attachment.name}</span>
          )}
          <KindBadge kind={attachment.kind} />
          <ProviderBadge providerId={attachment.providerId} />
        </div>
        {descriptor && (
          <p className="text-xs italic text-muted-foreground line-clamp-2">{descriptor}</p>
        )}
        {pathDisplay && (
          <div className="flex items-center gap-1.5">
            <code className="text-[11px] font-mono text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded truncate">
              {pathDisplay}
            </code>
            <CopyPathButton value={attachment.path ?? ""} />
          </div>
        )}
        {(attachment.mimeType || attachment.sizeBytes != null) && (
          <p className="text-[10px] text-muted-foreground/70 font-mono">
            {[
              attachment.mimeType,
              attachment.sizeBytes != null ? formatSize(attachment.sizeBytes) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => onPreview(attachment)}
          disabled={previewing}
          aria-label={`Preview ${attachment.name}`}
          title="Preview"
        >
          {previewing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => onDownload(attachment)}
          aria-label={`Download ${attachment.name}`}
          title="Download"
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-status-error hover:text-status-error"
          onClick={() => onDelete(attachment)}
          disabled={deleting}
          aria-label={`Delete ${attachment.name}`}
          title="Delete"
        >
          {deleting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * Renders the `Attachments` card on a task detail page. The card stays visible
 * even when empty so humans can attach input files before or during execution.
 */
export function TaskAttachmentsSection({
  taskId,
  attachments,
  className,
  hideWhenEmpty = false,
}: {
  taskId: string;
  attachments: TaskAttachment[] | undefined;
  className?: string;
  hideWhenEmpty?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { data: capabilities } = useFsCapabilities();
  const listQuery = useTaskAttachments(taskId, attachments);
  const upload = useUploadAttachment(taskId);
  const remove = useDeleteAttachment(taskId);
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });

  const rows = useMemo(
    () => listQuery.data?.attachments ?? attachments ?? [],
    [attachments, listQuery.data?.attachments],
  );
  const uploadSupported = capabilities?.providerId !== "unavailable";

  useEffect(() => {
    return () => {
      if (preview.kind === "image") URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  if (hideWhenEmpty && rows.length === 0 && !listQuery.isLoading) {
    return null;
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    upload.mutate({ file, intent: "input" });
  };

  const handlePreview = async (attachment: TaskAttachment) => {
    if (preview.kind === "image") URL.revokeObjectURL(preview.url);
    setPreview({ kind: "loading", attachmentId: attachment.id });
    try {
      const blob = await fetchTaskAttachmentBlob(taskId, attachment.id);
      if (looksImage(attachment)) {
        setPreview({
          kind: "image",
          attachmentId: attachment.id,
          name: attachment.name,
          url: URL.createObjectURL(blob),
        });
        return;
      }
      if (looksTextual(attachment) && blob.size <= 512 * 1024) {
        setPreview({
          kind: "text",
          attachmentId: attachment.id,
          name: attachment.name,
          text: scrubPreviewText(await blob.text()).slice(0, 20_000),
        });
        return;
      }
      setPreview({
        kind: "unsupported",
        attachmentId: attachment.id,
        name: attachment.name,
        message: "Preview is available for text files up to 512 KB and images.",
      });
    } catch (error) {
      setPreview({
        kind: "unsupported",
        attachmentId: attachment.id,
        name: attachment.name,
        message: error instanceof Error ? error.message : "Preview failed.",
      });
    }
  };

  const handleDownload = async (attachment: TaskAttachment) => {
    const blob = await fetchTaskAttachmentBlob(taskId, attachment.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = attachment.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleDelete = (attachment: TaskAttachment) => {
    if (preview.kind !== "idle" && preview.attachmentId === attachment.id) {
      if (preview.kind === "image") URL.revokeObjectURL(preview.url);
      setPreview({ kind: "idle" });
    }
    remove.mutate(attachment.id);
  };

  return (
    <CollapsibleSection
      variant="card"
      title={`Attachments (${rows.length})`}
      icon={Paperclip}
      iconColor="text-muted-foreground"
      borderColor="border-border"
      bgColor="bg-muted/20"
      className={className}
      defaultOpen
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-xs text-muted-foreground">
            <span className="font-mono">{capabilities?.providerId ?? "file provider"}</span>
            {capabilities?.capabilities.search ? " · search enabled" : " · core files"}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            aria-label="Upload attachment file"
            className="sr-only"
            onChange={handleFileChange}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={!uploadSupported || upload.isPending}
          >
            {upload.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Upload
          </Button>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
            No attachments
          </div>
        ) : (
          <div className="max-h-72 overflow-auto">
            {rows.map((a) => (
              <AttachmentRow
                key={a.id}
                attachment={a}
                onPreview={handlePreview}
                onDownload={handleDownload}
                onDelete={handleDelete}
                previewing={preview.kind === "loading" && preview.attachmentId === a.id}
                deleting={remove.isPending && remove.variables === a.id}
              />
            ))}
          </div>
        )}

        {preview.kind !== "idle" && preview.kind !== "loading" && (
          <div className="rounded-md border border-border bg-background">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
                {preview.kind === "image" ? (
                  <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <span className="truncate">{preview.name}</span>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => {
                  if (preview.kind === "image") URL.revokeObjectURL(preview.url);
                  setPreview({ kind: "idle" });
                }}
                aria-label="Close preview"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            {preview.kind === "text" && (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-3 text-xs leading-relaxed">
                {preview.text}
              </pre>
            )}
            {preview.kind === "image" && (
              <div className="max-h-96 overflow-auto p-3">
                <img src={preview.url} alt={preview.name} className="max-h-80 max-w-full rounded" />
              </div>
            )}
            {preview.kind === "unsupported" && (
              <p className="p-3 text-xs text-muted-foreground">{preview.message}</p>
            )}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Expand,
  ExternalLink,
  File,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchTaskAttachmentBlob, useDeleteAttachment, useTaskAttachments } from "@/api/fs";
import type { TaskAttachment, TaskAttachmentKind } from "@/api/types";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

type PreviewKind = "image" | "video" | "pdf" | "text";

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "url"; url: string; contentType: Exclude<PreviewKind, "text"> }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "error"; message: string };

const TEXT_EXTENSIONS = new Set([
  "css",
  "csv",
  "html",
  "js",
  "jsx",
  "json",
  "log",
  "md",
  "mjs",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

function getExtension(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

function getPreviewKind(attachment: TaskAttachment): PreviewKind | null {
  const mime = attachment.mimeType?.split(";")[0]?.trim().toLowerCase();
  const extension = getExtension(attachment.name);

  // The agent-fs upload route can persist the provider's JSON response content
  // type even though the raw download route returns the actual file type.
  // Treat only that wrapper shape as non-authoritative; otherwise MIME wins.
  const agentFsJsonWrapper =
    attachment.providerId === "agent-fs" && mime === "application/json" && extension !== "json";

  if (mime && !agentFsJsonWrapper) {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime === "application/pdf") return "pdf";
    if (
      mime.startsWith("text/") ||
      mime.includes("json") ||
      mime.includes("xml") ||
      mime.includes("yaml") ||
      mime.includes("csv") ||
      mime.includes("javascript")
    ) {
      return "text";
    }
    return null;
  }

  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].includes(extension)) return "image";
  if (["mp4", "webm", "mov", "m4v"].includes(extension)) return "video";
  if (extension === "pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return null;
}

function previewKindLabel(kind: PreviewKind): string {
  switch (kind) {
    case "image":
      return "Image preview";
    case "video":
      return "Video preview";
    case "pdf":
      return "PDF preview";
    case "text":
      return "Text preview";
  }
}

function PreviewIcon({ kind }: { kind: PreviewKind | null }) {
  if (kind === "image") return <ImageIcon className="h-4 w-4 text-muted-foreground" />;
  if (kind === "text" || kind === "pdf") {
    return <FileText className="h-4 w-4 text-muted-foreground" />;
  }
  return <File className="h-4 w-4 text-muted-foreground" />;
}

function scrubPreviewText(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, "$1[REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:API|TOKEN|SECRET|KEY)[A-Z0-9_]*\s*=\s*)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/\b(aswt_|sk-|af_)[A-Za-z0-9._-]{12,}/g, "$1[REDACTED]");
}

function AttachmentRow({
  attachment,
  onDownload,
  onDelete,
  deleting,
  taskId,
  variant = "card",
}: {
  attachment: TaskAttachment;
  onDownload: (attachment: TaskAttachment) => void;
  onDelete?: (attachment: TaskAttachment) => void;
  deleting?: boolean;
  taskId: string;
  variant?: "card" | "prompt";
}) {
  const href = resolveHref(attachment);
  const descriptor = attachment.intent || attachment.description;
  const previewKind = getPreviewKind(attachment);
  const [expanded, setExpanded] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const previewStateRef = useRef<PreviewState["kind"]>("idle");
  const sourceKey = `${taskId}:${attachment.id}`;
  const previousSourceKeyRef = useRef(sourceKey);
  // For agent-fs / shared-fs we show the raw path so users can at least copy
  // it; for `page` and `url` the anchor itself communicates the target.
  const pathDisplay =
    attachment.kind === "shared-fs"
      ? `shared-fs:${attachment.path ?? ""}`
      : attachment.kind === "agent-fs"
        ? `agent-fs:${attachment.path ?? ""}`
        : null;

  useEffect(() => {
    if (previousSourceKeyRef.current === sourceKey) return;
    previousSourceKeyRef.current = sourceKey;
    previewStateRef.current = "idle";
    setPreview({ kind: "idle" });
    setExpanded(false);
    setLightboxOpen(false);
  }, [sourceKey]);

  useEffect(() => {
    const shouldLoadPromptThumbnail = variant === "prompt" && previewKind === "image";
    if (
      !(expanded || shouldLoadPromptThumbnail) ||
      !previewKind ||
      previewStateRef.current !== "idle"
    ) {
      return;
    }

    let cancelled = false;
    previewStateRef.current = "loading";
    setPreview({ kind: "loading" });
    fetchTaskAttachmentBlob(taskId, attachment.id)
      .then(async (blob) => {
        if (cancelled) return;
        if (previewKind === "text") {
          const maxBytes = 512 * 1024;
          if (blob.size > maxBytes) {
            previewStateRef.current = "error";
            setPreview({
              kind: "error",
              message:
                "Text preview is available for files up to 512 KB. Download the file to view it.",
            });
            return;
          }
          const text = scrubPreviewText(await blob.text());
          previewStateRef.current = "text";
          setPreview({
            kind: "text",
            text: text.slice(0, 20_000),
            truncated: text.length > 20_000,
          });
          return;
        }
        previewStateRef.current = "url";
        setPreview({ kind: "url", url: URL.createObjectURL(blob), contentType: previewKind });
      })
      .catch((error) => {
        if (cancelled) return;
        previewStateRef.current = "error";
        setPreview({
          kind: "error",
          message: error instanceof Error ? error.message : "Preview failed.",
        });
      });

    return () => {
      cancelled = true;
      if (previewStateRef.current === "loading") {
        previewStateRef.current = "idle";
      }
    };
  }, [attachment.id, expanded, previewKind, taskId, variant]);

  useEffect(() => {
    return () => {
      if (preview.kind === "url") URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  const toggleExpanded = () => {
    if (!previewKind) return;
    setExpanded((value) => !value);
  };

  if (variant === "prompt") {
    const openPreview = () => {
      if (!previewKind) {
        onDownload(attachment);
        return;
      }
      setExpanded(true);
      setLightboxOpen(true);
    };

    if (previewKind === "image") {
      return (
        <>
          <button
            type="button"
            onClick={openPreview}
            className={cn(
              "group relative h-24 w-32 overflow-hidden rounded-xl border border-border bg-muted",
              "shadow-sm transition hover:border-primary/45 hover:shadow-md",
              "sm:h-28 sm:w-40",
            )}
            aria-label={`Expand ${attachment.name} preview`}
            title={attachment.name}
          >
            {preview.kind === "url" ? (
              <img src={preview.url} alt={attachment.name} className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-muted-foreground">
                {preview.kind === "loading" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ImageIcon className="h-5 w-5" />
                )}
              </span>
            )}
            <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-background/80 px-2 py-1 text-[10px] text-foreground opacity-0 backdrop-blur-sm transition group-hover:opacity-100">
              <ImageIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{attachment.name}</span>
            </span>
          </button>

          <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
            <DialogContent className="max-h-[92vh] overflow-hidden p-4 sm:max-w-4xl">
              <DialogHeader className="pr-8">
                <DialogTitle className="truncate text-base">{attachment.name}</DialogTitle>
                <DialogDescription>{previewKindLabel(previewKind)}</DialogDescription>
              </DialogHeader>
              {preview.kind === "loading" ? (
                <div className="flex h-48 items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading preview
                </div>
              ) : preview.kind === "error" ? (
                <div className="rounded-md border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
                  {preview.message}
                </div>
              ) : preview.kind === "url" ? (
                <PreviewMedia name={attachment.name} preview={preview} />
              ) : null}
            </DialogContent>
          </Dialog>
        </>
      );
    }

    const label =
      previewKind === "video"
        ? "Video"
        : previewKind === "pdf"
          ? "PDF"
          : previewKind === "text"
            ? "Text"
            : attachment.mimeType?.split("/")[1]?.toUpperCase() || attachment.kind;

    return (
      <>
        <button
          type="button"
          onClick={openPreview}
          className={cn(
            "inline-flex max-w-[15rem] items-center gap-2 rounded-xl border border-border",
            "bg-background px-2.5 py-2 text-left text-xs shadow-sm transition",
            "hover:border-primary/45 hover:bg-muted/30 sm:max-w-[18rem]",
          )}
          aria-label={
            previewKind ? `Expand ${attachment.name} preview` : `Download ${attachment.name}`
          }
          title={attachment.name}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <PreviewIcon kind={previewKind} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-foreground">{attachment.name}</span>
            <span className="block truncate font-mono text-[10px] uppercase text-muted-foreground">
              {label}
              {attachment.sizeBytes != null ? ` · ${formatSize(attachment.sizeBytes)}` : ""}
            </span>
          </span>
          {previewKind ? (
            <Expand className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>

        <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
          <DialogContent className="max-h-[92vh] overflow-hidden p-4 sm:max-w-4xl">
            <DialogHeader className="pr-8">
              <DialogTitle className="truncate text-base">{attachment.name}</DialogTitle>
              <DialogDescription>
                {previewKind ? previewKindLabel(previewKind) : ""}
              </DialogDescription>
            </DialogHeader>
            {preview.kind === "loading" ? (
              <div className="flex h-48 items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading preview
              </div>
            ) : preview.kind === "error" ? (
              <div className="rounded-md border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
                {preview.message}
              </div>
            ) : preview.kind === "text" ? (
              <pre className="max-h-[72vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-3 text-xs leading-relaxed">
                {preview.text}
                {preview.truncated ? "\n\n[Preview truncated]" : ""}
              </pre>
            ) : preview.kind === "url" ? (
              <PreviewMedia name={attachment.name} preview={preview} />
            ) : null}
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <div className="rounded-md border border-border/70 bg-background">
      <div className="flex items-start gap-3 p-3">
        <button
          type="button"
          onClick={toggleExpanded}
          disabled={!previewKind}
          className={cn(
            "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40",
            previewKind && "transition-colors hover:bg-muted",
          )}
          aria-label={
            previewKind
              ? `${expanded ? "Collapse" : "Expand"} ${attachment.name}`
              : `${attachment.name} has no inline preview`
          }
        >
          <PreviewIcon kind={previewKind} />
        </button>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            {attachment.isPrimary && (
              <Star
                className="h-3 w-3 shrink-0 text-status-active-strong"
                aria-label="Primary attachment"
              />
            )}
            <span className="truncate text-sm font-medium text-foreground">{attachment.name}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <KindBadge kind={attachment.kind} />
            <ProviderBadge providerId={attachment.providerId} />
            {previewKind ? (
              <Badge variant="secondary" size="tag" className="text-muted-foreground">
                {previewKindLabel(previewKind)}
              </Badge>
            ) : (
              <Badge variant="outline" size="tag" className="text-muted-foreground">
                Download only
              </Badge>
            )}
          </div>
          {descriptor && (
            <p className="line-clamp-2 text-xs italic text-muted-foreground">{descriptor}</p>
          )}
          {pathDisplay && (
            <div className="flex items-center gap-1.5">
              <code className="truncate rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {pathDisplay}
              </code>
              <CopyPathButton value={attachment.path ?? ""} />
            </div>
          )}
          {(attachment.mimeType || attachment.sizeBytes != null) && (
            <p className="font-mono text-[10px] text-muted-foreground/70">
              {[
                attachment.mimeType,
                attachment.sizeBytes != null ? formatSize(attachment.sizeBytes) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {previewKind ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={toggleExpanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${attachment.name}`}
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </Button>
          ) : href ? (
            <Button type="button" size="icon" variant="ghost" className="h-7 w-7" asChild>
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${attachment.name}`}
                title="Open"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          ) : null}
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
            onClick={() => onDelete?.(attachment)}
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

      {expanded && previewKind ? (
        <div className="border-t border-border bg-muted/20 p-3">
          {preview.kind === "loading" ? (
            <div className="flex h-28 items-center justify-center gap-2 rounded-md border border-dashed border-border bg-background text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading preview
            </div>
          ) : preview.kind === "error" ? (
            <div className="rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">
              {preview.message}
            </div>
          ) : preview.kind === "text" ? (
            <button
              type="button"
              className="block w-full rounded-md border border-border bg-background text-left transition-colors hover:border-primary/40"
              onClick={() => setLightboxOpen(true)}
              aria-label={`Expand ${attachment.name} preview`}
            >
              <pre className="max-h-48 overflow-hidden whitespace-pre-wrap p-3 text-xs leading-relaxed">
                {preview.text}
                {preview.truncated ? "\n\n[Preview truncated]" : ""}
              </pre>
            </button>
          ) : preview.kind === "url" ? (
            <PreviewMedia
              name={attachment.name}
              preview={preview}
              compact
              onExpand={() => setLightboxOpen(true)}
            />
          ) : null}
        </div>
      ) : null}

      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent className="max-h-[92vh] overflow-hidden p-4 sm:max-w-4xl">
          <DialogHeader className="pr-8">
            <DialogTitle className="truncate text-base">{attachment.name}</DialogTitle>
            <DialogDescription>
              {previewKind ? previewKindLabel(previewKind) : ""}
            </DialogDescription>
          </DialogHeader>
          {preview.kind === "loading" ? (
            <div className="flex h-48 items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading preview
            </div>
          ) : preview.kind === "error" ? (
            <div className="rounded-md border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
              {preview.message}
            </div>
          ) : preview.kind === "text" ? (
            <pre className="max-h-[72vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-3 text-xs leading-relaxed">
              {preview.text}
              {preview.truncated ? "\n\n[Preview truncated]" : ""}
            </pre>
          ) : preview.kind === "url" ? (
            <PreviewMedia name={attachment.name} preview={preview} />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function TaskPromptAttachments({
  taskId,
  attachments,
  className,
}: {
  taskId: string;
  attachments: TaskAttachment[] | undefined;
  className?: string;
}) {
  const listQuery = useTaskAttachments(taskId, attachments);
  const rows = useMemo(
    () => listQuery.data?.attachments ?? attachments ?? [],
    [attachments, listQuery.data?.attachments],
  );

  if (rows.length === 0) return null;

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

  return (
    <section
      className={cn("flex max-w-full flex-wrap justify-end gap-2", className)}
      aria-label="Prompt attachments"
    >
      {rows.map((a) => (
        <AttachmentRow
          key={a.id}
          attachment={a}
          onDownload={handleDownload}
          taskId={taskId}
          variant="prompt"
        />
      ))}
    </section>
  );
}

function PreviewMedia({
  name,
  preview,
  compact = false,
  onExpand,
}: {
  name: string;
  preview: Extract<PreviewState, { kind: "url" }>;
  compact?: boolean;
  onExpand?: () => void;
}) {
  const expandButton = onExpand ? (
    <Button
      type="button"
      size="icon"
      variant="secondary"
      className="absolute right-2 top-2 h-7 w-7 bg-background/85"
      onClick={onExpand}
      aria-label={`Expand ${name} preview`}
      title="Expand"
    >
      <Expand className="h-3.5 w-3.5" />
    </Button>
  ) : null;

  if (preview.contentType === "image") {
    return (
      <div className="relative flex justify-center rounded-md border border-border bg-background p-2">
        <button type="button" onClick={onExpand} className="max-w-full" disabled={!onExpand}>
          <img
            src={preview.url}
            alt={name}
            className={cn(
              "max-w-full rounded object-contain",
              compact ? "max-h-48 sm:max-h-56" : "max-h-[72vh]",
            )}
          />
        </button>
        {expandButton}
      </div>
    );
  }

  if (preview.contentType === "video") {
    return (
      <div className="relative rounded-md border border-border bg-background p-2">
        <video
          src={preview.url}
          controls
          className={cn("w-full rounded bg-black", compact ? "max-h-56" : "max-h-[72vh]")}
        >
          <track kind="captions" />
        </video>
        {expandButton}
      </div>
    );
  }

  return (
    <div className="relative rounded-md border border-border bg-background p-2">
      <iframe
        src={preview.url}
        title={name}
        className={cn("w-full rounded border-0", compact ? "h-56" : "h-[72vh]")}
      />
      {expandButton}
    </div>
  );
}

/** Renders the `Attachments` card on a task detail page when files exist. */
export function TaskAttachmentsSection({
  taskId,
  attachments,
  className,
}: {
  taskId: string;
  attachments: TaskAttachment[] | undefined;
  className?: string;
}) {
  const listQuery = useTaskAttachments(taskId, attachments);
  const remove = useDeleteAttachment(taskId);

  const rows = useMemo(
    () => listQuery.data?.attachments ?? attachments ?? [],
    [attachments, listQuery.data?.attachments],
  );

  if (rows.length === 0) {
    return null;
  }

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
        <div className="max-h-[34rem] space-y-2 overflow-auto pr-1">
          {rows.map((a) => (
            <AttachmentRow
              key={a.id}
              attachment={a}
              onDownload={handleDownload}
              onDelete={handleDelete}
              deleting={remove.isPending && remove.variables === a.id}
              taskId={taskId}
            />
          ))}
        </div>
      </div>
    </CollapsibleSection>
  );
}

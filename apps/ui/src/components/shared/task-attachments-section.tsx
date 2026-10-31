import {
  Download,
  Expand,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileText,
  Film,
  Github,
  Image as ImageIcon,
  Link2,
  PanelsTopLeft,
  Paperclip,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchTaskAttachmentBlob, useDeleteAttachment, useTaskAttachments } from "@/api/fs";
import type { TaskAttachment } from "@/api/types";
import { Spinner } from "@/components/kibo-ui/spinner";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { InAppOrExternalLink } from "@/components/shared/in-app-or-external-link";
import {
  type AgentFsLinkContext,
  AttachmentName,
  agentFsAttachmentLinks,
} from "@/components/shared/task-attachment-link";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MiddleTruncation } from "@/components/ui/middle-truncation";
import { useOptionalAgentFs } from "@/contexts/agent-fs-context";
import { formatBytes } from "@/lib/format-bytes";
import { scrubSecretText } from "@/lib/scrub-secrets";
import { cn } from "@/lib/utils";

/**
 * Per-row resolution mirrors `resolveAttachmentDisplay` in `src/slack/blocks.ts`.
 * For `agent-fs` we build a public live-URL from the row's `orgId` and
 * `driveId` (or, while Comb is on, the swarm drive when the row has neither);
 * otherwise the row stays non-clickable and we surface the raw path so users
 * can copy it manually. `combTo` opens an agent-fs file in Comb (same tab)
 * while Comb is connected; `href` then stays the "Open in agent-fs" action.
 */
function resolveLinks(
  a: TaskAttachment,
  agentFs: AgentFsLinkContext | null,
): { href: string | null; combTo: string | null } {
  switch (a.kind) {
    case "url":
      return { href: a.url ?? null, combTo: null };
    case "page":
      // SPA-relative — react-router handles `/pages/:id`. We still render as
      // an anchor with target="_blank" so the link survives copy/paste.
      return { href: a.pageId ? `/pages/${a.pageId}` : null, combTo: null };
    case "agent-fs":
      return agentFsAttachmentLinks(a, agentFs);
    case "shared-fs":
      return { href: null, combTo: null };
  }
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

/** A list row's icon: the link's provider, a page, or the file's type. */
function KindIcon({
  attachment,
  previewKind,
}: {
  attachment: TaskAttachment;
  previewKind: PreviewKind | null;
}) {
  const className = "size-4";
  if (attachment.kind === "url") {
    return attachment.providerId === "github" ? (
      <Github className={className} />
    ) : (
      <Link2 className={className} />
    );
  }
  if (attachment.kind === "page") return <PanelsTopLeft className={className} />;
  if (previewKind === "image") return <ImageIcon className={className} />;
  if (previewKind === "video") return <Film className={className} />;
  if (previewKind === "text" || previewKind === "pdf") return <FileText className={className} />;
  return <File className={className} />;
}

/** "task-deliverable" reads "Task deliverable". A sentence stays as it is. */
const SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function humanizeSlug(slug: string): string {
  const words = slug.replace(/[-_]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * A GitHub or GitLab PR, MR or issue link, read from its URL: a short label
 * ("PR #2593") and the repo. Null for any other link.
 */
function vcsRef(url: string | undefined): { label: string; repo: string } | null {
  let path: string;
  let host: string;
  try {
    ({ pathname: path, hostname: host } = new URL(url ?? ""));
  } catch {
    return null;
  }
  const gitlab = /^\/(.+?)\/-\/(merge_requests|issues)\/(\d+)/.exec(path);
  if (gitlab) {
    const label = gitlab[2] === "issues" ? `Issue #${gitlab[3]}` : `MR !${gitlab[3]}`;
    return { label, repo: gitlab[1] };
  }
  // GitLab's `/-/` paths are its own on any host; the GitHub shape is not
  // (Sentry has `/organizations/<org>/issues/<n>`), so it needs GitHub's host.
  const github =
    host === "github.com" ? /^\/([^/]+\/[^/]+)\/(pull|issues)\/(\d+)/.exec(path) : null;
  if (github) {
    const label = github[2] === "pull" ? `PR #${github[3]}` : `Issue #${github[3]}`;
    return { label, repo: github[1] };
  }
  return null;
}

/**
 * A list row's one meta line: what the row is (a PR's repo, the link's
 * host, "Page", or the file's type), its size, and a short intent ("Task
 * deliverable"). A longer intent or description goes on its own line
 * (`note`).
 */
function rowMeta(
  attachment: TaskAttachment,
  previewKind: PreviewKind | null,
  ref: { repo: string } | null,
): { meta: string; note: string | null } {
  // A file named without an extension ("Research report") keeps it in its path.
  const extension = getExtension(attachment.name) || getExtension(attachment.path ?? "");
  const what =
    attachment.kind === "url"
      ? (ref?.repo ?? hostOf(attachment.url) ?? "Link")
      : attachment.kind === "page"
        ? "Page"
        : extension
          ? extension.toUpperCase()
          : previewKind === "pdf"
            ? "PDF"
            : previewKind
              ? previewKind.charAt(0).toUpperCase() + previewKind.slice(1)
              : "File";
  const descriptor = attachment.intent || attachment.description || null;
  const shortIntent = descriptor && SLUG_RE.test(descriptor) ? humanizeSlug(descriptor) : null;
  const meta = [
    what,
    attachment.sizeBytes != null ? formatBytes(attachment.sizeBytes) : null,
    attachment.kind === "shared-fs" ? "shared-fs" : null,
    shortIntent,
  ]
    .filter(Boolean)
    .join(" · ");
  return { meta, note: shortIntent ? null : descriptor };
}

/** A list row's hover action: a 24 px ghost icon button. */
const ROW_ACTION = "size-6 text-muted-foreground hover:text-foreground";

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
  const agentFs = useOptionalAgentFs();
  const { href, combTo } = resolveLinks(attachment, agentFs);
  const previewKind = getPreviewKind(attachment);
  const [expanded, setExpanded] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const previewStateRef = useRef<PreviewState["kind"]>("idle");
  const sourceKey = `${taskId}:${attachment.id}`;
  const previousSourceKeyRef = useRef(sourceKey);
  // Only drive files have bytes to download (the raw route 404s for `url`
  // and `page`), and a path to copy. For `page` and `url` the name is the link.
  const isFile = attachment.kind === "agent-fs" || attachment.kind === "shared-fs";
  const pathDisplay = isFile ? `${attachment.kind}:${attachment.path ?? ""}` : null;

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
          const text = scrubSecretText(await blob.text());
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
                  <Spinner className="size-4" />
                ) : (
                  <ImageIcon className="h-5 w-5" />
                )}
              </span>
            )}
            <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-background/80 px-2 py-1 text-[10px] text-foreground opacity-0 backdrop-blur-sm transition group-hover:opacity-100">
              <ImageIcon className="h-3 w-3 shrink-0" />
              <MiddleTruncation>{attachment.name}</MiddleTruncation>
            </span>
          </button>

          <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
            <DialogContent className="max-h-[92vh] overflow-hidden p-4 sm:max-w-4xl">
              <DialogHeader className="pr-8">
                <DialogTitle className="text-base">
                  <MiddleTruncation>{attachment.name}</MiddleTruncation>
                </DialogTitle>
                <DialogDescription>{previewKindLabel(previewKind)}</DialogDescription>
              </DialogHeader>
              {preview.kind === "loading" ? (
                <div className="flex h-48 items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
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

    if (href) {
      const metadata = [
        attachment.kind === "agent-fs" ? "Agent FS" : null,
        label !== attachment.kind ? label : null,
        attachment.sizeBytes != null ? formatBytes(attachment.sizeBytes) : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const filename = attachment.path?.split("/").filter(Boolean).at(-1);

      return (
        <div className="inline-flex w-[24rem] max-w-full items-center rounded-xl border border-border bg-background shadow-sm">
          <InAppOrExternalLink
            to={combTo}
            href={href}
            className="group flex min-w-0 flex-1 items-center gap-3 rounded-l-xl px-3 py-2.5 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-label={combTo ? `Open ${attachment.name}` : `Open ${attachment.name} in a new tab`}
            title={attachment.path || attachment.name}
          >
            <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted sm:flex">
              <PreviewIcon kind={previewKind} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 break-words text-sm font-medium text-foreground group-hover:text-primary">
                {attachment.name}
              </span>
              {metadata && <span className="block text-xs text-muted-foreground">{metadata}</span>}
              {!attachment.mimeType && filename && filename !== attachment.name && (
                <MiddleTruncation className="hidden font-mono text-xs text-muted-foreground sm:block">
                  {filename}
                </MiddleTruncation>
              )}
            </span>
            {!combTo && (
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
            )}
          </InAppOrExternalLink>
          {combTo && (
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="shrink-0 border-l border-border-subtle rounded-none text-muted-foreground"
            >
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${attachment.name} in agent-fs`}
                title="Open in agent-fs"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="mr-1 shrink-0 border-l border-border-subtle rounded-l-none text-muted-foreground"
            onClick={() => onDownload(attachment)}
            aria-label={`Download ${attachment.name}`}
            title={`Download ${attachment.name}`}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        </div>
      );
    }

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
            <MiddleTruncation className="font-medium text-foreground">
              {attachment.name}
            </MiddleTruncation>
            <span className="block truncate font-mono text-[10px] uppercase text-muted-foreground">
              {label}
              {attachment.sizeBytes != null ? ` · ${formatBytes(attachment.sizeBytes)}` : ""}
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
              <DialogTitle className="text-base">
                <MiddleTruncation>{attachment.name}</MiddleTruncation>
              </DialogTitle>
              <DialogDescription>
                {previewKind ? previewKindLabel(previewKind) : ""}
              </DialogDescription>
            </DialogHeader>
            {preview.kind === "loading" ? (
              <div className="flex h-48 items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
                <Spinner className="size-4" />
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

  // A PR or issue link reads "PR #2593"; the stored name is its tooltip.
  const ref = attachment.kind === "url" ? vcsRef(attachment.url) : null;
  const name = ref?.label ?? attachment.name;
  const { meta, note } = rowMeta(attachment, previewKind, ref);
  return (
    // One calm row: a kind icon, the name, one meta line. The actions show on
    // hover or focus over the row's end. A touch screen shows them under the
    // text, since it has no hover.
    <div className="group/attachment hover-linger rounded-lg transition-colors hover:bg-muted focus-within:bg-muted">
      <div className="relative flex items-start gap-2.5 px-2 py-1.5">
        <span
          aria-hidden
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground group-hover/attachment:bg-background group-focus-within/attachment:bg-background"
        >
          <KindIcon attachment={attachment} previewKind={previewKind} />
        </span>
        <div className="min-w-0 flex-1" title={pathDisplay ?? (ref ? attachment.name : undefined)}>
          <div className="flex min-w-0 items-center gap-1.5">
            {attachment.isPrimary && (
              <Star
                className="size-3 shrink-0 text-status-active-strong"
                aria-label="Primary attachment"
              />
            )}
            <AttachmentName href={href} to={combTo} name={name} />
          </div>
          {meta ? <p className="truncate text-xs text-muted-foreground">{meta}</p> : null}
          {note ? <p className="line-clamp-2 text-xs text-muted-foreground">{note}</p> : null}
          <div
            className={cn(
              "pointer-events-none absolute top-1 right-1 flex items-center gap-0.5 rounded-md bg-muted p-0.5 opacity-0 transition-opacity duration-150 ease-snappy",
              "group-hover/attachment:pointer-events-auto group-hover/attachment:opacity-100 group-focus-within/attachment:pointer-events-auto group-focus-within/attachment:opacity-100",
              "pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:-ml-1 pointer-coarse:mt-0.5 pointer-coarse:w-fit pointer-coarse:bg-transparent pointer-coarse:opacity-100",
            )}
          >
            {previewKind ? (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className={ROW_ACTION}
                onClick={toggleExpanded}
                aria-expanded={expanded}
                aria-label={`${expanded ? "Hide" : "Show"} ${name} preview`}
                title={expanded ? "Hide preview" : "Show preview"}
              >
                {expanded ? <EyeOff /> : <Eye />}
              </Button>
            ) : null}
            {/* The name opens Comb, so the live link moves here as "Open in agent-fs". */}
            {href && combTo ? (
              <Button type="button" size="icon-xs" variant="ghost" className={ROW_ACTION} asChild>
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${name} in agent-fs`}
                  title="Open in agent-fs"
                >
                  <ExternalLink />
                </a>
              </Button>
            ) : null}
            {isFile && attachment.path ? (
              <CopyValueButton
                value={attachment.path}
                label="Copy path"
                size="icon-xs"
                className={ROW_ACTION}
                title="Copy path"
              />
            ) : null}
            {isFile ? (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className={ROW_ACTION}
                onClick={() => onDownload(attachment)}
                aria-label={`Download ${name}`}
                title="Download"
              >
                <Download />
              </Button>
            ) : null}
            {onDelete ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 text-muted-foreground hover:text-status-error-strong"
                    disabled={deleting}
                    aria-label={`Delete ${name}`}
                    title="Delete"
                  >
                    {deleting ? <Spinner className="size-3" /> : <Trash2 />}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete attachment</AlertDialogTitle>
                    <AlertDialogDescription>
                      This removes {name} from the task. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => onDelete(attachment)}>
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </div>
        </div>
      </div>

      {expanded && previewKind ? (
        <div className="px-2 pb-2">
          {preview.kind === "loading" ? (
            <div className="flex h-28 items-center justify-center gap-2 rounded-md border border-dashed border-border bg-background text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
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
            <DialogTitle className="text-base">
              <MiddleTruncation>{attachment.name}</MiddleTruncation>
            </DialogTitle>
            <DialogDescription>
              {previewKind ? previewKindLabel(previewKind) : ""}
            </DialogDescription>
          </DialogHeader>
          {preview.kind === "loading" ? (
            <div className="flex h-48 items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
              <Spinner className="size-4" />
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
  variant = "card",
  className,
}: {
  taskId: string;
  attachments: TaskAttachment[] | undefined;
  /** `plain`: the rows only (the task page's details card names the list). */
  variant?: "card" | "plain";
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

  const list = (
    <ul className={cn("space-y-0.5", variant === "plain" && className)}>
      {rows.map((a) => (
        <li key={a.id}>
          <AttachmentRow
            attachment={a}
            onDownload={handleDownload}
            onDelete={handleDelete}
            deleting={remove.isPending && remove.variables === a.id}
            taskId={taskId}
          />
        </li>
      ))}
    </ul>
  );
  if (variant === "plain") return list;

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
      <div className="-mx-2 max-h-[34rem] overflow-auto">{list}</div>
    </CollapsibleSection>
  );
}

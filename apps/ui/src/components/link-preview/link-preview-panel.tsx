/**
 * The link preview panel: an agent-fs file or a swarm Page opened from a link
 * in task or session content (see `link-preview-state.tsx`). The page places
 * it inline in its own body (`link-preview-dock.tsx`), or it opens as a sheet
 * over the page. Preview only: no editing, comments, or folder navigation.
 */

import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ExternalLink, Globe, X } from "lucide-react";
import { lazy, type ReactNode, Suspense } from "react";
import { api } from "@/api/client";
import { useAgentFsStat } from "@/api/hooks/use-agent-fs";
import { usePage } from "@/api/hooks/use-pages";
import { FileKindIcon } from "@/components/comb/file-icon";
import { FileViewer } from "@/components/comb/viewers/file-viewer";
import { ViewerSkeleton } from "@/components/comb/viewers/viewer-skeleton";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOptionalAgentFs } from "@/contexts/agent-fs-context";
import { AgentFsError } from "@/lib/agent-fs/client";
import { formatBytes } from "@/lib/format-bytes";
import { type LinkPreviewTarget, linkPreviewOpenHref } from "@/lib/link-preview";
import { formatRelative } from "@/lib/relative-time";

const PAGE_ID_RE = /^[a-f0-9]{32}$/i;

// The page route module carries the frame and auth plumbing; load it on first use.
const PagePreviewBody = lazy(() =>
  import("@/pages/pages/[id]/page").then((m) => ({ default: m.PagePreviewBody })),
);

/** The panel for one target: the header, then the file or page body. */
export function LinkPreviewContent({
  target,
  onClose,
}: {
  target: LinkPreviewTarget;
  onClose: () => void;
}) {
  return target.kind === "file" ? (
    <FilePreview key={target.route} target={target} onClose={onClose} />
  ) : (
    <PagePreview key={`${target.id}${target.query}`} target={target} onClose={onClose} />
  );
}

/** The preview as a sheet over the page, where the page has no room for it inline. */
export function LinkPreviewSheet({
  target,
  onClose,
}: {
  target: LinkPreviewTarget;
  onClose: () => void;
}) {
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side="right"
        showCloseButton={false}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-full gap-0 p-0 pb-[env(safe-area-inset-bottom)] sm:max-w-[420px]"
      >
        <SheetTitle className="sr-only">Link preview</SheetTitle>
        <SheetDescription className="sr-only">
          A preview of the linked file or page.
        </SheetDescription>
        <LinkPreviewContent target={target} onClose={onClose} />
      </SheetContent>
    </Sheet>
  );
}

/** The panel frame: the header (kind, name, details, open and close), then the body. */
function PreviewFrame({
  icon,
  kind,
  title,
  detail,
  meta,
  openHref,
  onClose,
  children,
}: {
  icon: ReactNode;
  kind: string;
  title: string;
  detail?: string;
  meta?: string;
  openHref: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const subtitle = [detail, meta].filter(Boolean).join(" · ");
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="link-preview-panel">
      {/* One header row, as T3 Code's diff panel: icon, title, open, close.
          The path and size go on one muted line under it; the icon names the kind. */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span
          role="img"
          aria-label={kind}
          className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground" title={title}>
            {title}
          </p>
          {subtitle ? (
            <p className="truncate font-mono text-[11px] text-muted-foreground" title={subtitle}>
              {subtitle}
            </p>
          ) : null}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="ghost" size="icon" className="size-8">
              <a
                href={openHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open in new tab"
              >
                <ExternalLink className="size-4" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Open in new tab</TooltipContent>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onClose}
          aria-label="Close preview"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

/** A loading body, announced as T3 Code's diff panel does. */
function Loading({ children }: { children: ReactNode }) {
  return (
    // <output> carries the implicit `status` role.
    <output aria-live="polite" aria-label="Loading preview" className="block">
      {children}
    </output>
  );
}

function Unavailable({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="p-3">
      <AlertCallout tone="info" icon={AlertCircle} title={title} role="status">
        {children}
      </AlertCallout>
    </div>
  );
}

function FilePreview({
  target,
  onClose,
}: {
  target: Extract<LinkPreviewTarget, { kind: "file" }>;
  onClose: () => void;
}) {
  const agentFs = useOptionalAgentFs();
  const connected = agentFs?.state === "ready";
  const stat = useAgentFsStat(target.file);
  const notFound =
    (stat.error instanceof AgentFsError && stat.error.status === 404) ||
    (stat.data !== undefined && stat.data.currentVersion === undefined);
  const meta =
    stat.data && !notFound
      ? `${formatBytes(stat.data.size)} · updated ${formatRelative(stat.data.modifiedAt)}`
      : undefined;

  let body: ReactNode;
  if (!connected) {
    body = (
      <Unavailable title="Preview needs agent-fs">
        Connect agent-fs to preview this file here, or open it in a new tab.
      </Unavailable>
    );
  } else if (notFound) {
    body = <Unavailable title="File not found">It may have moved or been deleted.</Unavailable>;
  } else if (stat.error) {
    body = <Unavailable title="Could not open this file">{stat.error.message}</Unavailable>;
  } else if (stat.data) {
    body = <FileViewer file={target.file} stat={stat.data} />;
  } else {
    body = (
      <Loading>
        <ViewerSkeleton />
      </Loading>
    );
  }

  return (
    <PreviewFrame
      icon={<FileKindIcon name={target.name} isFolder={false} className="size-4" />}
      kind="agent-fs file"
      title={target.name}
      detail={target.file.path}
      meta={meta}
      openHref={linkPreviewOpenHref(target, { connected })}
      onClose={onClose}
    >
      {body}
    </PreviewFrame>
  );
}

function PagePreview({
  target,
  onClose,
}: {
  target: Extract<LinkPreviewTarget, { kind: "page" }>;
  onClose: () => void;
}) {
  // A link can name the page by slug; the bearer lookup and the body take the id.
  const bySlug = !PAGE_ID_RE.test(target.id);
  const resolved = useQuery({
    queryKey: ["page-resolve", target.id],
    queryFn: () => api.resolvePage(target.id),
    enabled: bySlug,
    retry: false,
  });
  const pageId = bySlug ? resolved.data?.id : target.id;
  const { data: page } = usePage(pageId);
  const meta = page
    ? [
        page.contentType === "application/json" ? "JSON" : "HTML",
        page.authMode,
        `updated ${formatRelative(page.updatedAt)}`,
      ].join(" · ")
    : undefined;

  let body: ReactNode;
  if (bySlug && resolved.isError) {
    body = <Unavailable title="Page not found">No page has the slug {target.id}.</Unavailable>;
  } else if (!pageId) {
    body = (
      <Loading>
        <Skeleton className="m-3 h-40" />
      </Loading>
    );
  } else {
    body = (
      <Suspense
        fallback={
          <Loading>
            <Skeleton className="m-3 h-40" />
          </Loading>
        }
      >
        <PagePreviewBody
          id={pageId}
          frameQuery={target.query}
          className="block h-full w-full border-0 bg-background"
        />
      </Suspense>
    );
  }

  return (
    <PreviewFrame
      icon={<Globe className="size-4" />}
      kind="Page"
      title={page?.title ?? (bySlug ? target.id : "Page")}
      detail={page?.slug ?? (bySlug ? target.id : undefined)}
      meta={meta}
      openHref={linkPreviewOpenHref(target, { pageId })}
      onClose={onClose}
    >
      {body}
    </PreviewFrame>
  );
}

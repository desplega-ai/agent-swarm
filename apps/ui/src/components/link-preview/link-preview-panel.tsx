/**
 * The link preview panel: an agent-fs file or a swarm Page opened from a link
 * in task or session content (see `link-preview-state.tsx`). It takes the
 * column of the "Session about this page" panel, one at a time, and behaves
 * the same way: docked
 * on the right from `xl` up, pushing the page aside, and a sheet over the
 * page below that. Preview only: no editing, comments, or folder navigation.
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
import { useContextPanel } from "@/components/context-panel/context-panel-state";
import { useMediaQuery } from "@/components/context-panel/context-session-panel";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOptionalAgentFs } from "@/contexts/agent-fs-context";
import { useCollapseNavWhile } from "@/hooks/use-collapse-nav-while";
import { AgentFsError } from "@/lib/agent-fs/client";
import { formatBytes } from "@/lib/format-bytes";
import { type LinkPreviewTarget, linkPreviewOpenHref } from "@/lib/link-preview";
import { formatRelative } from "@/lib/relative-time";

const DOCK_QUERY = "(min-width: 1280px)";
const WIDE_QUERY = "(min-width: 1440px)";
const PAGE_ID_RE = /^[a-f0-9]{32}$/i;

// The page route module carries the frame and auth plumbing; load it on first use.
const PagePreviewBody = lazy(() =>
  import("@/pages/pages/[id]/page").then((m) => ({ default: m.PagePreviewBody })),
);

export function LinkPreviewPanel() {
  const { preview: target, closePreview: close } = useContextPanel();
  const canDock = useMediaQuery(DOCK_QUERY);
  const isWide = useMediaQuery(WIDE_QUERY);
  const docked = !!target && canDock;
  useCollapseNavWhile(docked && !isWide);

  if (!target) return null;

  const panel =
    target.kind === "file" ? (
      <FilePreview key={target.route} target={target} onClose={close} />
    ) : (
      <PagePreview key={`${target.id}${target.query}`} target={target} onClose={close} />
    );

  if (canDock) {
    return (
      <aside
        aria-label="Link preview"
        className="flex h-svh w-[380px] shrink-0 flex-col border-l border-border 2xl:w-[420px]"
      >
        {panel}
      </aside>
    );
  }
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : close())}>
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
        {panel}
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
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="link-preview-panel">
      <div className="flex items-start gap-2 border-b border-border px-3 py-2">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            {kind}
          </p>
          <p className="truncate text-sm font-medium text-foreground" title={title}>
            {title}
          </p>
          {detail ? (
            <p className="truncate font-mono text-xs text-muted-foreground" title={detail}>
              {detail}
            </p>
          ) : null}
          {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
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
    body = <ViewerSkeleton />;
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
    body = <Skeleton className="m-3 h-40" />;
  } else {
    body = (
      <Suspense fallback={<Skeleton className="m-3 h-40" />}>
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

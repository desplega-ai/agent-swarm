import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useRef } from "react";
import { api } from "@/api/client";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Lazy: the page route imports the JSON page renderer, which imports this catalog.
const PagePreviewBody = lazy(() =>
  import("@/pages/pages/[id]/page").then((m) => ({ default: m.PagePreviewBody })),
);

/** Same shape the page route accepts as an id (slugs are not resolved here). */
export const PAGE_FRAME_ID = /^[a-f0-9]{32}$/i;
/** Width of the `device: "mobile"` frame, a common phone viewport. */
export const PAGE_FRAME_MOBILE_WIDTH = 390;
// shortcut: polls the whole page row (body included) every 3 s, upgrade to a page change stream once one exists.
export const PAGE_FRAME_POLL_MS = 3000;

export type PageFrameProps = {
  pageId: string;
  device?: "desktop" | "mobile";
  height?: string;
  fill?: boolean;
};

/**
 * A live swarm Page inside an app: the same page body `/pages/<id>` shows (a
 * sandboxed iframe of the HTML page, or the JSON renderer), reloaded whenever
 * the page's `updatedAt` moves.
 */
export function PageFrameComponent({ props }: { props: PageFrameProps }) {
  const pageId = typeof props.pageId === "string" ? props.pageId.trim() : "";
  const valid = PAGE_FRAME_ID.test(pageId);
  const fill = props.fill === true;
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ["page-frame", pageId],
    queryFn: () => api.getPage(pageId),
    enabled: valid,
    refetchInterval: PAGE_FRAME_POLL_MS,
    retry: false,
  });
  const revision = data?.updatedAt;

  // The body reads the page metadata query, cached forever: refetch it on each
  // new revision so a JSON page (rendered from that body) and a changed auth
  // mode follow too. The first revision is the load, not a change.
  const seenRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!revision) return;
    const previous = seenRef.current;
    seenRef.current = revision;
    if (previous && previous !== revision) {
      void queryClient.invalidateQueries({ queryKey: ["page-metadata", pageId] });
    }
  }, [revision, pageId, queryClient]);

  let body: ReactNode;
  if (!pageId) body = <EmptyState compact icon={Globe} title="No page selected" />;
  else if (!valid) body = <EmptyState compact icon={Globe} title="Not a page id" />;
  // A failed poll keeps the last good frame; only a first load that fails shows the error.
  else if (!revision && error) {
    body = <EmptyState compact icon={Globe} title="This page could not be loaded" />;
  } else if (!revision) body = <Skeleton className="h-full min-h-40 w-full" />;
  else {
    body = (
      <Suspense fallback={<Skeleton className="h-full min-h-40 w-full" />}>
        <PagePreviewBody
          id={pageId}
          frameQuery=""
          revision={revision}
          className="block h-full w-full border-0 bg-background"
        />
      </Suspense>
    );
  }

  const mobile = props.device === "mobile";
  return (
    <div
      className={cn("flex min-w-0 justify-center", fill ? "h-full min-h-0" : "h-[640px]")}
      style={props.height && !fill ? { height: props.height } : undefined}
      data-testid="json-render-page-frame"
    >
      <div
        className={cn(
          "h-full min-w-0 overflow-auto rounded-lg border border-border bg-background",
          // `box-content`: the page itself gets the full 390 px inside the border.
          mobile ? "box-content max-w-full" : "w-full",
        )}
        style={mobile ? { width: PAGE_FRAME_MOBILE_WIDTH } : undefined}
        data-device={mobile ? "mobile" : "desktop"}
      >
        {body}
      </div>
    </div>
  );
}

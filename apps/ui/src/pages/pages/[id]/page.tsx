/**
 * Page renderer for DB-backed pages (the "pages" feature — see
 * `thoughts/taras/plans/2026-05-12-db-backed-pages/`). Mounted at
 * `/pages/:id`.
 *
 * Step-6 scope:
 *   - Fetches `${apiUrl}/p/:id.json` to learn the page's `contentType` and
 *     `authMode` (cookie-bearing, so authed-mode pages succeed after launch).
 *   - For `text/html`:
 *     - public  → renders an absolute-URL `<iframe>` straight to `/p/:id`.
 *     - authed  → POSTs `/api/pages/:id/launch` first (mints the
 *                 `page_session_<id>` cookie) then renders the iframe.
 *     - password → renders a password input. On submit, sets the iframe
 *                  `src` to `/p/:id?key=<password>` — the page route itself
 *                  validates and mints the cookie on load.
 *   - For `application/json`: stubs a "JSON renderer coming in step-7"
 *     placeholder so the route doesn't crash.
 *
 * Dev-mode cross-origin caveat: when the SPA is on `localhost:5274` and the
 * API is on `localhost:3013`, the `page_session_<id>` cookie is issued with
 * `SameSite=Lax` (per `src/utils/page-session.ts` dev branch) which the
 * browser may NOT send on cross-site iframe requests. Production paths share
 * a parent domain so cookies flow naturally. Documented in step-6's manual
 * verification checklist.
 */

import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Braces,
  Database,
  ExternalLink,
  FileDown,
  Lock,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
} from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { useFavoriteToggle } from "@/api/hooks/use-favorites";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { usePage } from "@/api/hooks/use-pages";
import type { PageListItem, PageMetadata } from "@/api/types";
import { UpgradeRequired } from "@/components/feature-gate/upgrade-required";
import { FavoriteButton } from "@/components/shared/favorite-button";
import { VersionUpdateNotice } from "@/components/shared/version-update-notice";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocalToggle } from "@/hooks/use-local-toggle";
import { useTheme } from "@/hooks/use-theme";
import { useVersionedValue } from "@/hooks/use-versioned-value";
import { getConfig } from "@/lib/config";
import { getPageContext } from "@/lib/page-context";
import { DEFAULT_THEME_ID } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { usePageFeedbackBridge } from "./feedback-bridge";
import { FeedbackConfirmDialog } from "./feedback-confirm-dialog";
import { JsonPageRenderer } from "./json-page-renderer";
import { RoomInspectorDialog } from "./room-inspector";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the absolute API base URL — duplicates `ApiClient.getAbsoluteApiUrl`
 * to keep the helpers reachable from the iframe render path (which doesn't
 * go through `api.fetchX`).
 */
function getAbsoluteApiUrl(): string {
  const config = getConfig();
  return (config.apiUrl || "http://localhost:3013").replace(/\/+$/, "");
}

const MISSING_PAGE_SESSION_ERROR =
  "authed mode requires page-session cookie; POST /api/pages/:id/launch first";
const PAGE_ID_RE = /^[a-f0-9]{32}$/i;

function getPageHtmlUrl(id: string): string {
  return `${getAbsoluteApiUrl()}/p/${encodeURIComponent(id)}`;
}

/**
 * Query params that give a design version 2 page the viewer's theme preset
 * and color mode. The API reads them on `/p/:id` under the same constant
 * names (`src/pages/page-head.ts`). Version 1 pages ignore them.
 */
const PAGE_THEME_PARAM = "__swarm-theme";
const PAGE_MODE_PARAM = "__swarm-mode";

/**
 * Query params the SPA owns on `/pages/:id` and must never forward to the
 * page body: `mode` (full-screen toggle), `key` (password unlock is handled
 * by the password frame itself), the connection overrides, which would
 * otherwise hand the API key to agent-authored HTML, and the viewer theme
 * params, which only `withViewerTheme` sets (from the dashboard theme).
 */
const SPA_RESERVED_PAGE_PARAMS = new Set([
  "mode",
  "key",
  "apiUrl",
  "apiKey",
  PAGE_THEME_PARAM,
  PAGE_MODE_PARAM,
]);

/**
 * Query string forwarded from the SPA route to the page body, so a link like
 * `/pages/<id>?target=pr-1373` reaches the iframe as `/p/<id>?target=pr-1373`
 * and the page can filter or deep-link on its own params. Empty when there is
 * nothing to forward.
 */
function pageFrameQuery(searchParams: URLSearchParams): string {
  const forwarded = new URLSearchParams();
  for (const [name, value] of searchParams) {
    if (!SPA_RESERVED_PAGE_PARAMS.has(name)) forwarded.append(name, value);
  }
  const query = forwarded.toString();
  return query ? `?${query}` : "";
}

/**
 * `frameQuery` plus the viewer's theme, for the URLs that load the page body:
 * the iframe src and the "Open" link. Hive and light mode are the page
 * defaults, so they add no param. The "Full" route renders the frame itself,
 * so it does not take this query. "Export PDF" takes the preset only (it
 * passes light), because print is always light.
 */
function withViewerTheme(
  frameQuery: string,
  viewer: { preset: string; theme: "dark" | "light" },
): string {
  const params = new URLSearchParams(frameQuery);
  if (viewer.preset !== DEFAULT_THEME_ID) params.set(PAGE_THEME_PARAM, viewer.preset);
  if (viewer.theme === "dark") params.set(PAGE_MODE_PARAM, "dark");
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * Query param that turns on the in-page feedback overlay (served by the API
 * on `/p/:id`, see `src/pages/feedback-overlay.ts`). It is a normal
 * forwarded param, so the iframe, "Open" and "Full" links all carry it.
 */
const FEEDBACK_PARAM = "__swarm-feedback";

/** Mirrors `isPageFeedbackRequested` on the API: present and not `0` / `false`. */
function isFeedbackOn(searchParams: URLSearchParams): boolean {
  const value = searchParams.get(FEEDBACK_PARAM);
  return value !== null && value.toLowerCase() !== "0" && value.toLowerCase() !== "false";
}

/** Compare page content while ignoring view counts and viewer-specific metadata. */
function pageContentRevision(page: PageListItem): string {
  const ignored = new Set([
    "viewCount",
    "favorite",
    "updatedAt",
    "createdAt",
    "api_url",
    "app_url",
  ]);
  return JSON.stringify(Object.entries(page).filter(([key]) => !ignored.has(key)));
}

/** SPA route for the page, keeping the forwarded params and toggling `mode=full`. */
function pageRoute(id: string, frameQuery: string, full: boolean): string {
  const params = new URLSearchParams(frameQuery);
  if (full) params.set("mode", "full");
  const query = params.toString();
  return `/pages/${id}${query ? `?${query}` : ""}`;
}

/**
 * Fetch the page metadata. For authed pages, the first call typically 401s —
 * we then attempt `launchPage` (which uses the bearer to mint a cookie) and
 * retry. Password pages can't be launched via the bearer endpoint, so we
 * surface them via the `authMode === 'password'` branch which renders the
 * unlock form instead (the metadata fetch is bypassed for password pages on
 * the first attempt — we instead synthesize a minimal metadata stub).
 */
function passwordStub(id: string): PageMetadata {
  return {
    id,
    version: 0,
    title: "Password-protected page",
    description: null,
    contentType: "text/html",
    authMode: "password",
    body: "",
  };
}

async function fetchPageMetadataWithLaunchRetry(id: string): Promise<PageMetadata> {
  try {
    return await api.fetchPageMetadata(id);
  } catch (e) {
    const err = e as Error & { status?: number; bodyText?: string };
    const status = err.status;
    // Server hints "password required" on 401 — short-circuit straight to
    // the password-form stub without making an extra `/launch` round-trip
    // (which always 400s for password mode and can stall on slow networks
    // or strict CORS preflights).
    if (status === 401 && err.bodyText?.includes("password required")) {
      return passwordStub(id);
    }
    // 401 (no cookie) or 403 (cookie scoped to a different page) → try
    // launch + retry. Anything else → surface to the caller.
    if (status !== 401 && status !== 403) throw e;
  }
  try {
    await api.launchPage(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Password pages reject the bearer-launch path with 400; fall back to
    // the password stub so the unlock form renders.
    if (msg.includes(": 400")) return passwordStub(id);
    throw e;
  }
  return api.fetchPageMetadata(id);
}

// ─── Frames ─────────────────────────────────────────────────────────────────

interface FrameProps {
  id: string;
  title: string;
  /**
   * `?a=b` string for the page body URL: the forwarded params plus the viewer
   * theme (see `pageFrameQuery` and `withViewerTheme`), or "".
   */
  frameQuery: string;
  iframeRef?: React.RefObject<HTMLIFrameElement | null>;
  revision?: string;
}

function PageIframe({
  src,
  title,
  iframeRef,
  revision,
}: {
  src: string;
  title: string;
  iframeRef?: React.RefObject<HTMLIFrameElement | null>;
  revision?: string;
}) {
  const frameUrl = new URL(src);
  if (revision) frameUrl.searchParams.set("__swarm_revision", revision);
  return (
    <iframe
      // A new src (a theme or mode switch, a param change) mounts a new
      // frame. Changing the src of a loaded frame would add a browser
      // history entry, so Back would step through old frame URLs.
      key={`${src}:${revision ?? ""}`}
      ref={iframeRef}
      src={frameUrl.toString()}
      title={title}
      // `allow-same-origin` is required for the Browser SDK (`window.swarm`)
      // to function — it makes XHR/fetch calls to `/@swarm/api/*` from
      // within the iframe, which need the page-session cookie. `allow-forms`
      // lets agent-emitted forms POST. We deliberately do NOT include
      // `allow-top-navigation` to prevent runaway-redirect attacks.
      sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
      className={cn(
        "w-full h-[calc(100vh-6rem)] rounded-md border border-border bg-background",
        // Below md the frame bleeds through `<main>`'s gutter to the screen
        // edges, so a phone gives the page its full width.
        "max-md:-mx-4 max-md:w-[calc(100%+2rem)] max-md:max-w-none max-md:rounded-none max-md:border-x-0",
      )}
    />
  );
}

function PublicHtmlFrame({ id, title, frameQuery, iframeRef, revision }: FrameProps) {
  const src = getPageHtmlUrl(id) + frameQuery;
  return <PageIframe src={src} title={title} iframeRef={iframeRef} revision={revision} />;
}

async function assertAuthedPageBodyReady(
  id: string,
  signal: AbortSignal,
): Promise<"ready" | "missing-session"> {
  const res = await fetch(getPageHtmlUrl(id), {
    credentials: "include",
    signal,
  });

  if (res.ok) return "ready";

  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    /* ignore */
  }

  if (res.status === 401 && bodyText.includes(MISSING_PAGE_SESSION_ERROR)) {
    return "missing-session";
  }

  throw new Error(`page body ${id}: ${res.status}`);
}

function AuthedHtmlFrame({ id, title, frameQuery, iframeRef, revision }: FrameProps) {
  const [frameState, setFrameState] = useState<
    { status: "loading" } | { status: "ready"; src: string } | { status: "error"; message: string }
  >({ status: "loading" });

  // Reissue the page session when the accepted revision reloads the iframe.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision intentionally restarts the session
  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function prepareFrame() {
      setFrameState({ status: "loading" });

      try {
        await api.launchPage(id);
        let bodyStatus = await assertAuthedPageBodyReady(id, controller.signal);

        if (bodyStatus === "missing-session") {
          await api.launchPage(id);
          bodyStatus = await assertAuthedPageBodyReady(id, controller.signal);
        }

        if (!active) return;

        if (bodyStatus === "ready") {
          setFrameState({ status: "ready", src: getPageHtmlUrl(id) + frameQuery });
          return;
        }

        setFrameState({
          status: "error",
          message: "The authenticated page could not be prepared. Try refreshing the page.",
        });
      } catch (e) {
        if (!active || (e instanceof DOMException && e.name === "AbortError")) return;
        const message = e instanceof Error ? e.message : String(e);
        setFrameState({
          status: "error",
          message: `The authenticated page could not be prepared (${message}).`,
        });
      }
    }

    void prepareFrame();

    return () => {
      active = false;
      controller.abort();
    };
  }, [id, frameQuery, revision]);

  if (frameState.status === "loading") {
    return <Skeleton className="h-[calc(100vh-6rem)] w-full rounded-md" />;
  }

  if (frameState.status === "error") {
    return <ArtifactPageError message={frameState.message} />;
  }

  return (
    <PageIframe src={frameState.src} title={title} iframeRef={iframeRef} revision={revision} />
  );
}

function PasswordHtmlFrame({ id, title, frameQuery, iframeRef, revision }: FrameProps) {
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);

  // The src comes from the current `frameQuery` on each render, so a theme or
  // mode switch reloads the unlocked frame too. The form is gone after the
  // submit, so `password` keeps the submitted key.
  if (unlocked) {
    const params = new URLSearchParams(frameQuery);
    params.set("key", password);
    return (
      <PageIframe
        src={`${getPageHtmlUrl(id)}?${params.toString()}`}
        title={title}
        iframeRef={iframeRef}
        revision={revision}
      />
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setUnlocked(true);
  }

  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="h-4 w-4" />
          Password required
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="page-password">Password</Label>
            <Input
              id="page-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </div>
          <Button type="submit" className="w-full">
            Unlock
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// JSON pages render through `@json-render/react` via the `JsonPageRenderer`
// component imported from `./json-page-renderer`. The catalog + action
// handlers live there (kept separate so the artifact page itself stays
// focused on the iframe / auth-mode plumbing).

// ─── Loading / error ────────────────────────────────────────────────────────

function ArtifactPageSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-[calc(100vh-12rem)] w-full" />
    </div>
  );
}

function ArtifactPageError({ message }: { message: string }) {
  return (
    <AlertCallout tone="error" icon={AlertCircle} title="Failed to load artifact">
      <p>{message}</p>
    </AlertCallout>
  );
}

// ─── Route entry ────────────────────────────────────────────────────────────

export default function ArtifactPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const viewer = useTheme();
  const fullMode = searchParams.get("mode") === "full";
  const frameQuery = pageFrameQuery(searchParams);
  // The page body URLs (the frames, "Open") follow the dashboard theme. A
  // theme or mode switch changes this string, which reloads the frame.
  const themedFrameQuery = withViewerTheme(frameQuery, viewer);
  const feedbackOn = isFeedbackOn(searchParams);
  const toggleFeedback = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (isFeedbackOn(prev)) next.delete(FEEDBACK_PARAM);
        else next.set(FEEDBACK_PARAM, "1");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);
  const gate = useFeatureGate("1.79.0");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const needsSlugResolve = !!id && !PAGE_ID_RE.test(id);
  const {
    data: resolvedPage,
    error: resolveError,
    isLoading: isResolving,
  } = useQuery({
    queryKey: ["page-resolve", id],
    queryFn: () => api.resolvePage(id ?? ""),
    enabled: needsSlugResolve,
    retry: false,
  });
  const pageId = needsSlugResolve ? resolvedPage?.id : id;
  const { pathname } = useLocation();
  const feedbackBridge = usePageFeedbackBridge({
    pageId,
    pageKey: getPageContext({ pathname })?.pageKey,
    enabled: feedbackOn,
    apiOrigin: new URL(getAbsoluteApiUrl()).origin,
    iframeRef,
  });
  const { data: pageRow } = usePage(pageId);
  const [autoReload] = useLocalToggle("entity-auto-reload", false);
  const pageRevision = useMemo(() => pageRow && pageContentRevision(pageRow), [pageRow]);
  const pageVersion = useVersionedValue(pageId, pageRow, pageRevision, autoReload);
  const displayedRevision = useMemo(
    () => pageVersion.value && pageContentRevision(pageVersion.value),
    [pageVersion.value],
  );
  const [frameRevision, setFrameRevision] = useState(0);
  const [frameInstance] = useState(() => String(Date.now()));
  const favoriteToggle = useFavoriteToggle("page");

  const {
    data,
    error,
    isLoading,
    refetch: refetchMetadata,
  } = useQuery({
    queryKey: ["page-metadata", pageId],
    queryFn: () => fetchPageMetadataWithLaunchRetry(pageId ?? ""),
    enabled: !!pageId,
    // The metadata is the page's current head; we DON'T want to silently
    // refetch + re-render the iframe while the user is interacting with it
    // (and for password mode this would re-trigger the unlock flow).
    staleTime: Infinity,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  const reloadFrame = useCallback(async () => {
    const result = await refetchMetadata();
    if (!result.isError) setFrameRevision((version) => version + 1);
  }, [refetchMetadata]);
  const lastRevision = useRef<{ id: string; revision: string } | null>(null);
  useEffect(() => {
    if (!pageId || !displayedRevision) return;
    const previous = lastRevision.current;
    lastRevision.current = { id: pageId, revision: displayedRevision };
    if (previous?.id === pageId && previous.revision !== displayedRevision) {
      void reloadFrame();
    }
  }, [pageId, displayedRevision, reloadFrame]);

  // Open the page in a new tab with `?print=1` so it self-prints in the
  // user's own browser. The agent-authored HTML (or formatted JSON) prints —
  // not the SPA chrome — and no server-side headless browser is involved. The
  // server appends an auto-print snippet to the `?print=1` response, and the
  // page-session cookie (minted during the metadata fetch) rides along on the
  // top-level navigation so authed/password pages still resolve. Triggered
  // synchronously from the click so the pop-up isn't blocked. The PDF keeps
  // the viewer's preset but never the dark mode: print is always light.
  const handleExportPdf = useCallback(() => {
    if (!pageId) return;
    const query = withViewerTheme("?print=1", { preset: viewer.preset, theme: "light" });
    window.open(`${getPageHtmlUrl(pageId)}${query}`, "_blank", "noopener,noreferrer");
  }, [pageId, viewer.preset]);

  if (!gate.supported) {
    return (
      <UpgradeRequired
        feature="Pages"
        requiredVersion={gate.requiredVersion}
        currentVersion={gate.currentVersion}
      />
    );
  }
  if (!id) {
    return <ArtifactPageError message="Missing artifact id in URL." />;
  }
  if (isResolving) return <ArtifactPageSkeleton />;
  if (resolveError || (needsSlugResolve && !pageId)) {
    const msg = resolveError instanceof Error ? resolveError.message : "Page slug not found";
    return <ArtifactPageError message={msg} />;
  }
  if (isLoading) return <ArtifactPageSkeleton />;
  if (!data) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return <ArtifactPageError message={msg} />;
  }

  let body: React.ReactNode;
  if (data.contentType === "application/json") {
    body = (
      <div className="rounded-md border border-border bg-background p-4 md:p-6 min-h-[200px]">
        <div className="mb-4 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          <Braces className="size-3" />
          <span>JSON-rendered page</span>
        </div>
        <JsonPageRenderer body={data.body} />
      </div>
    );
  } else {
    switch (data.authMode) {
      case "public":
        body = (
          <PublicHtmlFrame
            id={pageId!}
            title={data.title}
            frameQuery={themedFrameQuery}
            iframeRef={iframeRef}
            revision={`${frameInstance}-${frameRevision}`}
          />
        );
        break;
      case "authed":
        body = (
          <AuthedHtmlFrame
            id={pageId!}
            title={data.title}
            frameQuery={themedFrameQuery}
            iframeRef={iframeRef}
            revision={`${frameInstance}-${frameRevision}`}
          />
        );
        break;
      case "password":
        body = (
          <PasswordHtmlFrame
            id={pageId!}
            title={data.title}
            frameQuery={themedFrameQuery}
            iframeRef={iframeRef}
            revision={`${frameInstance}-${frameRevision}`}
          />
        );
        break;
    }
  }

  if (fullMode) {
    // Maximize: render the page body as a fixed-position overlay on top of
    // the normal SPA chrome. Slim header row (title left, exit button right)
    // sits above the body, not overlapping — so iframe / JSON content gets
    // the full remaining viewport.
    return (
      <div ref={pageVersion.scopeRef} className="fixed inset-0 z-50 flex flex-col bg-background">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate text-sm font-medium">{data.title}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{data.authMode}</span>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to={pageRoute(pageId!, frameQuery, false)}>
              <Minimize2 className="size-3.5" />
              Exit full
            </Link>
          </Button>
        </div>
        {error && data && (
          <AlertCallout
            tone="error"
            action={
              <Button size="sm" variant="outline" onClick={() => void reloadFrame()}>
                Retry
              </Button>
            }
          >
            Could not load the new page version.
          </AlertCallout>
        )}
        {pageVersion.pending && <VersionUpdateNotice onApply={pageVersion.apply} />}
        <div className="flex-1 min-h-0 overflow-auto p-4">{body}</div>
        <FeedbackConfirmDialog bridge={feedbackBridge} />
      </div>
    );
  }

  return (
    <div ref={pageVersion.scopeRef} className="flex flex-1 flex-col min-h-0 gap-4">
      <PageHeader
        // One row at every width: the summary truncates, the icon actions
        // keep their size.
        title={data.title}
        description={
          <PageHeaderSummary description={data.description} slug={pageRow?.slug ?? null} />
        }
        action={
          <PageHeaderActions
            id={pageId!}
            frameQuery={frameQuery}
            themedFrameQuery={themedFrameQuery}
            authMode={data.authMode}
            favorite={pageRow?.favorite}
            favoriteDisabled={favoriteToggle.isPending}
            onToggleFavorite={() =>
              favoriteToggle.mutate({ itemId: pageId!, favorite: !pageRow?.favorite })
            }
            onExportPdf={handleExportPdf}
            feedback={
              // HTML only (JSON pages render in the SPA). Not offered for
              // password pages yet, though their unlocked frame follows the
              // frame query, so the toggle would reach it.
              data.contentType === "text/html" && data.authMode !== "password"
                ? { on: feedbackOn, onToggle: toggleFeedback }
                : undefined
            }
          />
        }
      />
      {body}
      <FeedbackConfirmDialog bridge={feedbackBridge} />
    </div>
  );
}

// ─── Header extras ─────────────────────────────────────────────────────────

/**
 * The header's one-line summary: the description, then the slug in muted
 * mono. Both truncate; the tooltip carries the full text. The slug comes from
 * the bearer-authed `/api/pages/:id` lookup (the public `/p/:id.json` doesn't
 * expose it, it's a creator-side concept), so it appears once that loads.
 * Below sm the slug only shows in the tooltip, to leave the row to the
 * description.
 */
function PageHeaderSummary({
  description,
  slug,
}: {
  description: string | null;
  slug: string | null;
}) {
  if (!description && !slug) return null;
  return (
    // Not hoverable: the pointer leaving the wide summary for an action icon
    // closes it at once, so the icon's own tooltip can open.
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>
        <span className="flex min-w-0 items-baseline gap-2">
          {description ? <span className="min-w-0 truncate">{description}</span> : null}
          {slug ? (
            <span
              className={cn(
                "min-w-0 truncate font-mono text-xs text-muted-foreground/70",
                // With a description the slug yields first and hides on phones.
                description && "max-w-[40%] shrink-[2] max-sm:hidden",
              )}
            >
              {slug}
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent align="start" className="max-w-md text-pretty">
        {description ? <p>{description}</p> : null}
        {slug ? <p className="font-mono opacity-80">slug: {slug}</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** Icon-only header action: its label is both the tooltip and the accessible name. */
function HeaderIconButton({
  label,
  tooltip,
  className,
  ...props
}: ComponentProps<typeof Button> & { label: string; tooltip?: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          className={cn("h-7 w-7", className)}
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The header's icon actions. "Open" pops `/p/:id` (the canonical API-served
 * URL) in a new tab. For password mode, opening the link triggers the
 * browser's native Basic-auth dialog; for authed mode it 401s unless the
 * page-session cookie still applies (works fine when the SPA is at the same
 * origin as the API; in cross-origin dev the cookie may not flow).
 */
function PageHeaderActions({
  id,
  frameQuery,
  themedFrameQuery,
  authMode,
  favorite,
  favoriteDisabled,
  onToggleFavorite,
  onExportPdf,
  feedback,
}: {
  id: string;
  /** Forwarded page params, for the "Full" route. */
  frameQuery: string;
  /** `frameQuery` plus the viewer theme, for the "Open" link. */
  themedFrameQuery: string;
  authMode: PageMetadata["authMode"];
  favorite?: boolean;
  favoriteDisabled?: boolean;
  onToggleFavorite: () => void;
  onExportPdf: () => void;
  /** Feedback-overlay toggle; omitted when the page cannot take feedback. */
  feedback?: { on: boolean; onToggle: () => void };
}) {
  const [roomOpen, setRoomOpen] = useState(false);
  // The share link carries the same query as the iframe, so "Open" keeps
  // whatever filter, theme and mode the page is showing.
  const href = getPageHtmlUrl(id) + themedFrameQuery;
  return (
    <div className="flex items-center gap-0.5">
      <FavoriteButton favorite={favorite} disabled={favoriteDisabled} onToggle={onToggleFavorite} />
      {feedback ? (
        <HeaderIconButton
          label="Feedback"
          tooltip="Feedback: select elements on the page, comment on them, and send the comments to the swarm"
          variant={feedback.on ? "default" : "ghost"}
          aria-pressed={feedback.on}
          onClick={feedback.onToggle}
        >
          <MessageSquarePlus className="size-4" />
        </HeaderIconButton>
      ) : null}
      <HeaderIconButton
        asChild
        label="Open"
        tooltip={
          authMode === "password"
            ? "Open in a new tab (password required)"
            : "Open the API-served URL in a new tab"
        }
      >
        <a href={href} target="_blank" rel="noreferrer">
          <ExternalLink className="size-4" />
        </a>
      </HeaderIconButton>
      <HeaderIconButton label="Export PDF" onClick={onExportPdf}>
        <FileDown className="size-4" />
      </HeaderIconButton>
      <HeaderIconButton label="Saved room state" onClick={() => setRoomOpen(true)}>
        <Database className="size-4" />
      </HeaderIconButton>
      <HeaderIconButton asChild label="Full screen">
        <Link to={pageRoute(id, frameQuery, true)}>
          <Maximize2 className="size-4" />
        </Link>
      </HeaderIconButton>
      <RoomInspectorDialog key={id} pageId={id} open={roomOpen} onOpenChange={setRoomOpen} />
    </div>
  );
}

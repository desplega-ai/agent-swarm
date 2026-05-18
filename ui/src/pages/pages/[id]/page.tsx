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
 *                 `page_session` cookie) then renders the iframe.
 *     - password → renders a password input. On submit, sets the iframe
 *                  `src` to `/p/:id?key=<password>` — the page route itself
 *                  validates and mints the cookie on load.
 *   - For `application/json`: stubs a "JSON renderer coming in step-7"
 *     placeholder so the route doesn't crash.
 *
 * Dev-mode cross-origin caveat: when the SPA is on `localhost:5274` and the
 * API is on `localhost:3013`, the `page_session` cookie is issued with
 * `SameSite=Lax` (per `src/utils/page-session.ts` dev branch) which the
 * browser may NOT send on cross-site iframe requests. Production paths share
 * a parent domain so cookies flow naturally. Documented in step-6's manual
 * verification checklist.
 */

import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Braces,
  ExternalLink,
  Lock,
  Maximize2,
  Minimize2,
  Printer,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { usePage } from "@/api/hooks/use-pages";
import type { PageMetadata } from "@/api/types";
import { UpgradeRequired } from "@/components/feature-gate/upgrade-required";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getConfig } from "@/lib/config";
import { JsonPageRenderer } from "./json-page-renderer";

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
  iframeRef?: React.RefObject<HTMLIFrameElement | null>;
}

function PageIframe({
  src,
  title,
  iframeRef,
}: {
  src: string;
  title: string;
  iframeRef?: React.RefObject<HTMLIFrameElement | null>;
}) {
  return (
    <iframe
      ref={iframeRef}
      src={src}
      title={title}
      // `allow-same-origin` is required for the Browser SDK (`window.swarm`)
      // to function — it makes XHR/fetch calls to `/@swarm/api/*` from
      // within the iframe, which need the page-session cookie. `allow-forms`
      // lets agent-emitted forms POST. We deliberately do NOT include
      // `allow-top-navigation` to prevent runaway-redirect attacks.
      sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
      className="w-full h-[calc(100vh-6rem)] rounded-md border border-border bg-background"
    />
  );
}

function PublicHtmlFrame({ id, title, iframeRef }: FrameProps) {
  const src = `${getAbsoluteApiUrl()}/p/${encodeURIComponent(id)}`;
  return <PageIframe src={src} title={title} iframeRef={iframeRef} />;
}

function AuthedHtmlFrame({ id, title, iframeRef }: FrameProps) {
  // We've already launched once via `fetchPageMetadataWithLaunchRetry`'s
  // 401 → launch → retry path; the cookie is set. Just render the iframe.
  // (If the cookie was rejected by SameSite policy in dev, the iframe's
  // /p/:id request will 401 inside the frame — the user sees the swarm's
  // 401 error JSON, which is the same UX as a server-side denial.)
  const src = `${getAbsoluteApiUrl()}/p/${encodeURIComponent(id)}`;
  return <PageIframe src={src} title={title} iframeRef={iframeRef} />;
}

function PasswordHtmlFrame({ id, title, iframeRef }: FrameProps) {
  const [password, setPassword] = useState("");
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);

  if (iframeSrc) {
    return <PageIframe src={iframeSrc} title={title} iframeRef={iframeRef} />;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const url = `${getAbsoluteApiUrl()}/p/${encodeURIComponent(id)}?key=${encodeURIComponent(
      password,
    )}`;
    setIframeSrc(url);
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
  const [searchParams] = useSearchParams();
  const fullMode = searchParams.get("mode") === "full";
  const gate = useFeatureGate("1.79.0");
  // Iframe ref used by the "Export PDF" button to trigger the iframe's own
  // `window.print()` — so the agent-authored content prints (not the SPA
  // chrome). For JSON pages (no iframe) we fall back to `window.print()` on
  // the SPA itself; JSON pages render their body in the SPA DOM, so this
  // captures the JSON tree natively.
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const { data, error, isLoading } = useQuery({
    queryKey: ["page-metadata", id],
    queryFn: () => fetchPageMetadataWithLaunchRetry(id ?? ""),
    enabled: !!id,
    // The metadata is the page's current head; we DON'T want to silently
    // refetch + re-render the iframe while the user is interacting with it
    // (and for password mode this would re-trigger the unlock flow).
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  const isJson = data?.contentType === "application/json";

  const handleExportPdf = useCallback(() => {
    if (isJson) {
      // SPA-rendered content prints directly.
      window.print();
      return;
    }
    const win = iframeRef.current?.contentWindow;
    if (win) {
      try {
        win.focus();
        win.print();
      } catch {
        // Cross-origin or sandbox restriction — fall back to the SPA's
        // own print dialog so the user still has SOME way to export.
        window.print();
      }
    } else {
      window.print();
    }
  }, [isJson]);

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
  if (isLoading) return <ArtifactPageSkeleton />;
  if (error || !data) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return <ArtifactPageError message={msg} />;
  }

  let body: React.ReactNode;
  if (data.contentType === "application/json") {
    body = (
      <div className="rounded-md border border-border bg-background p-6 min-h-[200px]">
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
        body = <PublicHtmlFrame id={id} title={data.title} iframeRef={iframeRef} />;
        break;
      case "authed":
        body = <AuthedHtmlFrame id={id} title={data.title} iframeRef={iframeRef} />;
        break;
      case "password":
        body = <PasswordHtmlFrame id={id} title={data.title} iframeRef={iframeRef} />;
        break;
    }
  }

  if (fullMode) {
    // Maximize: render the page body as a fixed-position overlay on top of
    // the normal SPA chrome. Slim header row (title left, exit button right)
    // sits above the body, not overlapping — so iframe / JSON content gets
    // the full remaining viewport.
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate text-sm font-medium">{data.title}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{data.authMode}</span>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to={`/pages/${id}`}>
              <Minimize2 className="size-3.5" />
              Exit full
            </Link>
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-4">{body}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 gap-4">
      <PageHeader
        title={data.title}
        description={data.description ?? undefined}
        action={
          <PageHeaderActions id={id} authMode={data.authMode} onExportPdf={handleExportPdf} />
        }
      />
      <PageSlugLine id={id} />
      {body}
    </div>
  );
}

// ─── Header extras ─────────────────────────────────────────────────────────

/**
 * Slug line shown right under the title. We pull the slug from the
 * bearer-authed `/api/pages/:id` lookup (the public `/p/:id.json` doesn't
 * expose slug — it's a creator-side concept). Renders nothing if the lookup
 * hasn't loaded yet.
 */
function PageSlugLine({ id }: { id: string }) {
  const { data } = usePage(id);
  if (!data?.slug) return null;
  return (
    <p className="font-mono text-xs text-muted-foreground -mt-2">
      slug: <span className="text-foreground/70">{data.slug}</span>
    </p>
  );
}

/**
 * "Open external" link that pops `/p/:id` (the canonical API-served URL) in
 * a new tab. For password mode, opening the link triggers the browser's
 * native Basic-auth dialog; for authed mode it 401s unless the page-session
 * cookie still applies (works fine when the SPA is at the same origin as
 * the API; in cross-origin dev the cookie may not flow).
 */
function PageHeaderActions({
  id,
  authMode,
  onExportPdf,
}: {
  id: string;
  authMode: PageMetadata["authMode"];
  onExportPdf: () => void;
}) {
  const config = getConfig();
  const apiUrl = (config.apiUrl || "http://localhost:3013").replace(/\/+$/, "");
  const href = `${apiUrl}/p/${encodeURIComponent(id)}`;
  return (
    <div className="flex items-center gap-2">
      <Button asChild variant="outline" size="sm" title="Open the API-served URL in a new tab">
        <a href={href} target="_blank" rel="noreferrer">
          <ExternalLink className="size-3.5" />
          Open
          {authMode === "password" ? (
            <span className="text-muted-foreground">(password required)</span>
          ) : null}
        </a>
      </Button>
      <Button
        variant="outline"
        size="sm"
        title="Open the browser print dialog (use Save as PDF)"
        onClick={onExportPdf}
      >
        <Printer className="size-3.5" />
        Export PDF
      </Button>
      <Button asChild variant="outline" size="sm" title="Maximize within the SPA">
        <Link to={`/pages/${id}?mode=full`}>
          <Maximize2 className="size-3.5" />
          Full
        </Link>
      </Button>
    </div>
  );
}

/**
 * Page renderer for DB-backed pages (the "pages" feature — see
 * `thoughts/taras/plans/2026-05-12-db-backed-pages/`). Mounted at
 * `/artifacts/:id`.
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
import { AlertCircle, Lock } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "@/api/client";
import type { PageMetadata } from "@/api/types";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getConfig } from "@/lib/config";

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
async function fetchPageMetadataWithLaunchRetry(id: string): Promise<PageMetadata> {
  try {
    return await api.fetchPageMetadata(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes(": 401")) throw e;
  }
  // 401 → try launch + retry. If launch returns 400, the page is password-mode;
  // synthesize a stub so the password-frame branch renders.
  try {
    await api.launchPage(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(": 400")) {
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
    throw e;
  }
  return api.fetchPageMetadata(id);
}

// ─── Frames ─────────────────────────────────────────────────────────────────

interface FrameProps {
  id: string;
  title: string;
}

function PageIframe({ src, title }: { src: string; title: string }) {
  return (
    <iframe
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

function PublicHtmlFrame({ id, title }: FrameProps) {
  const src = `${getAbsoluteApiUrl()}/p/${encodeURIComponent(id)}`;
  return <PageIframe src={src} title={title} />;
}

function AuthedHtmlFrame({ id, title }: FrameProps) {
  // We've already launched once via `fetchPageMetadataWithLaunchRetry`'s
  // 401 → launch → retry path; the cookie is set. Just render the iframe.
  // (If the cookie was rejected by SameSite policy in dev, the iframe's
  // /p/:id request will 401 inside the frame — the user sees the swarm's
  // 401 error JSON, which is the same UX as a server-side denial.)
  const src = `${getAbsoluteApiUrl()}/p/${encodeURIComponent(id)}`;
  return <PageIframe src={src} title={title} />;
}

function PasswordHtmlFrame({ id, title }: FrameProps) {
  const [password, setPassword] = useState("");
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);

  if (iframeSrc) {
    return <PageIframe src={iframeSrc} title={title} />;
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

function JsonPlaceholder({ id }: { id: string }) {
  const apiUrl = `${getAbsoluteApiUrl()}/p/${encodeURIComponent(id)}`;
  return (
    <AlertCallout tone="info" icon={AlertCircle} title="JSON renderer coming in step-7">
      <p className="mb-2">
        This page is a JSON artifact. The interactive renderer is not yet wired up — track progress
        in step-7 of the db-backed-pages plan.
      </p>
      <p>
        Inspect the raw JSON at:{" "}
        <a
          href={`${apiUrl}.json`}
          target="_blank"
          rel="noreferrer"
          className="underline text-primary"
        >
          {apiUrl}.json
        </a>
      </p>
    </AlertCallout>
  );
}

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
    body = <JsonPlaceholder id={id} />;
  } else {
    switch (data.authMode) {
      case "public":
        body = <PublicHtmlFrame id={id} title={data.title} />;
        break;
      case "authed":
        body = <AuthedHtmlFrame id={id} title={data.title} />;
        break;
      case "password":
        body = <PasswordHtmlFrame id={id} title={data.title} />;
        break;
    }
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 gap-4">
      <PageHeader title={data.title} description={data.description ?? undefined} />
      {body}
    </div>
  );
}

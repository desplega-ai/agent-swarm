import { Suspense, useEffect } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useOnboardingOwnsFirstRun } from "@/api/hooks/use-onboarding";
import { StatusProvider } from "@/app/status-context";
import { ContextPanelProvider } from "@/components/context-panel/context-panel-state";
import { ContextSessionPanel } from "@/components/context-panel/context-session-panel";
import { FeedbackDialog } from "@/components/feedback/feedback-dialog";
import { IdentityModal } from "@/components/identity/identity-modal";
import { OnboardingRedirect } from "@/components/onboarding/onboarding-redirect";
import { CommandMenu, CommandMenuProvider } from "@/components/shared/command-menu";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { HiveLoadingScreen } from "@/components/shared/hive-loading-screen";
import { NameConnectionModal } from "@/components/shared/name-connection-modal";
import { OrganizationNameDialog } from "@/components/shared/organization-name-dialog";
import { LeadCredentialDialog } from "@/components/support/lead-credential-dialog";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AgentFsProvider } from "@/contexts/agent-fs-context";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { useLaterNotifier } from "@/hooks/use-later-notifier";
import { CREDENTIAL_URL_PARAMS, withoutConnectionParams } from "@/lib/connection-url-params";
import { MAIN_GUTTER, MAIN_GUTTER_NO_TOP } from "@/lib/main-gutter";
import { cn } from "@/lib/utils";
import { AppFooter } from "./app-footer";
import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";

/**
 * Phase 3: auto-pop the identity modal whenever:
 *   - `CurrentUserContext` is in `needs-pick` (no userId for this apiUrl, OR
 *     stored userId no longer matches a row in `useUsers()`), AND
 *   - the API server is ≥1.76.0 (soft-degrade against older servers: they
 *     return 404 from `/api/users` and would render an empty modal).
 *
 * Mounted in the configured shell only, so it never pops on `/setup` (the
 * first-task step picks the user inline). It also stays closed while the
 * onboarding query is pending, or while onboarding is open and not minimized:
 * the redirect to `/setup` is about to happen.
 */
function IdentityGate() {
  const { state, locked } = useCurrentUser();
  const { supported } = useFeatureGate("1.76.0");
  const onboardingOwnsIdentity = useOnboardingOwnsFirstRun({ whileMinimized: false });
  if (!supported) return null;
  if (onboardingOwnsIdentity) return null;
  // Token-bound identity (DES-771) never needs picking. Belt-and-braces on
  // top of the provider never entering `needs-pick` while locked.
  if (locked) return null;
  if (state !== "needs-pick") return null;
  return <IdentityModal />;
}

/**
 * `use-config` reads `?apiUrl=&apiKey=` once and strips them with
 * `history.replaceState`, which React Router never sees. Its location still
 * holds them, and any page that copies the search params (a session tab, a
 * filter) would put the key back in the address bar. Drop them from the
 * router's copy too. `/setup` (outside this layout) mounts it as well.
 */
export function ConnectionParamsCleanup() {
  const location = useLocation();
  const navigate = useNavigate();
  const stripped = withoutConnectionParams(location.search, CREDENTIAL_URL_PARAMS);
  useEffect(() => {
    if (stripped === null) return;
    void navigate(
      { pathname: location.pathname, search: stripped, hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [stripped, navigate, location.pathname, location.hash, location.state]);
  return null;
}

/** Sessions in Later wake in this browser on every dashboard page (plan A13). */
function LaterNotifier() {
  useLaterNotifier();
  return null;
}

export function RootLayout() {
  const { pathname, search, hash } = useLocation();
  const { config, isConfigured } = useConfig();
  // The unified Home (`/`) owns its own internal padding so the full-bleed
  // canvas can reach the content-area edges. Comb (`/file`) drops the top
  // gutter: its header (path, file actions) sits right under the app header.
  // Every other route gets the standard gutter.
  const mainPadding =
    pathname === "/"
      ? "p-0"
      : pathname === "/file" || pathname.startsWith("/file/")
        ? MAIN_GUTTER_NO_TOP
        : MAIN_GUTTER;

  // No connection yet: the full-page `/setup` flow starts at step 1 (connect)
  // and returns here after connecting.
  if (!isConfigured) {
    return <Navigate to="/setup" replace state={{ from: `${pathname}${search}${hash}` }} />;
  }

  return (
    <StatusProvider pollIntervalMs={30_000}>
      <AgentFsProvider>
        {/* Pages add their own palette commands through it, so it wraps the
            routes and the palette. */}
        <CommandMenuProvider>
          <ContextPanelProvider>
            {/* The first Tab stop: it moves focus past the sidebar and the
              header to the page content (the browser focuses the target,
              which has tabIndex -1). Off screen until it has focus. */}
            <a
              href="#main-content"
              className="fixed top-3 left-3 z-50 -translate-y-[calc(100%+1rem)] rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm outline-none focus:translate-y-0 focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              Skip to content
            </a>
            <SidebarProvider className="h-svh max-w-full overflow-hidden">
              <AppSidebar />
              <SidebarInset className="min-w-0">
                <AppHeader />
                {/* The page's one `main` landmark (the inset is a div). Below lg
                the main column is the scroll container so pages that flow
                naturally (detail pages, forms) can scroll; at lg+ it goes
                back to overflow-hidden and pages own their scroll regions
                (pinned headers, grid-internal scrolling). */}
                <main
                  id="main-content"
                  tabIndex={-1}
                  className={cn(
                    "flex flex-1 flex-col min-h-0 min-w-0 overflow-x-hidden overflow-y-auto lg:overflow-hidden outline-none",
                    mainPadding,
                  )}
                >
                  <ErrorBoundary>
                    <Suspense fallback={<HiveLoadingScreen />}>
                      <Outlet />
                    </Suspense>
                  </ErrorBoundary>
                </main>
                <AppFooter />
              </SidebarInset>
              {/* Contextual session panel: a flex sibling of the inset, so the page
              stays interactive while the user gives feedback. */}
              <ContextSessionPanel />
            </SidebarProvider>
          </ContextPanelProvider>
          <CommandMenu />
        </CommandMenuProvider>
        <OnboardingRedirect />
        <IdentityGate />
        <ConnectionParamsCleanup />
        <LaterNotifier />
        <NameConnectionModal />
        <OrganizationNameDialog key={`organization:${config.apiUrl}`} />
        <LeadCredentialDialog key={config.apiUrl} />
        <FeedbackDialog key={`feedback:${config.apiUrl}`} />
      </AgentFsProvider>
    </StatusProvider>
  );
}

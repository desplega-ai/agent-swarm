import { Suspense } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { StatusProvider } from "@/app/status-context";
import { FeedbackDialog } from "@/components/feedback/feedback-dialog";
import { IdentityModal } from "@/components/identity/identity-modal";
import { OnboardingRedirect } from "@/components/onboarding/onboarding-redirect";
import { CommandMenu } from "@/components/shared/command-menu";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { HiveLoadingScreen } from "@/components/shared/hive-loading-screen";
import { NameConnectionModal } from "@/components/shared/name-connection-modal";
import { OrganizationNameDialog } from "@/components/shared/organization-name-dialog";
import { LeadCredentialDialog } from "@/components/support/lead-credential-dialog";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { cn } from "@/lib/utils";
import { AppFooter } from "./app-footer";
import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";
import { ConfigGuard } from "./config-guard";

/**
 * Phase 3: auto-pop the identity modal whenever:
 *   - `CurrentUserContext` is in `needs-pick` (no userId for this apiUrl, OR
 *     stored userId no longer matches a row in `useUsers()`), AND
 *   - the API server is ≥1.76.0 (soft-degrade against older servers: they
 *     return 404 from `/api/users` and would render an empty modal).
 *
 * Mounted in the configured shell only, so it never pops on `/setup` (the
 * first-task step picks the user inline).
 */
function IdentityGate() {
  const { state, locked } = useCurrentUser();
  const { supported } = useFeatureGate("1.76.0");
  if (!supported) return null;
  // Token-bound identity (DES-771) never needs picking. Belt-and-braces on
  // top of the provider never entering `needs-pick` while locked.
  if (locked) return null;
  if (state !== "needs-pick") return null;
  return <IdentityModal />;
}

export function RootLayout() {
  const { pathname, search, hash } = useLocation();
  const { config, isConfigured } = useConfig();
  // The unified Home (`/`) owns its own internal padding so the full-bleed
  // canvas can reach the content-area edges; every other route gets the
  // standard gutter.
  const mainPadding = pathname === "/" ? "p-0" : "p-4 md:p-6";

  // No connection yet: the full-page `/setup` flow starts at step 1 (connect)
  // and returns here after connecting.
  if (!isConfigured) {
    return <Navigate to="/setup" replace state={{ from: `${pathname}${search}${hash}` }} />;
  }

  return (
    <ConfigGuard>
      <StatusProvider pollIntervalMs={30_000}>
        <SidebarProvider className="h-svh max-w-full overflow-hidden">
          <AppSidebar />
          <SidebarInset className="min-w-0">
            <AppHeader />
            {/* Below lg the main column is the scroll container so pages that
                flow naturally (detail pages, forms) can scroll; at lg+ it goes
                back to overflow-hidden and pages own their scroll regions
                (pinned headers, grid-internal scrolling). */}
            <main
              className={cn(
                "flex flex-1 flex-col min-h-0 min-w-0 overflow-x-hidden overflow-y-auto lg:overflow-hidden",
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
        </SidebarProvider>
        <CommandMenu />
        <OnboardingRedirect />
        <IdentityGate />
        <NameConnectionModal />
        <OrganizationNameDialog key={`organization:${config.apiUrl}`} />
        <LeadCredentialDialog key={config.apiUrl} />
        <FeedbackDialog key={`feedback:${config.apiUrl}`} />
      </StatusProvider>
    </ConfigGuard>
  );
}

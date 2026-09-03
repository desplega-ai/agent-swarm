import { Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { StatusProvider } from "@/app/status-context";
import { CommandMenu } from "@/components/shared/command-menu";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { HiveLoadingScreen } from "@/components/shared/hive-loading-screen";
import { NameConnectionModal } from "@/components/shared/name-connection-modal";
import { LeadCredentialDialog } from "@/components/support/lead-credential-dialog";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useConfig } from "@/hooks/use-config";
import { cn } from "@/lib/utils";
import { WelcomeCard } from "@/pages/config/components/welcome-card";
import { AppFooter } from "./app-footer";
import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";
import { ConfigGuard } from "./config-guard";

export function RootLayout() {
  const { pathname } = useLocation();
  const { config, isConfigured } = useConfig();
  // The unified Home (`/`) owns its own internal padding so the full-bleed
  // canvas can reach the content-area edges; every other route gets the
  // standard gutter.
  const mainPadding = pathname === "/" ? "p-0" : "p-4 md:p-6";

  // No connection yet: full-page connect takeover instead of the app shell —
  // no sidebar/header/footer behind, just the centered onboarding card.
  if (!isConfigured) {
    return (
      <div className="flex min-h-svh w-full items-center justify-center bg-background p-4">
        <WelcomeCard />
      </div>
    );
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
        <NameConnectionModal />
        <LeadCredentialDialog key={config.apiUrl} />
      </StatusProvider>
    </ConfigGuard>
  );
}

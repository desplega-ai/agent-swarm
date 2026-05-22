import { Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { StatusProvider } from "@/app/status-context";
import { CommandMenu } from "@/components/shared/command-menu";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { NameConnectionModal } from "@/components/shared/name-connection-modal";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { AppFooter } from "./app-footer";
import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";
import { ConfigGuard } from "./config-guard";

export function RootLayout() {
  const { pathname } = useLocation();
  // The unified Home (`/`) owns its own internal padding so the full-bleed
  // canvas can reach the content-area edges; every other route gets the
  // standard gutter.
  const mainPadding = pathname === "/" ? "p-0" : "p-4 md:p-6";

  return (
    <ConfigGuard>
      <StatusProvider pollIntervalMs={30_000}>
        <SidebarProvider className="h-svh max-w-full overflow-hidden">
          <AppSidebar />
          <SidebarInset className="min-w-0">
            <AppHeader />
            <main
              className={cn("flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden", mainPadding)}
            >
              <ErrorBoundary>
                <Suspense fallback={<PageSkeleton />}>
                  <Outlet />
                </Suspense>
              </ErrorBoundary>
            </main>
            <AppFooter />
          </SidebarInset>
        </SidebarProvider>
        <CommandMenu />
        <NameConnectionModal />
      </StatusProvider>
    </ConfigGuard>
  );
}

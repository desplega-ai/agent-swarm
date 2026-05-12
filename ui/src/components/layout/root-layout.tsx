import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { StatusProvider } from "@/app/status-context";
import { CommandMenu } from "@/components/shared/command-menu";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { NameConnectionModal } from "@/components/shared/name-connection-modal";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppFooter } from "./app-footer";
import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";
import { ConfigGuard } from "./config-guard";

export function RootLayout() {
  return (
    <ConfigGuard>
      <StatusProvider pollIntervalMs={30_000}>
        <SidebarProvider className="h-svh max-w-full overflow-hidden">
          <AppSidebar />
          <SidebarInset className="min-w-0">
            <AppHeader />
            <main className="flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden p-4 md:p-6">
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

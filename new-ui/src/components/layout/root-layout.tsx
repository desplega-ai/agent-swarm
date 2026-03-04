import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { CommandMenu } from "@/components/shared/command-menu";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";
import { ConfigGuard } from "./config-guard";

function ShortcutProvider({ children }: { children: React.ReactNode }) {
  useKeyboardShortcuts();
  return <>{children}</>;
}

export function RootLayout() {
  return (
    <ConfigGuard>
      <ShortcutProvider>
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
          </SidebarInset>
        </SidebarProvider>
        <CommandMenu />
      </ShortcutProvider>
    </ConfigGuard>
  );
}

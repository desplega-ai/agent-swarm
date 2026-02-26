import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./app-sidebar";
import { AppHeader } from "./app-header";
import { ConfigGuard } from "./config-guard";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { CommandMenu } from "@/components/shared/command-menu";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

function ShortcutProvider({ children }: { children: React.ReactNode }) {
  useKeyboardShortcuts();
  return <>{children}</>;
}

export function RootLayout() {
  return (
    <ConfigGuard>
      <ShortcutProvider>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            <AppHeader />
            <main className="flex flex-1 flex-col overflow-hidden p-4 md:p-6">
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

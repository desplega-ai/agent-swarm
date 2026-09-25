import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CurrentUserProvider } from "@/contexts/current-user-context";
import { ConfigContext, useConfigProvider } from "@/hooks/use-config";
import { ThemeProvider } from "@/hooks/use-theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 10000,
      staleTime: 2000,
      gcTime: 1000 * 60 * 60 * 24,
      retry: 2,
    },
  },
});

const localStoragePersister =
  typeof window === "undefined"
    ? undefined
    : createSyncStoragePersister({
        key: "agent-swarm-query-cache-v1",
        storage: window.localStorage,
      });

function ConfigProvider({ children }: { children: ReactNode }) {
  const value = useConfigProvider();
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

// `IdentityGate` lives in `RootLayout` (the configured app shell), so the
// identity modal never pops over the `/setup` onboarding flow.
export function Providers({ children }: { children: ReactNode }) {
  const content = (
    // `reducedMotion="user"`: every motion/react animation (animated icons
    // included) drops transform/movement for prefers-reduced-motion users
    // while keeping opacity fades — "gentler, not zero" (DESIGN.md § Motion).
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <ConfigProvider>
          <CurrentUserProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </CurrentUserProvider>
        </ConfigProvider>
      </ThemeProvider>
    </MotionConfig>
  );

  if (!localStoragePersister) {
    return <QueryClientProvider client={queryClient}>{content}</QueryClientProvider>;
  }

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        buster: `ui-${__APP_VERSION__}`,
        maxAge: 1000 * 60 * 60 * 6,
        persister: localStoragePersister,
      }}
    >
      {content}
    </PersistQueryClientProvider>
  );
}

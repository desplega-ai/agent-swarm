import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import type { ReactNode } from "react";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { IdentityModal } from "@/components/identity/identity-modal";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CurrentUserProvider, useCurrentUser } from "@/contexts/current-user-context";
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

/**
 * Phase 3: auto-pop the identity modal whenever:
 *   - `CurrentUserContext` is in `needs-pick` (no userId for this apiUrl, OR
 *     stored userId no longer matches a row in `useUsers()`), AND
 *   - the API server is ≥1.76.0 (soft-degrade against older servers — they
 *     return 404 from `/api/users` and would render an empty modal).
 */
function IdentityGate() {
  const { state } = useCurrentUser();
  const { supported } = useFeatureGate("1.76.0");
  if (!supported) return null;
  if (state !== "needs-pick") return null;
  return <IdentityModal />;
}

export function Providers({ children }: { children: ReactNode }) {
  const content = (
    <ThemeProvider>
      <ConfigProvider>
        <CurrentUserProvider>
          <TooltipProvider>
            {children}
            <IdentityGate />
          </TooltipProvider>
        </CurrentUserProvider>
      </ConfigProvider>
    </ThemeProvider>
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

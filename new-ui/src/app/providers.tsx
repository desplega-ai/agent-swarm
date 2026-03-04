import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfigContext, useConfigProvider } from "@/hooks/use-config";
import { ThemeProvider } from "@/hooks/use-theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 5000,
      staleTime: 2000,
      retry: 2,
    },
  },
});

function ConfigProvider({ children }: { children: ReactNode }) {
  const value = useConfigProvider();
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ConfigProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </ConfigProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

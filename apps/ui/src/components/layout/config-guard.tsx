import { Navigate, useLocation } from "react-router-dom";
import { useConfig } from "@/hooks/use-config";

interface ConfigGuardProps {
  children: React.ReactNode;
}

export function ConfigGuard({ children }: ConfigGuardProps) {
  const { isConfigured } = useConfig();
  const location = useLocation();

  // Always allow access to the connections page itself. After the
  // sidebar-trim IA rework Config split into /settings/connections; that page
  // keeps a WelcomeCard fallback when unconfigured.
  if (location.pathname === "/settings/connections") {
    return <>{children}</>;
  }

  // No connection: the full-page `/setup` flow starts at step 1 (connect).
  if (!isConfigured) {
    return (
      <Navigate
        to="/setup"
        replace
        state={{ from: `${location.pathname}${location.search}${location.hash}` }}
      />
    );
  }

  return <>{children}</>;
}

import { Navigate, useLocation } from "react-router-dom";
import { useConfig } from "@/hooks/use-config";

interface ConfigGuardProps {
  children: React.ReactNode;
}

export function ConfigGuard({ children }: ConfigGuardProps) {
  const { isConfigured } = useConfig();
  const location = useLocation();

  // Always allow access to the config page itself. After the sidebar-trim IA
  // rework Config lives at /settings/config; matching the new path here avoids
  // an infinite redirect loop (the old /config now redirects to /settings/config).
  if (location.pathname === "/settings/config") {
    return <>{children}</>;
  }

  if (!isConfigured) {
    return (
      <Navigate
        to="/settings/config"
        replace
        state={{ from: `${location.pathname}${location.search}${location.hash}` }}
      />
    );
  }

  return <>{children}</>;
}

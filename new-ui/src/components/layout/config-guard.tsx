import { useConfig } from "@/hooks/use-config";
import { useLocation, Navigate } from "react-router-dom";

interface ConfigGuardProps {
  children: React.ReactNode;
}

export function ConfigGuard({ children }: ConfigGuardProps) {
  const { isConfigured } = useConfig();
  const location = useLocation();

  // Always allow access to the config page itself
  if (location.pathname === "/config") {
    return <>{children}</>;
  }

  if (!isConfigured) {
    return <Navigate to="/config" replace />;
  }

  return <>{children}</>;
}

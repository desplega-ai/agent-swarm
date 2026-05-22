import { Navigate, useLocation } from "react-router-dom";
import { useConfig } from "@/hooks/use-config";

interface ConfigGuardProps {
  children: React.ReactNode;
}

export function ConfigGuard({ children }: ConfigGuardProps) {
  const { isConfigured } = useConfig();
  const location = useLocation();

  // Always allow access to the connections page itself. After the
  // sidebar-trim IA rework Config split into /settings/connections; matching
  // the new path here avoids an infinite redirect loop (the WelcomeCard
  // onboarding flow renders on that route when unconfigured).
  if (location.pathname === "/settings/connections") {
    return <>{children}</>;
  }

  if (!isConfigured) {
    return (
      <Navigate
        to="/settings/connections"
        replace
        state={{ from: `${location.pathname}${location.search}${location.hash}` }}
      />
    );
  }

  return <>{children}</>;
}

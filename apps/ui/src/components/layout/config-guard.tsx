import { Navigate, useLocation } from "react-router-dom";
import { useConfig } from "@/hooks/use-config";

interface ConfigGuardProps {
  children: React.ReactNode;
}

export function ConfigGuard({ children }: ConfigGuardProps) {
  const { isConfigured } = useConfig();
  const location = useLocation();

  // Design-review routes contain static, in-product proposals and must be
  // reproducible without connecting the UI to a live swarm.
  if (import.meta.env.DEV && location.pathname.startsWith("/dev/")) {
    return <>{children}</>;
  }

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

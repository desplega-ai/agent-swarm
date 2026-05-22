import { Navigate, useParams } from "react-router-dom";

interface RouteRedirectProps {
  /**
   * Builds the redirect target from the matched route params. Receives the
   * `params` object from `useParams()` so deep-link segments can be preserved.
   */
  to: (params: Record<string, string | undefined>) => string;
}

/**
 * Param-aware backward-compat redirect. Reads the current route params and
 * renders a replacing `<Navigate>` to the computed target — used for moved
 * dynamic routes like `/integrations/:id` → `/settings/integrations/:id`.
 */
export function RouteRedirect({ to }: RouteRedirectProps) {
  const params = useParams();
  return <Navigate replace to={to(params)} />;
}

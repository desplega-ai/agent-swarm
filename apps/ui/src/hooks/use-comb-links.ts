import { useCallback } from "react";
import { useOptionalAgentFs } from "@/contexts/agent-fs-context";
import { combLinkFor } from "@/lib/comb/links";

/**
 * Maps an agent-fs link (live UI or dashboard `/file/~/...`) to its Comb route
 * while Comb is connected. Otherwise it returns null and the caller keeps the
 * original link (a new tab). See `combLinkFor`.
 */
export function useCombLinks(): (href: string | null | undefined) => string | null {
  const agentFs = useOptionalAgentFs();
  const state = agentFs?.state ?? "disabled";
  const liveUrl = agentFs?.liveUrl ?? null;
  return useCallback(
    (href) => combLinkFor(state, liveUrl, window.location.origin, href),
    [state, liveUrl],
  );
}

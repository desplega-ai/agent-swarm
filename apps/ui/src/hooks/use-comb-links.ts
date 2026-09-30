import { useCallback } from "react";
import { useOptionalAgentFs } from "@/contexts/agent-fs-context";
import { combPathForLink, isCombNavigable } from "@/lib/comb/links";

/**
 * Maps an agent-fs link (live UI or dashboard `/file/~/...`) to its Comb route
 * while Comb is connected. Otherwise it returns null and the caller keeps the
 * original link (a new tab). While Comb is loading the original link stays, so
 * a click never goes to Comb before the key is checked.
 */
export function useCombLinks(): (href: string | null | undefined) => string | null {
  const agentFs = useOptionalAgentFs();
  const navigable = agentFs !== null && isCombNavigable(agentFs.state);
  const liveUrl = agentFs?.liveUrl ?? null;
  return useCallback(
    (href) =>
      navigable && href
        ? combPathForLink(href, { liveUrl, appOrigin: window.location.origin })
        : null,
    [navigable, liveUrl],
  );
}

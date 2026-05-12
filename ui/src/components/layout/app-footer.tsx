/**
 * Phase 2: Subtle footer marketing link for self-hosted deployments.
 *
 * Visible only when ALL of:
 *   - `identity.is_cloud === false` (i.e. we are self-hosted), AND
 *   - `identity.marketing_url` is set, AND
 *   - `identity.hide_cloud_promo === false` (operator hasn't opted out via
 *     `SWARM_HIDE_CLOUD_PROMO`).
 *
 * Designed to be reachable but not aggressive. Phase 4 will wire a per-browser
 * dismiss on top of this; for now it's always visible when the rules above
 * pass.
 */

import { ExternalLink } from "lucide-react";
import { useStatusContext } from "@/app/status-context";

export function AppFooter() {
  const { data: status } = useStatusContext();
  const identity = status?.identity;

  // Only render the link when all three conditions are met. We deliberately
  // don't render an empty <footer/> — keeps the DOM lean for the common case.
  if (!identity) return null;
  if (identity.is_cloud) return null;
  if (identity.hide_cloud_promo) return null;
  if (!identity.marketing_url) return null;

  return (
    <footer className="flex items-center justify-end border-t border-border/50 px-4 py-2 text-xs text-muted-foreground">
      <a
        href={identity.marketing_url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
      >
        Don't want to self-host? Try hosted swarm
        <ExternalLink className="size-3" />
      </a>
    </footer>
  );
}

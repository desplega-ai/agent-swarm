/**
 * Where link previews apply. `LinkPreviewScope` turns them on for the content
 * it wraps (the task and session detail pages): inside it, a plain click on
 * an agent-fs file or page link opens the preview panel instead of
 * navigating. Outside it, and inside the panel itself, links behave as usual,
 * so a preview never opens a nested panel. The open preview lives in the
 * context panel state (`context-panel-state.tsx`), which owns the right column.
 */

import { createContext, type MouseEvent, type ReactNode, useContext, useMemo } from "react";
import { useOptionalContextPanel } from "@/components/context-panel/context-panel-state";
import { isPlainClick, linkPreviewTarget } from "@/lib/link-preview";
import type { SwarmLinkOrigins } from "@/lib/swarm-links";

const LinkPreviewScopeContext = createContext(false);

/** Turns link previews on for `children`. */
export function LinkPreviewScope({ children }: { children: ReactNode }) {
  return <LinkPreviewScopeContext.Provider value>{children}</LinkPreviewScopeContext.Provider>;
}

/**
 * The click handler for a link to `href` (`origins` from `useSwarmLinkOrigins`):
 * on a plain click it opens the preview and stops the navigation. Undefined
 * when the link is not previewable here, so the caller keeps its own behavior.
 */
export function useLinkPreviewClick(
  href: string | null | undefined,
  origins: SwarmLinkOrigins,
): ((event: MouseEvent<HTMLElement>) => void) | undefined {
  const inScope = useContext(LinkPreviewScopeContext);
  const openPreview = useOptionalContextPanel()?.openPreview;
  const enabled = inScope && !!openPreview;
  const target = useMemo(
    () => (enabled ? linkPreviewTarget(href, origins) : null),
    [enabled, href, origins],
  );
  return useMemo(() => {
    if (!target || !openPreview) return undefined;
    return (event: MouseEvent<HTMLElement>) => {
      if (!isPlainClick(event)) return;
      // A docked preview would sit under a dialog (the task sheet in a
      // session), so links inside one keep their behavior.
      if (event.currentTarget.closest('[role="dialog"]')) return;
      event.preventDefault();
      openPreview(target);
    };
  }, [target, openPreview]);
}

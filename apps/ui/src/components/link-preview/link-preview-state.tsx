/**
 * Where link previews apply. `LinkPreviewScope` turns them on for the content
 * it wraps (the task and session detail pages): inside it, a plain click on
 * an agent-fs file or page link opens the preview panel instead of
 * navigating. Outside it, and inside the panel itself, links behave as usual,
 * so a preview never opens a nested panel. The open preview lives in the
 * context panel state (`context-panel-state.tsx`), so it and the Cmd+I panel
 * show one at a time.
 *
 * A page shows the preview inside its own body with `<LinkPreviewDock>`
 * (`link-preview-dock.tsx`), next to its content. A page with no dock shows
 * it as a sheet over the page.
 */

import { type MouseEvent, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useOptionalContextPanel } from "@/components/context-panel/context-panel-state";
import { isPlainClick, linkPreviewTarget } from "@/lib/link-preview";
import type { SwarmLinkOrigins } from "@/lib/swarm-links";
import { LinkPreviewSheet } from "./link-preview-panel";
import { LinkPreviewScopeContext, useLinkPreviewScope } from "./link-preview-scope";

export { useLinkPreviewScope };

/** Turns link previews on for `children`. */
export function LinkPreviewScope({ children }: { children: ReactNode }) {
  const panel = useOptionalContextPanel();
  const [docks, setDocks] = useState(0);
  const registerDock = useCallback(() => {
    setDocks((n) => n + 1);
    return () => setDocks((n) => n - 1);
  }, []);
  const value = useMemo(() => ({ registerDock }), [registerDock]);
  const target = panel?.preview ?? null;
  return (
    <LinkPreviewScopeContext.Provider value={value}>
      {children}
      {target && docks === 0 && panel ? (
        <LinkPreviewSheet target={target} onClose={panel.closePreview} />
      ) : null}
    </LinkPreviewScopeContext.Provider>
  );
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
  const inScope = useContext(LinkPreviewScopeContext) !== null;
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
      // A preview would sit under a dialog (the task sheet in a session),
      // so links inside one keep their behavior.
      if (event.currentTarget.closest('[role="dialog"]')) return;
      event.preventDefault();
      openPreview(target);
    };
  }, [target, openPreview]);
}

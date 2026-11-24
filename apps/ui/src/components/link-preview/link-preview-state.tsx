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

import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams } from "react-router-dom";
import { useOptionalContextPanel } from "@/components/context-panel/context-panel-state";
import { isPlainClick, type LinkPreviewTarget, linkPreviewTarget } from "@/lib/link-preview";
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
 * Sends the previews of `children` to `open` instead of the side panel. The
 * sessions view wraps each pane in one, so a link opens as a tab there.
 * Outside a `LinkPreviewScope` it does nothing.
 */
export function LinkPreviewOpener({
  open,
  children,
}: {
  open: (target: LinkPreviewTarget) => void;
  children: ReactNode;
}) {
  const scope = useLinkPreviewScope();
  // The latest `open` without a new context value on each render.
  const latest = useRef(open);
  latest.current = open;
  const value = useMemo(
    () =>
      scope ? { ...scope, open: (target: LinkPreviewTarget) => latest.current(target) } : null,
    [scope],
  );
  return (
    <LinkPreviewScopeContext.Provider value={value}>{children}</LinkPreviewScopeContext.Provider>
  );
}

/**
 * Opens a preview from inside a scope: in the scope's own place (a sessions
 * tab) when it has one, else in the side panel. Undefined outside a scope.
 */
export function useOpenLinkPreview(): ((target: LinkPreviewTarget) => void) | undefined {
  const scope = useContext(LinkPreviewScopeContext);
  const openPreview = useOptionalContextPanel()?.openPreview;
  const { id, rootTaskId } = useParams();
  return useMemo(() => {
    if (!scope || !openPreview) return scope?.open;
    if (scope.open) return scope.open;
    const origin = id
      ? { kind: "task" as const, id }
      : rootTaskId
        ? { kind: "session" as const, id: rootTaskId }
        : undefined;
    return (target: LinkPreviewTarget) =>
      openPreview(target.kind === "file" && origin ? { ...target, origin } : target);
  }, [scope, openPreview, id, rootTaskId]);
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
  const openPreview = useOpenLinkPreview();
  const enabled = !!openPreview;
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

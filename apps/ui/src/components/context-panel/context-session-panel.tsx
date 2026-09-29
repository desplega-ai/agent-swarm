/**
 * Dashboard adapter for <SessionPanel>: derives the page key and footer from
 * the current route and docks the panel on the right from `xl` up. Below
 * that, docking would leave the page too narrow (at 1024 px with the nav
 * open, about 270 px), so the panel opens as a sheet over the page instead:
 * up to 420 px wide on tablets, full screen on phones. Between `xl` and `2xl`
 * the docked panel collapses the nav to icons while it is open, so the page
 * keeps about 850 px, and gives the nav back on close.
 * Everything else lives in `components/session-panel`.
 */

import { MessageSquarePlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { SessionPanel } from "@/components/session-panel";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfig } from "@/hooks/use-config";
import {
  buildPageContextFooter,
  getPageContext,
  type PageContext,
  pageContextLabel,
} from "@/lib/page-context";
import { useContextPanel } from "./context-panel-state";

const DOCK_QUERY = "(min-width: 1280px)";
const WIDE_QUERY = "(min-width: 1536px)";

/** The page column (header, route content, footer): what "Add screenshot" captures. */
const pageColumn = () => document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]');

function usePageContext(): PageContext | null {
  const { pathname, search, hash } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: search/hash feed window.location.href
  return useMemo(
    () => getPageContext({ pathname, url: window.location.href, title: document.title }),
    [pathname, search, hash],
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * Collapses the nav to icons while `active`, and expands it again afterwards
 * if this hook was what collapsed it.
 */
function useCollapseNavWhile(active: boolean) {
  const sidebar = useSidebar();
  // Latest values without re-running the effect: it acts on `active` changes
  // only, so the user can still expand the nav while the panel is open.
  const sidebarRef = useRef(sidebar);
  sidebarRef.current = sidebar;
  const collapsedByPanel = useRef(false);
  useEffect(() => {
    const { open, setOpen } = sidebarRef.current;
    if (active) {
      if (!open) return;
      collapsedByPanel.current = true;
      setOpen(false);
    } else if (collapsedByPanel.current) {
      collapsedByPanel.current = false;
      setOpen(true);
    }
  }, [active]);
}

/** Header button next to the notification bell. Hidden where the panel is not offered. */
export function ContextPanelToggle() {
  const { supported, open, toggle } = useContextPanel();
  const pageCtx = usePageContext();
  if (!supported || !pageCtx) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={open ? "secondary" : "ghost"}
          size="icon"
          className="size-8"
          onClick={toggle}
          aria-label="Session about this page"
          aria-pressed={open}
        >
          <MessageSquarePlus className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Session about this page (⌘I)</TooltipContent>
    </Tooltip>
  );
}

export function ContextSessionPanel() {
  const { open, setOpen } = useContextPanel();
  const pageCtx = usePageContext();
  const canDock = useMediaQuery(DOCK_QUERY);
  const isWide = useMediaQuery(WIDE_QUERY);
  const { config } = useConfig();
  const docked = open && !!pageCtx && canDock;
  useCollapseNavWhile(docked && !isWide);

  if (!open || !pageCtx) return null;

  const panel = (
    <SessionPanel
      pageKey={pageCtx.pageKey}
      contextLabel={pageContextLabel(pageCtx)}
      contextFooter={buildPageContextFooter(pageCtx)}
      storageNamespace={config.apiUrl}
      screenshotTarget={pageColumn}
      onClose={() => setOpen(false)}
    />
  );

  if (canDock) {
    return (
      <aside
        aria-label="Session about this page"
        className="flex h-svh w-[380px] shrink-0 flex-col border-l border-border 2xl:w-[420px]"
      >
        {panel}
      </aside>
    );
  }
  return (
    <Sheet open onOpenChange={setOpen}>
      <SheetContent
        side="right"
        showCloseButton={false}
        // Focusing the first control would ring the close button and, on a
        // phone, could pop the keyboard before the user chose to type.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-full gap-0 p-0 pb-[env(safe-area-inset-bottom)] sm:max-w-[420px]"
      >
        <SheetTitle className="sr-only">Session about this page</SheetTitle>
        <SheetDescription className="sr-only">
          Start or continue a swarm session with this page's context attached.
        </SheetDescription>
        {panel}
      </SheetContent>
    </Sheet>
  );
}

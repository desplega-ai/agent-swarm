/**
 * Dashboard adapter for <SessionPanel>: derives the page key and footer from
 * the current route and docks the panel on the right (full-screen sheet
 * below `lg`).
 * Everything else lives in `components/session-panel`.
 */

import { MessageSquarePlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { SessionPanel } from "@/components/session-panel";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfig } from "@/hooks/use-config";
import {
  buildPageContextFooter,
  getPageContext,
  type PageContext,
  pageContextLabel,
} from "@/lib/page-context";
import { useContextPanel } from "./context-panel-state";

const LG_QUERY = "(min-width: 1024px)";

function usePageContext(): PageContext | null {
  const { pathname, search, hash } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: search/hash feed window.location.href
  return useMemo(
    () => getPageContext({ pathname, url: window.location.href, title: document.title }),
    [pathname, search, hash],
  );
}

function useIsLg(): boolean {
  const [isLg, setIsLg] = useState(() => window.matchMedia(LG_QUERY).matches);
  useEffect(() => {
    const mql = window.matchMedia(LG_QUERY);
    const onChange = () => setIsLg(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isLg;
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
  const isLg = useIsLg();
  const { config } = useConfig();

  if (!open || !pageCtx) return null;

  const panel = (
    <SessionPanel
      pageKey={pageCtx.pageKey}
      contextLabel={pageContextLabel(pageCtx)}
      contextFooter={buildPageContextFooter(pageCtx)}
      storageNamespace={config.apiUrl}
      onClose={() => setOpen(false)}
    />
  );

  if (isLg) {
    return (
      <aside
        aria-label="Session about this page"
        className="flex h-svh w-[420px] shrink-0 flex-col border-l border-border"
      >
        {panel}
      </aside>
    );
  }
  return (
    <Sheet open onOpenChange={setOpen}>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-full">
        <SheetTitle className="sr-only">Session about this page</SheetTitle>
        <SheetDescription className="sr-only">
          Start or continue a swarm session with this page's context attached.
        </SheetDescription>
        {panel}
      </SheetContent>
    </Sheet>
  );
}

import { useEffect, useRef } from "react";
import { useSidebar } from "@/components/ui/sidebar";

// The app has one global nav, so every caller shares one count. The nav
// expands again only when the last active caller lets go, and only if the
// callers were what collapsed it.
let holders = 0;
let collapsedByHolders = false;

/**
 * Set the nav state with its width transition off. A route change or a
 * panel toggles the nav here, not the user, and route changes get no
 * animation (DESIGN.md § Motion). A click on the nav buttons or Cmd+B keeps
 * the 200ms transition. `.nav-instant` (globals.css) turns transitions off.
 * React commits the new width after `setOpen` returns, so the class stays for
 * two frames: the first paints the new width, then the class comes off.
 */
function setNavOpenInstantly(setOpen: (open: boolean) => void, open: boolean) {
  const root = document.documentElement;
  root.classList.add("nav-instant");
  setOpen(open);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void window.getComputedStyle(root).width;
      root.classList.remove("nav-instant");
    }),
  );
}

/**
 * Collapses the global nav to icons while `active`. When `active` ends, or
 * the caller unmounts, it expands the nav again, unless the user had
 * collapsed it before or another caller still holds it. The docked Cmd+I
 * panel and the sessions v2 view use it.
 */
export function useCollapseNavWhile(active: boolean) {
  const sidebar = useSidebar();
  // Latest values without re-running the effect: it acts on `active` changes
  // only, so the user can still expand the nav while the view is active.
  const sidebarRef = useRef(sidebar);
  sidebarRef.current = sidebar;
  useEffect(() => {
    if (!active) return;
    holders += 1;
    if (holders === 1 && sidebarRef.current.open) {
      collapsedByHolders = true;
      setNavOpenInstantly(sidebarRef.current.setOpen, false);
    }
    return () => {
      holders -= 1;
      // Wait for the rest of the commit: a caller that replaces this one in
      // the same render takes over the hold, and the nav does not flicker.
      queueMicrotask(() => {
        if (holders > 0 || !collapsedByHolders) return;
        collapsedByHolders = false;
        setNavOpenInstantly(sidebarRef.current.setOpen, true);
      });
    };
  }, [active]);
}

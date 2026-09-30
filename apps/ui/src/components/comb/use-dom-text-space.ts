import { type RefObject, useEffect, useState } from "react";
import { buildDomTextSpace, type DomTextSpace } from "@/lib/comb/dom-text-space";

/**
 * The text space of whatever the viewer pane shows, rebuilt when its DOM
 * changes (the file loads, a new version renders). Null until the pane holds
 * blocks with source lines (`data-line-start`), so media viewers and loading
 * skeletons never anchor comments.
 */
export function useDomTextSpace(rootRef: RefObject<HTMLElement | null>): DomTextSpace | null {
  const [space, setSpace] = useState<DomTextSpace | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    const rebuild = () => {
      frame = 0;
      setSpace(root.querySelector("[data-line-start]") ? buildDomTextSpace(root) : null);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(rebuild);
    };
    schedule();
    // Content changes only. Highlight fallback classes change attributes, which
    // must not trigger a rebuild.
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rootRef]);

  return space;
}

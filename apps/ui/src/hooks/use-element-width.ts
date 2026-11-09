import { useCallback, useState } from "react";

/**
 * An element's width in px, kept current by a ResizeObserver. Returns a
 * callback ref, so it follows an element that mounts after the first render.
 * 0 until the element mounts.
 */
export function useElementWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const [observer] = useState(() =>
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0)),
  );
  const ref = useCallback(
    (node: T | null) => {
      observer?.disconnect();
      if (node) {
        setWidth(node.getBoundingClientRect().width);
        observer?.observe(node);
      }
    },
    [observer],
  );
  return [ref, width] as const;
}

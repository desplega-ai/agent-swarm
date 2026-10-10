import { useEffect, useState } from "react";

/**
 * The border-box height of an element, in px, kept current by a
 * ResizeObserver. Attach the returned callback ref. It is 0 while nothing is
 * attached. The third item is the attached element.
 */
export function useElementHeight(): [
  number,
  (element: HTMLElement | null) => void,
  HTMLElement | null,
] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (!element) {
      setHeight(0);
      return;
    }
    const measure = () => setHeight(element.offsetHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [element]);

  return [height, setElement, element];
}

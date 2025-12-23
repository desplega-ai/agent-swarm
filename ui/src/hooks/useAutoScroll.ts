import { useEffect, useRef, useCallback } from "react";

/**
 * Auto-scroll hook that scrolls to bottom when dependencies change,
 * but only if the user was already at/near the bottom.
 * If user has scrolled up to read history, it won't interrupt them.
 *
 * @param element - The scrollable element ref
 * @param deps - Array of dependencies that trigger scroll check
 */
export function useAutoScroll(element: HTMLDivElement | null, deps: unknown[]) {
  const isNearBottomRef = useRef(true);
  const hasInitializedRef = useRef(false);

  // Track scroll position to determine if user is near bottom
  const handleScroll = useCallback(() => {
    if (element) {
      const { scrollTop, scrollHeight, clientHeight } = element;
      // Consider "near bottom" if within 100px of the bottom
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 100;
    }
  }, [element]);

  // Attach scroll listener
  useEffect(() => {
    if (!element) return;

    element.addEventListener("scroll", handleScroll);
    return () => element.removeEventListener("scroll", handleScroll);
  }, [element, handleScroll]);

  // Auto-scroll when dependencies change
  useEffect(() => {
    if (!element) return;

    const scrollToBottom = () => {
      setTimeout(() => {
        element.scrollTo({
          top: element.scrollHeight,
          behavior: hasInitializedRef.current ? "smooth" : "instant",
        });
      }, 50);
    };

    if (!hasInitializedRef.current) {
      // Initial load - scroll to bottom immediately
      scrollToBottom();
      hasInitializedRef.current = true;
    } else if (isNearBottomRef.current) {
      // Subsequent updates - only scroll if user was near bottom
      scrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, ...deps]);
}

import { useCallback, useEffect, useRef, useState } from "react";

interface UseAutoScrollResult {
  /** Whether auto-scroll is currently following new content */
  isFollowing: boolean;
  /** Manually scroll to bottom and re-enable auto-follow */
  scrollToBottom: () => void;
}

/**
 * Auto-scroll hook that scrolls to bottom when dependencies change,
 * but only if the user was already at/near the bottom.
 * If user has scrolled up to read history, it won't interrupt them.
 *
 * Returns state and controls to show a "Follow" button when auto-scroll is disabled.
 *
 * @param element - The scrollable element ref
 * @param deps - Array of dependencies that trigger scroll check
 * @returns Object with isFollowing state and scrollToBottom function
 */
export function useAutoScroll(
  element: HTMLDivElement | null,
  deps: unknown[],
): UseAutoScrollResult {
  const [isFollowing, setIsFollowing] = useState(true);
  const hasInitializedRef = useRef(false);

  // Track scroll position to determine if user is near bottom
  const handleScroll = useCallback(() => {
    if (element) {
      const { scrollTop, scrollHeight, clientHeight } = element;
      // Consider "near bottom" if within 100px of the bottom
      const nearBottom = scrollHeight - scrollTop - clientHeight < 100;
      setIsFollowing(nearBottom);
    }
  }, [element]);

  // Manual scroll to bottom function
  const scrollToBottom = useCallback(() => {
    if (element) {
      element.scrollTo({
        top: element.scrollHeight,
        behavior: "smooth",
      });
      setIsFollowing(true);
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

    const doScrollToBottom = () => {
      setTimeout(() => {
        element.scrollTo({
          top: element.scrollHeight,
          behavior: hasInitializedRef.current ? "smooth" : "instant",
        });
      }, 50);
    };

    if (!hasInitializedRef.current) {
      // Initial load - scroll to bottom immediately
      doScrollToBottom();
      hasInitializedRef.current = true;
      setIsFollowing(true);
    } else if (isFollowing) {
      // Subsequent updates - only scroll if user was near bottom
      doScrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, isFollowing, ...deps]);

  return { isFollowing, scrollToBottom };
}

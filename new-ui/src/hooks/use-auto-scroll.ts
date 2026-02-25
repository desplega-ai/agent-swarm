import { useCallback, useEffect, useRef, useState } from "react";

interface UseAutoScrollResult {
  isFollowing: boolean;
  scrollToBottom: () => void;
}

export function useAutoScroll(
  element: HTMLDivElement | null,
  deps: unknown[],
): UseAutoScrollResult {
  const [isFollowing, setIsFollowing] = useState(true);
  const hasInitializedRef = useRef(false);

  const handleScroll = useCallback(() => {
    if (element) {
      const { scrollTop, scrollHeight, clientHeight } = element;
      const nearBottom = scrollHeight - scrollTop - clientHeight < 100;
      setIsFollowing(nearBottom);
    }
  }, [element]);

  const scrollToBottom = useCallback(() => {
    if (element) {
      element.scrollTo({
        top: element.scrollHeight,
        behavior: "smooth",
      });
      setIsFollowing(true);
    }
  }, [element]);

  useEffect(() => {
    if (!element) return;

    element.addEventListener("scroll", handleScroll);
    return () => element.removeEventListener("scroll", handleScroll);
  }, [element, handleScroll]);

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
      doScrollToBottom();
      hasInitializedRef.current = true;
      setIsFollowing(true);
    } else if (isFollowing) {
      doScrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, isFollowing, ...deps]);

  return { isFollowing, scrollToBottom };
}

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

const NAV_SHORTCUTS: Record<string, string> = {
  "1": "/",
  "2": "/agents",
  "3": "/tasks",
  "4": "/chat",
  "5": "/schedules",
  "6": "/usage",
  "7": "/config",
  "8": "/repos",
  "9": "/services",
};

export function useKeyboardShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Skip when typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      // Number keys for nav (not with modifiers)
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const path = NAV_SHORTCUTS[e.key];
        if (path) {
          e.preventDefault();
          navigate(path);
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
}

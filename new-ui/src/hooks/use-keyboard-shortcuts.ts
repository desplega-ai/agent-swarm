import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

const NAV_SHORTCUTS: Record<string, string> = {
  "1": "/",
  "2": "/agents",
  "3": "/tasks",
  "4": "/epics",
  "5": "/chat",
  "6": "/schedules",
  "7": "/usage",
  "8": "/config",
  "9": "/repos",
  "0": "/services",
};

export function useKeyboardShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Skip when typing in inputs
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
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

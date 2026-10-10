/**
 * Open/closed state for the contextual session panel, shared by the header
 * toggle and the panel itself. Persisted per deployment; `Mod+I` toggles it.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useLocalToggle } from "@/hooks/use-local-toggle";

/**
 * `GET /api/sessions?contextKeyPrefix=` ships after 1.157.0. Older servers
 * ignore the param and would list every session in the dropdown.
 */
export const CONTEXT_PANEL_MIN_VERSION = "1.157.1";

interface ContextPanelState {
  supported: boolean;
  open: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
  /**
   * Session to select when the panel shows `pageKey` (set by `focusSession`).
   * Cleared when the panel closes, so it applies once.
   */
  focusedSession: { pageKey: string; rootTaskId: string } | undefined;
  /** Open the panel on a session created elsewhere, e.g. a page feedback send. */
  focusSession: (pageKey: string, rootTaskId: string) => void;
}

const ContextPanelContext = createContext<ContextPanelState | null>(null);

export function ContextPanelProvider({ children }: { children: ReactNode }) {
  const { supported } = useFeatureGate(CONTEXT_PANEL_MIN_VERSION);
  const [storedOpen, setStoredOpen] = useLocalToggle("context-panel:open", false);
  const [focusedSession, setFocusedSession] = useState<ContextPanelState["focusedSession"]>();
  const open = storedOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!next) setFocusedSession(undefined);
      setStoredOpen(next);
    },
    [setStoredOpen],
  );
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  const focusSession = useCallback(
    (pageKey: string, rootTaskId: string) => {
      setFocusedSession({ pageKey, rootTaskId });
      setStoredOpen(true);
    },
    [setStoredOpen],
  );

  useEffect(() => {
    if (!supported) return;
    function onKeyDown(e: KeyboardEvent) {
      // Editors (Monaco) claim Mod+I for their own commands and preventDefault it.
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        toggle();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [supported, toggle]);

  const value = useMemo(
    () => ({
      supported,
      open: supported && open,
      setOpen,
      toggle,
      focusedSession,
      focusSession,
    }),
    [supported, open, setOpen, toggle, focusedSession, focusSession],
  );
  return <ContextPanelContext.Provider value={value}>{children}</ContextPanelContext.Provider>;
}

export function useContextPanel(): ContextPanelState {
  const value = useContext(ContextPanelContext);
  if (!value) throw new Error("useContextPanel must be used inside <ContextPanelProvider>");
  return value;
}

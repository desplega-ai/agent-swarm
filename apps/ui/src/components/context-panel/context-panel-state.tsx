/**
 * Open/closed state for the contextual session panel, shared by the header
 * toggle and the panel itself. Persisted per deployment; `Mod+I` toggles it.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from "react";
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
}

const ContextPanelContext = createContext<ContextPanelState | null>(null);

export function ContextPanelProvider({ children }: { children: ReactNode }) {
  const { supported } = useFeatureGate(CONTEXT_PANEL_MIN_VERSION);
  const [open, setOpen] = useLocalToggle("context-panel:open", false);
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);

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
    () => ({ supported, open: supported && open, setOpen, toggle }),
    [supported, open, setOpen, toggle],
  );
  return <ContextPanelContext.Provider value={value}>{children}</ContextPanelContext.Provider>;
}

export function useContextPanel(): ContextPanelState {
  const value = useContext(ContextPanelContext);
  if (!value) throw new Error("useContextPanel must be used inside <ContextPanelProvider>");
  return value;
}

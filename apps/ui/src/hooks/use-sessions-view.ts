import { History, PanelsTopLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useStats } from "@/api/hooks/use-stats";
import { type CommandMenuItem, useCommandMenuGroup } from "@/components/shared/command-menu";
import { useLocalToggle } from "@/hooks/use-local-toggle";
import { useUrlSearchState } from "@/hooks/use-url-search-state";
import { SESSIONS_V2_MIN_VERSION } from "@/lib/sessions-v2";

export type SessionsViewMode = "legacy" | "v2";

export interface SessionsView {
  /** The view to render. `legacy` when the API cannot serve v2. */
  view: SessionsViewMode;
  /** The API serves v2. Offer the "New sessions view" link only then. */
  supported: boolean;
  /** The version check still runs. Render a skeleton, not a view that may flip. */
  pending: boolean;
  /** Pick the view for this browser (the stored preference). */
  setView: (view: SessionsViewMode) => void;
}

/**
 * Which sessions view this browser shows: the v2 view by default, the
 * legacy view after "Legacy sessions" (plan D3). `?legacy=1|0` is a
 * "switch to" link: it shows its view at once, becomes the preference, and
 * leaves the URL (a `replace`), so it never lingers and never fights a later
 * pick.
 *
 * Call it once per page and pass `setView` down. `useLocalToggle` syncs
 * other tabs only, so a second instance in this tab would see a switch only
 * after a reload.
 */
export function useSessionsView(): SessionsView {
  const gate = useFeatureGate(SESSIONS_V2_MIN_VERSION);
  // The gate reads dev mode from stats. Until stats load, an older version
  // reports "unsupported" and the page would flash the legacy view.
  const stats = useStats();
  const [legacyPref, setLegacyPref] = useLocalToggle("sessions:legacy", false);
  const { searchParams, setParam } = useUrlSearchState();
  const legacyParam = searchParams.get("legacy");
  const forced = legacyParam === "1" ? true : legacyParam === "0" ? false : null;

  // The router applies URL writes in a transition, so a render can still see
  // the param after it was dropped. The effect runs on `forced` changes only
  // (the setters ride a ref), so it stores each link once and never writes
  // back over a pick made after it.
  const writers = useRef({ setLegacyPref, setParam });
  writers.current = { setLegacyPref, setParam };
  useEffect(() => {
    if (forced === null) return;
    writers.current.setLegacyPref(forced);
    writers.current.setParam("legacy", null);
  }, [forced]);

  const setView = useCallback(
    (view: SessionsViewMode) => setLegacyPref(view === "legacy"),
    [setLegacyPref],
  );

  const pending =
    !gate.supported && !gate.isError && (gate.currentVersion == null || stats.isPending);
  const legacy = !gate.supported || (forced ?? legacyPref);
  return { view: legacy ? "legacy" : "v2", supported: gate.supported, pending, setView };
}

/** Adds the view switch ("Legacy sessions" or "New sessions view") to the Cmd+K palette. */
export function useSessionsViewCommand({ view, supported, setView }: SessionsView) {
  // Through a ref, so a new `setView` never registers the group again.
  const setViewRef = useRef(setView);
  setViewRef.current = setView;
  const items = useMemo<CommandMenuItem[]>(() => {
    if (!supported) return [];
    return view === "v2"
      ? [
          {
            id: "legacy",
            label: "Legacy sessions",
            icon: History,
            onSelect: () => setViewRef.current("legacy"),
          },
        ]
      : [
          {
            id: "v2",
            label: "New sessions view",
            icon: PanelsTopLeft,
            onSelect: () => setViewRef.current("v2"),
          },
        ];
  }, [view, supported]);
  useCommandMenuGroup("sessions", "Sessions", items);
}

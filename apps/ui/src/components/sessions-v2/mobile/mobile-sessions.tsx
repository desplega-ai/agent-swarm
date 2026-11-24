/**
 * The sessions v2 view on a phone (plan Phase 9, SPEC R8.5): below 768 px
 * the view is a stack of screens, as in Slack or Mail. The URL is the
 * stack, so browser back works:
 *
 * - `/sessions`: the list screen (the sidebar at full width).
 * - `/sessions?view=<list>`: "View all N" pushes the group screen.
 * - `/sessions/:id` (and `?view=` when it came from a group screen): the
 *   session's detail screen.
 * - `/sessions/new`: the New session screen. `?seed=` and `?prefill=` links
 *   land here too.
 * - `?asset=<tab>` on any of them: the asset screen (a file, a page, or a
 *   task that a link opened), over the screen the link is in. A desktop URL
 *   whose focused tab is an asset (`/sessions/asset:…`) shows it too.
 *
 * Pushed screens cover the screen and the app header. They slide in from
 * the right in 300 ms and back out in 250 ms on the swift curve, and only
 * fade under reduced motion. A back gesture that already played the
 * browser's own page swipe (iOS, `hasUAVisualTransition`) skips the slide.
 * The list stays mounted under them, so back returns to the same scroll
 * position. No tabs and no split. The pushed screens follow the
 * visual viewport, so the composer stays above the on-screen keyboard.
 */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { LinkPreviewOpener } from "@/components/link-preview/link-preview-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionsViewMode } from "@/hooks/use-sessions-view";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { assetTabId, type LinkPreviewTarget } from "@/lib/link-preview";
import { MAIN_BLEED } from "@/lib/main-gutter";
import { isAssetTab, NEW_SESSION_TAB, parseView } from "@/lib/sessions-v2";
import { cn } from "@/lib/utils";
import { FirstRunGuide, useFirstRunGuide } from "../first-run-guide";
import { NewSessionTab } from "../new-session-tab";
import type { SessionTreeHandle } from "../sidebar/session-tree";
import { AssetTab } from "../tabs/asset-tab";
import { MobileDetailScreen } from "./mobile-detail-screen";
import { MobileGroupScreen } from "./mobile-group-screen";
import { MobileListScreen } from "./mobile-list-screen";
import { MobileTopBar } from "./mobile-top-bar";

/** DESIGN.md: the phone push is the large-surface exception, on the swift curve. */
const SWIFT = [0.32, 0.72, 0, 1] as const;
const SNAPPY = [0.2, 0, 0, 1] as const;

/** A history entry this view pushed: the back chevron can go back to it. */
interface PushState {
  phonePush?: boolean;
}

/** The pushed screen's slide, a fade under reduced motion, and none after a browser back swipe. */
const PUSH = {
  initial: ({ reduce }: PushCustom) => (reduce ? { opacity: 0 } : { x: "100%" }),
  animate: ({ reduce }: PushCustom) =>
    reduce
      ? { opacity: 1, transition: { duration: 0.15, ease: SNAPPY } }
      : { x: 0, transition: { duration: 0.3, ease: SWIFT } },
  exit: ({ reduce, instant }: PushCustom) =>
    instant
      ? { opacity: 0, transition: { duration: 0 } }
      : reduce
        ? { opacity: 0, transition: { duration: 0.15, ease: SNAPPY } }
        : { x: "100%", transition: { duration: 0.25, ease: SWIFT } },
};

interface PushCustom {
  reduce: boolean;
  /** The browser already animated this back: change the screen at once. */
  instant: boolean;
}

/** A keyboard takes this much height or more. Browser bars take less. */
const KEYBOARD_MIN_HEIGHT = 200;

/**
 * The visual viewport box while the on-screen keyboard is open, else null.
 * A pushed screen fills that box, so the keyboard shrinks it and the
 * composer stays in view (iOS does not resize `dvh` for the keyboard).
 *
 * With no keyboard the screen uses plain CSS (the top edge and `dvh`), as
 * the app shell does. The offset of the visual viewport is not used then:
 * browsers that hide their bars on scroll (Brave on iOS) report an offset
 * while the page still starts at the top, which moved the screen down and
 * showed the list above it.
 */
function useKeyboardViewport() {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const keyboard = window.innerHeight - viewport.height > KEYBOARD_MIN_HEIGHT;
      setBox((prev) => {
        if (!keyboard) return null;
        if (prev && prev.top === viewport.offsetTop && prev.height === viewport.height) return prev;
        return { top: viewport.offsetTop, height: viewport.height };
      });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return box;
}

/**
 * `hasUAVisualTransition` of the last popstate. A capture listener runs
 * before the router's own, so the flag is set when the screen changes.
 */
function useBrowserBackSwipe() {
  const [instant, setInstant] = useState(false);
  useEffect(() => {
    const onPop = (event: PopStateEvent & { hasUAVisualTransition?: boolean }) =>
      setInstant(event.hasUAVisualTransition === true);
    window.addEventListener("popstate", onPop, true);
    return () => window.removeEventListener("popstate", onPop, true);
  }, []);
  return [instant, setInstant] as const;
}

function PushedScreen({
  label,
  custom,
  children,
}: {
  label: string;
  custom: PushCustom;
  children: ReactNode;
}) {
  const keyboard = useKeyboardViewport();
  const ref = useRef<HTMLElement>(null);
  // A push moves the focus to the new screen (the list under it goes inert).
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <motion.section
      ref={ref}
      aria-label={label}
      tabIndex={-1}
      custom={custom}
      variants={PUSH}
      initial="initial"
      animate="animate"
      exit="exit"
      data-keyboard={keyboard ? "open" : undefined}
      style={keyboard ? { top: keyboard.top, height: keyboard.height } : undefined}
      // `touch-manipulation`: a double tap does not zoom the page in.
      // `overscroll-contain`: a scroll at the end of the screen does not move the page under it.
      // `after:`: the screen's fill goes on below it, so the list does not show
      // between the screen and the keyboard (under the bars iOS floats there).
      className="group/screen fixed inset-x-0 top-0 z-40 flex h-dvh touch-manipulation flex-col overscroll-contain bg-background shadow-xl outline-none after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-screen after:bg-background"
    >
      {children}
    </motion.section>
  );
}

/**
 * A pop gives the focus back to the screen under it: to the row of the
 * session that was open, else to that screen's list.
 */
function useFocusOnPop(state: {
  sessionId: string | null;
  groupView: string | null;
  isNew: boolean;
}) {
  const previous = useRef(state);
  const { sessionId, groupView, isNew } = state;
  useEffect(() => {
    const before = previous.current;
    previous.current = { sessionId, groupView, isNew };
    const topClosed = (before.sessionId !== null || before.isNew) && sessionId === null && !isNew;
    const groupClosed = before.groupView !== null && groupView === null && sessionId === null;
    if (!topClosed && !groupClosed) return;
    const screen = document.querySelector<HTMLElement>(
      `[data-phone-screen="${groupView && !groupClosed ? "group" : "list"}"]`,
    );
    const row = before.sessionId
      ? screen?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(before.sessionId)}"]`)
      : null;
    const list = screen?.querySelector<HTMLElement>("[role=tree], ul");
    (row ?? list ?? screen)?.focus({ preventScroll: true });
  }, [sessionId, groupView, isNew]);
}

export function MobileSessions({
  onViewChange,
}: {
  /** Switch views. The page owns the one `useSessionsView()` instance. */
  onViewChange: (view: SessionsViewMode) => void;
}) {
  const { rootTaskId } = useParams<{ rootTaskId: string }>();
  const [searchParams] = useSearchParams();
  const { setParam } = useUrlSearchState();
  const navigate = useNavigate();
  const location = useLocation();
  const reduce = useReducedMotion() ?? false;
  const [instant, setInstant] = useBrowserBackSwipe();
  const guide = useFirstRunGuide();
  const treeRef = useRef<SessionTreeHandle>(null);

  const view = parseView(searchParams.get("view"));
  const q = readStringParam(searchParams, "q");
  const isNew = rootTaskId === NEW_SESSION_TAB;
  // The asset screen: `?asset=`, or a desktop URL whose focused tab is an asset.
  const routeAsset = rootTaskId && isAssetTab(rootTaskId) ? rootTaskId : null;
  const assetParam = readStringParam(searchParams, "asset");
  const asset = routeAsset ?? (isAssetTab(assetParam) ? assetParam : null);
  const sessionId = rootTaskId && !isNew && !routeAsset ? rootTaskId : null;
  const pushed = (location.state as PushState | null)?.phonePush === true;

  /** A URL in this stack. The desktop tabs and split do not apply here. */
  const href = useCallback(
    (path: string, nextView: string | null) => {
      const params = new URLSearchParams(searchParams);
      params.delete("tabs");
      params.delete("split");
      params.delete("splitFocus");
      params.delete("asset");
      // A seed or a template prefill belongs to the New session screen only:
      // carried back to the list, it would send the user to that screen again.
      if (path !== `/sessions/${NEW_SESSION_TAB}`) {
        params.delete("seed");
        params.delete("prefill");
      }
      if (nextView) params.set("view", nextView);
      else params.delete("view");
      // The group screen's Overview or list (`?tab=`) belongs to its group.
      if (nextView !== view) params.delete("tab");
      const qs = params.toString();
      return `${path}${qs ? `?${qs}` : ""}`;
    },
    [searchParams, view],
  );
  const push = (to: string) => {
    setInstant(false);
    void navigate(to, { state: { phonePush: true } satisfies PushState });
  };

  // A `?seed=` or `?prefill=` link opens the New session screen.
  const seeded = searchParams.has("seed") || searchParams.has("prefill");
  useEffect(() => {
    if (seeded && !rootTaskId) void navigate(href("/sessions/new", null), { replace: true });
  }, [seeded, rootTaskId, navigate, href]);

  // The group a New session starts in: the one it was opened from.
  const [startIn, setStartIn] = useState<string | null>(null);
  const openSession = (id: string) =>
    push(href(`/sessions/${encodeURIComponent(id)}`, sessionId ? null : view));
  const openView = (next: string) => push(href("/sessions", next));
  const newSession = (group: string | null = null) => {
    setStartIn(group);
    push(href(`/sessions/${NEW_SESSION_TAB}`, null));
  };
  /** A link in a screen: its file, page, or task opens as the asset screen over it. */
  const openAsset = (target: LinkPreviewTarget) => {
    const params = new URLSearchParams(searchParams);
    params.set("asset", assetTabId(target, asset ?? sessionId));
    push(`${routeAsset ? "/sessions" : location.pathname}?${params.toString()}`);
  };
  /** Back: to the entry this view pushed, else up one screen (a deep link). */
  const back = () => {
    setInstant(false);
    if (pushed) void navigate(-1);
    else if (asset && !routeAsset) {
      // A deep link to an asset: back shows the screen under it.
      const params = new URLSearchParams(searchParams);
      params.delete("asset");
      const qs = params.toString();
      void navigate(`${location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
    } else void navigate(href("/sessions", rootTaskId ? view : null), { replace: true });
  };

  const top = sessionId ? "detail" : isNew ? "new" : null;
  // The group screen stays under a session opened from it.
  const groupView = view && !isNew ? view : null;
  const custom: PushCustom = { reduce, instant };
  useFocusOnPop({ sessionId, groupView, isNew });
  const move = (sessions: Parameters<SessionTreeHandle["move"]>[0], returnFocus: () => void) =>
    treeRef.current?.move(sessions, returnFocus);

  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={300}>
      <LinkPreviewOpener open={openAsset}>
        <div className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden", MAIN_BLEED)}>
          <MobileListScreen
            covered={groupView !== null || top !== null || asset !== null}
            focused={sessionId ?? ""}
            query={q}
            setQuery={(next) => setParam("q", next)}
            openSession={openSession}
            newSession={newSession}
            setView={openView}
            onViewChange={onViewChange}
            showGuide={() => guide.open(0)}
            treeRef={treeRef}
          />
          <AnimatePresence initial={false} custom={custom}>
            {groupView ? (
              <PushedScreen key="group" label="Group" custom={custom}>
                <MobileGroupScreen
                  view={groupView}
                  covered={top !== null || asset !== null}
                  onBack={back}
                  onOpen={openSession}
                  onMove={move}
                />
              </PushedScreen>
            ) : null}
          </AnimatePresence>
          <AnimatePresence initial={false} custom={custom}>
            {top ? (
              // One screen for both: Send turns the New session screen into the session.
              <PushedScreen
                key="top"
                label={top === "new" ? "New session" : "Session"}
                custom={custom}
              >
                {sessionId ? (
                  <MobileDetailScreen
                    key={sessionId}
                    rootTaskId={sessionId}
                    onBack={back}
                    onMove={move}
                  />
                ) : (
                  <>
                    <MobileTopBar onBack={back} backLabel="Cancel">
                      <h1 className="truncate text-base font-semibold">New session</h1>
                    </MobileTopBar>
                    <div className="flex min-h-0 flex-1 flex-col">
                      <NewSessionTab
                        touch
                        startIn={startIn}
                        onStarted={(id) =>
                          void navigate(href(`/sessions/${encodeURIComponent(id)}`, null), {
                            replace: true,
                            state: { phonePush: pushed } satisfies PushState,
                          })
                        }
                      />
                    </div>
                  </>
                )}
              </PushedScreen>
            ) : null}
          </AnimatePresence>
          <AnimatePresence initial={false} custom={custom}>
            {asset ? (
              // The phone has no tabs and no split: an asset is one more screen.
              <PushedScreen key="asset" label="Preview" custom={custom}>
                <AssetTab key={asset} tab={asset} onBack={back} />
              </PushedScreen>
            ) : null}
          </AnimatePresence>
          <FirstRunGuide phone state={guide.state} onStep={guide.setStep} onClose={guide.close} />
        </div>
      </LinkPreviewOpener>
    </TooltipProvider>
  );
}

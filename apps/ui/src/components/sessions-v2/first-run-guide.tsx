/**
 * The first-run guide (plan Phase 8, SPEC R4, R6): a Dialog with 4 steps.
 * The sidebar, tabs and split, Done and Later, then search, keys, and the
 * Legacy view. There is no sources step. Next, Back, Skip, and the arrow
 * keys move through it.
 *
 * A fresh browser shows it once: "Don't show again" starts checked on that
 * first open, and a close with the box checked stores "off" in
 * localStorage. Unchecked, it shows again on the next visit. `?guide=1`
 * opens it, and `?guide=0` skips it for that load (a deep link); both leave
 * the URL. A first open waits until a dashboard user is picked and no other
 * dialog is open, so one modal shows at a time. It never opens by itself
 * while the onboarding first task runs, or in a page load that went through
 * `/setup`: the user watches their own first task. The Keys button and `?`
 * (with Shift, so the key listener allows Shift for this one key) open the
 * keys step. Cmd+K has "Show the guide". Closing it gives the focus back.
 *
 * On a phone (`phone`, SPEC R8.5) it is a bottom sheet with 3 short cards
 * for touch: the list, swipe and long-press, then search and the Legacy
 * view. No tabs, no keys.
 */

import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { isOnboardingOpen, useOnboarding } from "@/api/hooks/use-onboarding";
import { wasSetupVisited } from "@/components/onboarding/onboarding-redirect";
import { MOD, useKeyboardShortcuts } from "@/components/shared/questions/keyboard";
import {
  ResponsiveOverlay,
  ResponsiveOverlayContent,
} from "@/components/shared/responsive-overlay";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { isTypingTarget, OPEN_OVERLAY, type ShortcutKeyEvent } from "@/lib/approval-shortcuts";
import { cn } from "@/lib/utils";
import { focusQuietly } from "./pane/quiet-focus";
import { useLastValue } from "./sidebar/point-menu";
import { NeedsYouBadge, ReadMark, UNREAD_TITLE } from "./sidebar/tree-row";
import { LETTER_KEYS } from "./use-list-keys";

const STORAGE_KEY = "agent-swarm-sessions-v2-guide";

function storedOff(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "off";
  } catch {
    return false;
  }
}

function storeOff(off: boolean) {
  try {
    if (off) localStorage.setItem(STORAGE_KEY, "off");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage is off: the guide shows again next time.
  }
}

/** The open guide: its step, and whether this is the first-run open. */
export interface GuideState {
  step: number;
  firstRun: boolean;
}

/** A sample of sidebar rows: the read mark and the activity marks. */
function RowsSample() {
  const rows = [
    { title: "Streaming XML parser spike", unread: true, note: "Unread" },
    { title: "Weekly price digest", unread: false, note: "Read" },
    {
      title: "Scrape the supplier price feed",
      unread: false,
      note: "Running",
      mark: <TaskStatusIcon variant="active" className="size-3.5" />,
    },
    {
      title: "Move the swarm to the new server",
      unread: false,
      mark: <NeedsYouBadge>Needs you</NeedsYouBadge>,
    },
  ];
  return (
    <div
      aria-hidden
      className="mt-3 flex flex-col gap-0.5 rounded-lg border border-border-subtle bg-surface p-1.5"
    >
      {rows.map((row) => (
        <div key={row.title} className="flex h-[26px] items-center gap-1.5 px-1.5 text-data">
          <ReadMark unread={row.unread} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              row.unread ? UNREAD_TITLE : "text-muted-foreground",
            )}
          >
            {row.title}
          </span>
          {row.mark}
          {row.note ? <span className="text-meta text-muted-foreground">{row.note}</span> : null}
        </div>
      ))}
    </div>
  );
}

/** The keys step: the list keys (one shared table with the key map), then search, actions, and Escape. */
const KEYS: [string[], string][] = [
  ...LETTER_KEYS.reduce<[string[], string][]>((rows, { key, label, cap }) => {
    const last = rows.at(-1);
    const keycap = cap ?? key.toUpperCase();
    if (last && last[1] === label) last[0].push(keycap);
    else rows.push([[keycap], label]);
    return rows;
  }, []),
  [["/"], "Search"],
  [[`${MOD}K`], "Actions"],
  [["Esc"], "Clear"],
];

function KeysSample() {
  return (
    <dl className="mt-3 grid grid-cols-[auto_1fr_auto_1fr] items-center gap-x-2.5 gap-y-1.5 text-data">
      {KEYS.map(([keys, label]) => (
        <div key={label} className="contents">
          <dt className="flex justify-end gap-1">
            {keys.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </dt>
          <dd className="m-0 text-muted-foreground">{label}</dd>
        </div>
      ))}
    </dl>
  );
}

const STEPS = [
  {
    title: "Sessions live in the sidebar",
    body: "Inbox, Later, Done, and each group open in place, newest first. A long list shows its 10 newest, and View all opens the whole list in a tab. A bold title with a dot is unread.",
    sample: <RowsSample />,
  },
  {
    title: "Tabs and split",
    body: "A click opens a session in the current tab. A middle-click or T opens a new tab. Drag a tab to the right edge, or press V, to split the view.",
  },
  {
    title: "Done and Later",
    body: "Done takes a session out of your Inbox. Later snoozes it, and this browser tells you when it comes back.",
  },
  {
    title: "Search, keys, and the Legacy view",
    body: `Press / to search titles and first messages. with: finds people (with:lena). Try is:unread too. ${MOD}K runs actions, and Legacy sessions opens the old view.`,
    sample: <KeysSample />,
  },
];

/** The phone cards: touch words, no tabs, no keys. */
const PHONE_STEPS = [
  {
    title: "One list for every session",
    body: "Inbox, Later, Done, and your groups, newest first. Tap a group to open it. A bold title with a dot is unread.",
    sample: <RowsSample />,
  },
  {
    title: "Swipe and long-press",
    body: "Swipe a session left for Done, or right for Later. Long-press a session to select more. Then mark them Done, Later, or read. You can also move them.",
  },
  {
    title: "Search and the Legacy view",
    body: "Tap the search field for chips such as with: and is:unread. The ⋯ menu at the top opens the Legacy view and this guide.",
  },
];

/** The keys step: the Keys button and `?` open it. */
export const GUIDE_KEYS_STEP = STEPS.length - 1;

/** `?` with no other modifier than Shift, outside text fields and open overlays. */
function matchHelp(event: ShortcutKeyEvent, { overlayOpen }: { overlayOpen: boolean }) {
  if (event.key !== "?" || event.defaultPrevented || event.isComposing || event.repeat) return null;
  if (event.metaKey || event.ctrlKey || event.altKey || overlayOpen) return null;
  return isTypingTarget(event.target) ? null : ("keys" as const);
}

/**
 * The guide's state: `?guide=`, the first-run open, and the `?` key. Mount
 * it once in the v2 shell.
 */
export function useFirstRunGuide() {
  const [searchParams, setSearchParams] = useSearchParams();
  const param = searchParams.get("guide");
  const { state: userState } = useCurrentUser();
  // The first render decides: `?guide=1` opens it, `?guide=0` skips it for
  // this load, else a first visit opens it. It waits in `waiting` until a
  // user is picked and no other dialog shows (the identity dialog first).
  const [waiting, setWaiting] = useState<GuideState | null>(() => {
    if (param === "1") return { step: 0, firstRun: false };
    if (param === "0" || storedOff()) return null;
    return { step: 0, firstRun: true };
  });
  const [state, setState] = useState<GuideState | null>(null);
  // Setup holds the first-run open: while its first task runs (a reload on
  // that session), and in the page load that went through `/setup`. Null
  // until the onboarding payload answers.
  const { config } = useConfig();
  const onboarding = useOnboarding();
  const setupHolds = onboarding.isPending
    ? null
    : Boolean(isOnboardingOpen(onboarding.data) && onboarding.data?.state.firstTaskId) ||
      wasSetupVisited(config.apiUrl);
  useEffect(() => {
    if (param !== "1" && param !== "0") return;
    if (param === "1") setWaiting((prev) => prev ?? { step: 0, firstRun: false });
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("guide");
        return next;
      },
      { replace: true },
    );
  }, [param, setSearchParams]);
  useEffect(() => {
    if (!waiting || userState !== "ready" || setupHolds === null) return;
    // Dropped, not deferred: the guide must not pop up when setup finishes.
    // `?guide=1` still opens it.
    if (waiting.firstRun && setupHolds) {
      setWaiting(null);
      return;
    }
    const show = () => {
      // Another dialog or its closing fade is on screen: try again soon.
      if (document.querySelector(OPEN_OVERLAY)) return false;
      setState(waiting);
      setWaiting(null);
      return true;
    };
    if (show()) return;
    const timer = window.setInterval(() => {
      if (show()) window.clearInterval(timer);
    }, 200);
    return () => window.clearInterval(timer);
  }, [waiting, userState, setupHolds]);
  useKeyboardShortcuts(
    matchHelp,
    () => {
      setState({ step: GUIDE_KEYS_STEP, firstRun: false });
      return true;
    },
    state === null,
  );
  return {
    state,
    open: (step = 0) => {
      setWaiting(null);
      setState({ step, firstRun: false });
    },
    setStep: (step: number) => setState((prev) => (prev ? { ...prev, step } : prev)),
    close: () => setState(null),
  };
}

export function FirstRunGuide({
  state,
  onStep,
  onClose,
  phone = false,
}: {
  state: GuideState | null;
  onStep: (step: number) => void;
  onClose: () => void;
  /** The phone cards in a bottom sheet. */
  phone?: boolean;
}) {
  const steps = phone ? PHONE_STEPS : STEPS;
  // The last state stays while the dialog fades out.
  const shown = useLastValue(state);
  const nextRef = useRef<HTMLButtonElement>(null);
  // The control that had the focus before the guide: it gets the focus back.
  const returnTo = useRef<Element | null>(null);
  const offId = useId();
  // "Don't show again": checked on the first-run open, else the stored value.
  const [off, setOff] = useState(false);
  const [openedAs, setOpenedAs] = useState<GuideState | null>(null);
  if (state && !openedAs) {
    setOpenedAs(state);
    setOff(state.firstRun || storedOff());
  } else if (!state && openedAs) setOpenedAs(null);

  if (!shown) return null;
  const step = Math.min(shown.step, steps.length - 1);
  const current = steps[step];
  const last = step === steps.length - 1;
  const close = () => {
    storeOff(off);
    onClose();
  };
  const go = (to: number) => {
    if (to < 0) return;
    if (to >= steps.length) close();
    else {
      onStep(to);
      nextRef.current?.focus();
    }
  };
  // The arrow keys stop at the first and the last step: only Done and Skip close it.
  const arrow = (to: number) => {
    if (to >= 0 && to < steps.length) go(to);
  };

  return (
    <ResponsiveOverlay
      desktop="dialog"
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <ResponsiveOverlayContent
        showCloseButton={false}
        className="gap-0 sm:max-w-[430px]"
        drawerClassName="gap-0 pb-1"
        onOpenAutoFocus={(event) => {
          // The focus has not moved yet: remember where it was.
          returnTo.current = document.activeElement;
          event.preventDefault();
          nextRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const back = returnTo.current;
          returnTo.current = null;
          if (back instanceof HTMLElement && back.isConnected) focusQuietly(back);
        }}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.target instanceof Element && event.target.closest("[role=checkbox]")) return;
          if (event.key === "ArrowRight") arrow(step + 1);
          else if (event.key === "ArrowLeft") arrow(step - 1);
          else return;
          event.preventDefault();
        }}
      >
        {/* A step change is read out: the focus stays on Next while the text changes. */}
        <div aria-live="polite" aria-atomic="true">
          <p className="flex items-center gap-2.5 font-mono text-meta tracking-[0.12em] text-muted-foreground uppercase">
            <span aria-hidden className="flex gap-1">
              {steps.map((item, i) => (
                <span
                  key={item.title}
                  className={cn("size-1.5 rounded-full bg-border", i === step && "bg-primary")}
                />
              ))}
            </span>
            Step {step + 1} of {steps.length}
          </p>
          <DialogTitle className="mt-2.5 text-base">{current.title}</DialogTitle>
          <DialogDescription className="mt-1.5 leading-relaxed">{current.body}</DialogDescription>
        </div>
        {current.sample ?? null}
        <DialogFooter
          className={cn(
            "mt-5 flex-row items-center gap-1.5 sm:justify-start",
            phone && "flex-wrap [&_[data-slot=button]]:h-11",
          )}
        >
          <div className={cn("mr-auto flex items-center gap-2", phone && "h-11 w-full")}>
            <Checkbox
              id={offId}
              checked={off}
              onCheckedChange={(checked) => setOff(checked === true)}
            />
            <Label htmlFor={offId} className="text-xs font-normal text-muted-foreground">
              Don't show again
            </Label>
          </div>
          <Button size="sm" variant="ghost" onClick={close} className={cn(phone && "mr-auto")}>
            Skip
          </Button>
          <Button size="sm" variant="outline" disabled={step === 0} onClick={() => go(step - 1)}>
            Back
          </Button>
          <Button ref={nextRef} size="sm" onClick={() => go(step + 1)}>
            {last ? "Done" : "Next"}
          </Button>
        </DialogFooter>
      </ResponsiveOverlayContent>
    </ResponsiveOverlay>
  );
}

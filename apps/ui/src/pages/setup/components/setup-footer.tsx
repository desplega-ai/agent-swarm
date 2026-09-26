import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SETUP_COLUMN } from "./setup-layout";

/** A blocked action stays focusable and hoverable, so its tooltip can say why. */
const ARIA_DISABLED = "aria-disabled:opacity-50 aria-disabled:active:scale-100";

interface SetupFooterProps {
  /** Omit to disable Back (step 1). */
  onBack?: () => void;
  /** Work in flight (for example "Saving…"): a spinner with this tooltip shows left of Skip. */
  pending: string | null;
  /** Omit to hide Skip (step 1, no connection yet, or a done step). */
  skip?: {
    label: string;
    onSkip: () => void;
    /** Why Skip is not available now. Null when it is. */
    blockedBy: string | null;
    hint?: string;
  };
  /**
   * `blockedBy` disables the action and becomes its tooltip. `enterKey` binds
   * the Enter shortcut (Continue only, never "Go to dashboard").
   */
  primary: { label: string; onClick: () => void; blockedBy: string | null; enterKey?: boolean };
  busy?: boolean;
}

/**
 * Fixed bottom bar: Back on the left; a spinner for work in flight, Skip, and
 * the primary action on the right. Enter, S, and Escape run Continue, Skip,
 * and Back while focus is outside a field or an open overlay.
 */
export function SetupFooter({ onBack, pending, skip, primary, busy }: SetupFooterProps) {
  const back = onBack && !busy ? onBack : undefined;
  const skipNow = skip && !skip.blockedBy && !busy ? skip.onSkip : undefined;
  const next = primary.enterKey && !primary.blockedBy && !busy ? primary.onClick : undefined;
  useSetupShortcuts({ back, skip: skipNow, next });

  return (
    <footer className="shrink-0 border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
      <div className={cn(SETUP_COLUMN, "relative flex h-14 items-center gap-2")}>
        {/* Step 1 has nothing to go back to, so it shows no Back at all
            rather than a dead control. */}
        {onBack ? (
          <Hint content={back ? "Back (Esc)" : undefined}>
            <Button variant="ghost" onClick={onBack} disabled={busy} aria-keyshortcuts="Escape">
              <ArrowLeft />
              Back
              <Keycap>Esc</Keycap>
            </Button>
          </Hint>
        ) : null}
        <span className="flex-1" />
        {/* `popLayout`: the spinner comes and goes in place, the buttons never move. */}
        <AnimatePresence mode="popLayout" initial={false}>
          {pending ? (
            <motion.span
              key="pending"
              role="img"
              aria-label={pending}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.1 } }}
              transition={{ type: "spring", stiffness: 600, damping: 30 }}
              className="mr-1 flex"
            >
              <Hint content={pending}>
                <Loader2 className="size-[18px] animate-spin text-muted-foreground" />
              </Hint>
            </motion.span>
          ) : null}
        </AnimatePresence>
        {skip ? (
          <Hint content={skip.blockedBy ?? (skip.hint ? `Skip (S). ${skip.hint}` : "Skip (S)")}>
            <Button
              variant="ghost"
              onClick={skip.blockedBy ? undefined : skip.onSkip}
              aria-disabled={skip.blockedBy ? true : undefined}
              disabled={busy}
              aria-keyshortcuts="S"
              className={cn(ARIA_DISABLED, "aria-disabled:hover:bg-transparent")}
            >
              {skip.label}
              <Keycap>S</Keycap>
            </Button>
          </Hint>
        ) : null}
        <Hint
          content={primary.blockedBy ?? (primary.enterKey ? `${primary.label} (Enter)` : undefined)}
        >
          <Button
            onClick={primary.blockedBy ? undefined : primary.onClick}
            aria-disabled={primary.blockedBy ? true : undefined}
            disabled={busy}
            aria-keyshortcuts={primary.enterKey ? "Enter" : undefined}
            className={cn(ARIA_DISABLED, "aria-disabled:hover:bg-primary")}
          >
            {primary.label}
            {primary.enterKey ? <Keycap tone="inverted">↵</Keycap> : null}
            <ArrowRight />
          </Button>
        </Hint>
      </div>
    </footer>
  );
}

/**
 * The shortcut on its button. Hidden below 640 px (touch). A button that is
 * not available dims as a whole, so its keycap dims with it.
 */
function Keycap({ tone, children }: { tone?: "inverted"; children: string }) {
  return (
    <Kbd aria-hidden tone={tone} className="hidden sm:inline-flex">
      {children}
    </Kbd>
  );
}

/**
 * Focus in one of these types text or picks from a list: letters, Enter, and
 * Escape belong to the control.
 */
const TYPING_TARGET =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"], [role="listbox"], [role="menu"], [role="option"]';
/** An open popover, dropdown, select, or dialog owns the keyboard. */
const OPEN_OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
/** Enter already activates a focused control. */
const CONTROL_TARGET =
  'button, a[href], summary, [role="button"], [role="link"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"]';

function shortcutBlocked(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.repeat) return true;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true;
  if (document.querySelector(OPEN_OVERLAY)) return true;
  // Escape closes an open tooltip first.
  if (event.key === "Escape" && document.querySelector('[role="tooltip"]')) return true;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(TYPING_TARGET)) return true;
  return event.key === "Enter" && Boolean(target?.closest(CONTROL_TARGET));
}

/** Enter = Continue, S = Skip, Escape = Back. A missing handler means "not available now". */
function useSetupShortcuts(handlers: { back?: () => void; skip?: () => void; next?: () => void }) {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const { back, skip, next } = latest.current;
      const run =
        event.key === "Enter"
          ? next
          : event.key === "s" || event.key === "S"
            ? skip
            : event.key === "Escape"
              ? back
              : undefined;
      if (!run || shortcutBlocked(event)) return;
      event.preventDefault();
      run();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/**
 * A top tooltip around `children`. The tooltip stays mounted and only its
 * `open` changes, so a trigger never remounts (and never drops focus) when
 * the text comes and goes.
 */
function Hint({ content, children }: { content?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={Boolean(content) && open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {content ? (
        <TooltipContent side="top" sideOffset={6} className="max-w-64">
          {content}
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}

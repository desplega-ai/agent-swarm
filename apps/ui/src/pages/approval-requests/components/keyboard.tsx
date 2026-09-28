import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { modKeyLabel, OPEN_OVERLAY, type ShortcutKeyEvent } from "@/lib/approval-shortcuts";
import { cn } from "@/lib/utils";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Mouse/trackpad devices: the only place keyboard hints are shown. */
export function useFinePointer(): boolean {
  return useMediaQuery("(hover: hover) and (pointer: fine)");
}

/** Keycaps only on hover-capable fine pointers (hidden on touch). */
const FINE_POINTER_ONLY = "hidden [@media(hover:hover)_and_(pointer:fine)]:inline-flex";

/** A keycap next to a control. Decorative: the control carries `aria-keyshortcuts`. */
export function KeyHint({
  children,
  tone,
  className,
}: {
  children: string;
  tone?: "default" | "inverted";
  className?: string;
}) {
  return (
    <Kbd aria-hidden tone={tone} className={cn(FINE_POINTER_ONLY, className)}>
      {children}
    </Kbd>
  );
}

export const MOD = modKeyLabel();

/**
 * One window keydown listener mapped through a pure matcher. The matcher
 * owns every guard (text fields, modifiers, open overlays); the handler only
 * runs matched actions.
 */
export function useKeyboardShortcuts<A>(
  match: (event: ShortcutKeyEvent, context: { overlayOpen: boolean }) => A | null,
  onAction: (action: A, event: KeyboardEvent) => boolean | undefined,
  enabled = true,
) {
  const latest = useRef({ match, onAction });
  useLayoutEffect(() => {
    latest.current = { match, onAction };
  });
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      // Escape closes an open tooltip first.
      if (event.key === "Escape" && document.querySelector('[role="tooltip"]')) return;
      const overlayOpen = Boolean(document.querySelector(OPEN_OVERLAY));
      const action = latest.current.match(event, { overlayOpen });
      if (action === null) return;
      // A handler returns false when the action does not apply right now.
      if (latest.current.onAction(action, event) === false) return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

const SHEET_GROUPS: { title: string; rows: { keys: string[]; label: string }[] }[] = [
  {
    title: "Move",
    rows: [
      { keys: ["J", "↓"], label: "Next question" },
      { keys: ["K", "↑"], label: "Previous question" },
      { keys: ["O"], label: "Open or close an answered card" },
      { keys: ["Esc"], label: "Leave a text field, then back to the list" },
    ],
  },
  {
    title: "Answer the focused question",
    rows: [
      { keys: ["A"], label: "Approve" },
      { keys: ["R"], label: "Reject" },
      { keys: ["1", "–", "9"], label: "Pick an option (Yes / No are 1 / 2)" },
      { keys: ["←", "→"], label: "Move the option highlight (multi-select)" },
      { keys: ["Space"], label: "Toggle the highlighted option (multi-select)" },
      { keys: ["↵"], label: "Type into a text question" },
    ],
  },
  {
    title: "Finish",
    rows: [
      { keys: [MOD, "↵"], label: "Submit (works inside text fields)" },
      { keys: ["?"], label: "This sheet" },
    ],
  },
];

export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Single keys work while focus is outside a text field.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {SHEET_GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                {group.title}
              </h3>
              <dl className="flex flex-col">
                {group.rows.map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between gap-3 border-b border-border-subtle py-1.5 text-sm last:border-b-0"
                  >
                    <dt className="min-w-0 text-muted-foreground">{row.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {row.keys.map((key) =>
                        key === "–" ? (
                          <span key={key} className="text-xs text-muted-foreground">
                            –
                          </span>
                        ) : (
                          <Kbd key={key}>{key}</Kbd>
                        ),
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

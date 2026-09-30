import { MessageSquarePlus } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  anchorFromRange,
  type DomTextSpace,
  type NewCommentAnchor,
} from "@/lib/comb/dom-text-space";
import { CommentComposer } from "./comment-composer";
import { useCommentContext } from "./comment-context";
import { QuoteExcerpt } from "./quote-excerpt";

interface Selected {
  range: Range;
  /** Set once the human clicks "Comment": the composer is open. */
  anchor: NewCommentAnchor | null;
}

interface SelectionCommentButtonProps {
  rootRef: RefObject<HTMLElement | null>;
  /** The pane's text space. Null: the pane shows no text with source lines. */
  space: DomTextSpace | null;
  /** The passage being commented on, so the page keeps it highlighted while typing. */
  onPendingChange: (range: Range | null) => void;
}

// The "C" shortcut does not fire while the human types or another overlay is
// open (the dashboard shortcut rules). This popover is a dialog too.
const TYPING_TARGET =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="combobox"], [role="listbox"], [role="menu"], [role="option"]';
const OPEN_OVERLAY =
  '[role="dialog"][data-state="open"]:not([data-comb-selection]), [role="menu"], [role="listbox"]';

/**
 * A "Comment" button next to a text selection in the viewer pane. It opens
 * the composer in place, anchored to the selected passage (the quote with 32
 * characters of context, and the source lines of the blocks it spans). While
 * the button shows, "C" does the same (keyboard selections: caret browsing).
 */
export function SelectionCommentButton({
  rootRef,
  space,
  onPendingChange,
}: SelectionCommentButtonProps) {
  const { readOnly, renderComposerExtras } = useCommentContext();
  const [selected, setSelected] = useState<Selected | null>(null);
  const composing = selected?.anchor != null;
  const composingRef = useRef(false);
  composingRef.current = composing;
  const enabled = space !== null;

  // Radix positions the popover on a virtual element that follows the range.
  // `contextElement` lets it track scrolling inside the viewer pane.
  const rangeRef = useRef<Range | null>(null);
  rangeRef.current = selected?.range ?? null;
  const virtualRef = useRef({
    getBoundingClientRect: () => rangeRef.current?.getBoundingClientRect() ?? new DOMRect(),
    get contextElement() {
      return rangeRef.current?.startContainer.parentElement ?? undefined;
    },
  });

  const pendingRef = useRef(onPendingChange);
  pendingRef.current = onPendingChange;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled || readOnly) {
      setSelected(null);
      return;
    }
    let pointerDown = false;
    let frame = 0;
    const evaluate = () => {
      frame = 0;
      // While the composer is open the selection moves into the textarea.
      if (composingRef.current) return;
      const selection = window.getSelection();
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      if (
        !selection ||
        !range ||
        selection.isCollapsed ||
        !root.contains(range.commonAncestorContainer) ||
        selection.toString().trim() === ""
      ) {
        setSelected(null);
        return;
      }
      setSelected({ range: range.cloneRange(), anchor: null });
    };
    const schedule = () => {
      if (!pointerDown && !frame) frame = requestAnimationFrame(evaluate);
    };
    // Mouse selection: wait for the button to come up. Keyboard and scripted
    // selections arrive as `selectionchange` alone.
    const onPointerDown = () => {
      pointerDown = true;
    };
    const onPointerUp = () => {
      if (!pointerDown) return;
      pointerDown = false;
      schedule();
    };
    root.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("selectionchange", schedule);
    return () => {
      root.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("selectionchange", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rootRef, enabled, readOnly]);

  useEffect(() => {
    pendingRef.current(composing && selected ? selected.range : null);
  }, [composing, selected]);
  useEffect(() => () => pendingRef.current(null), []);

  // Where focus was before the composer opened. It goes back there on close.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const close = () => setSelected(null);

  const startComment = () => {
    const anchor = space && selected ? anchorFromRange(space, selected.range) : null;
    if (!anchor || !selected) {
      toast.error("Select text in the file to comment on it.");
      close();
      return;
    }
    const focused = document.activeElement;
    returnFocusRef.current =
      focused instanceof HTMLElement && focused !== document.body ? focused : null;
    setSelected({ range: selected.range, anchor });
  };
  const startRef = useRef(startComment);
  startRef.current = startComment;

  // "C" while the button shows opens the composer.
  const buttonShown = selected !== null && !composing;
  useEffect(() => {
    if (!buttonShown) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "c" && event.key !== "C") return;
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(TYPING_TARGET) || document.querySelector(OPEN_OVERLAY)) return;
      event.preventDefault();
      startRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [buttonShown]);

  const closeComposer = () => {
    window.getSelection()?.removeAllRanges();
    close();
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
  };

  return (
    <Popover open={selected !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        data-comb-selection=""
        side="bottom"
        align={composing ? "start" : "center"}
        sideOffset={6}
        hideWhenDetached
        className={composing ? "w-80 p-3" : "w-auto p-1"}
        // The button must not take focus: the selection stays visible.
        onOpenAutoFocus={(event) => {
          if (!composing) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {selected?.anchor ? (
          <div className="flex flex-col gap-2">
            <QuoteExcerpt text={selected.anchor.quote?.exact ?? ""} />
            <CommentComposer
              target={{ kind: "anchor", anchor: selected.anchor }}
              placeholder="Comment on this passage"
              autoFocus
              onClose={closeComposer}
              renderComposerExtras={renderComposerExtras}
            />
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            // Keep the document selection when the button is pressed.
            onMouseDown={(event) => event.preventDefault()}
            onClick={startComment}
            aria-keyshortcuts="C"
          >
            <MessageSquarePlus />
            Comment
            <Kbd aria-hidden className="hidden sm:inline-flex">
              C
            </Kbd>
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

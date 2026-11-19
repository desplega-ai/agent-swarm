import { Quote } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

export function CiteOutcomeSelection({
  timeline,
  composerRef,
  onCite,
}: {
  timeline: HTMLElement;
  composerRef: RefObject<HTMLElement | null>;
  onCite: (text: string) => void;
}) {
  const [selected, setSelected] = useState<{ range: Range; text: string } | null>(null);
  const rangeRef = useRef<Range | null>(null);
  rangeRef.current = selected?.range ?? null;
  const anchor = useRef({
    getBoundingClientRect: () => rangeRef.current?.getBoundingClientRect() ?? new DOMRect(),
    get contextElement() {
      return rangeRef.current?.startContainer.parentElement ?? undefined;
    },
  });
  // The dock has a textarea fallback while its rich editor loads.
  const enabledInput = useCallback(
    () =>
      composerRef.current?.querySelector<HTMLElement>(
        '[role="textbox"][contenteditable="true"], textarea:not(:disabled)',
      ),
    [composerRef],
  );
  const cite = useCallback(() => {
    const input = enabledInput();
    if (!selected || !input) return;
    onCite(selected.text);
    window.getSelection()?.removeAllRanges();
    setSelected(null);
    input.focus();
  }, [enabledInput, onCite, selected]);

  useEffect(() => {
    let selecting = false;
    const readSelection = () => {
      if (selecting) return;
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const ancestor = range?.commonAncestorContainer;
      const outcome = (ancestor instanceof Element ? ancestor : ancestor?.parentElement)?.closest(
        "[data-outcome-text]",
      );
      const text = selection?.toString().trim();
      setSelected(
        range && outcome && timeline.contains(outcome) && text && enabledInput()
          ? { range: range.cloneRange(), text }
          : null,
      );
    };
    const onPointerDown = () => {
      selecting = true;
    };
    const onPointerEnd = () => {
      if (!selecting) return;
      selecting = false;
      readSelection();
    };
    timeline.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerEnd);
    document.addEventListener("pointercancel", onPointerEnd);
    document.addEventListener("selectionchange", readSelection);
    return () => {
      timeline.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerEnd);
      document.removeEventListener("pointercancel", onPointerEnd);
      document.removeEventListener("selectionchange", readSelection);
    };
  }, [timeline, enabledInput]);

  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "c" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat
      )
        return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable], [role="combobox"], [role="listbox"], [role="menu"], [role="option"]',
        )
      )
        return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"]:not([data-cite-selection]), [role="menu"], [role="listbox"]',
        )
      )
        return;
      event.preventDefault();
      cite();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cite, selected]);

  return (
    <Popover open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        aria-label="Outcome selection"
        data-cite-selection=""
        side="bottom"
        sideOffset={6}
        hideWhenDetached
        className="w-auto p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <Button
          variant="ghost"
          size="sm"
          className="pointer-coarse:min-h-11"
          aria-keyshortcuts="C"
          onMouseDown={(event) => event.preventDefault()}
          onClick={cite}
        >
          <Quote size={14} aria-hidden="true" />
          Cite
          <Kbd aria-hidden="true" className="hidden sm:inline-flex">
            C
          </Kbd>
        </Button>
      </PopoverContent>
    </Popover>
  );
}

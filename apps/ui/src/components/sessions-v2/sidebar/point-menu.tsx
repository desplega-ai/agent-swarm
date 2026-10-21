/**
 * A DropdownMenu that opens at a viewport point (a right-click, the menu
 * key, a row control) on a hidden fixed anchor, so no ContextMenu primitive
 * is needed. The row menu and the group menu share it.
 */

import { type ReactNode, useLayoutEffect, useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";

/**
 * `value`, or the last non-null `value` while it is null: a closing menu or
 * dialog keeps its place and its words while it fades out.
 */
export function useLastValue<T>(value: T | null): T | null {
  const last = useRef(value);
  useLayoutEffect(() => {
    if (value !== null) last.current = value;
  }, [value]);
  return value ?? last.current;
}

/** A key hint at the right of a menu item. */
export function MenuKey({ children }: { children: string }) {
  return (
    <Kbd aria-hidden className="ml-auto">
      {children}
    </Kbd>
  );
}

export function PointMenu<S extends { x: number; y: number }>({
  state,
  onClose,
  onRestoreFocus,
  className,
  children,
}: {
  state: S | null;
  onClose: () => void;
  /** Focus goes back to the list when the menu closes, unless an action took it. */
  onRestoreFocus: () => void;
  className?: string;
  /** The items, for the state shown (the last one while the menu fades out). */
  children: (shown: S) => ReactNode;
}) {
  const shown = useLastValue(state);
  if (!shown) return null;
  return (
    <DropdownMenu open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed size-px"
          style={{ left: shown.x, top: shown.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        className={className}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        {children(shown)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One overlay in two shapes (plan Phase 9, SPEC R8.5): the desktop Popover
 * or Dialog from `md` up, and a bottom Drawer (vaul) on phones. The drawer
 * has a grab handle, drags down to close from anywhere, and every close path
 * (a backdrop tap, a drag, an item) runs the same 250 ms exit. Compose it
 * like the primitives it wraps:
 *
 *   <ResponsiveOverlay open={open} onOpenChange={setOpen}>
 *     <ResponsiveOverlayTrigger asChild><Button /></ResponsiveOverlayTrigger>
 *     <ResponsiveOverlayContent title="People" className="w-80">…</ResponsiveOverlayContent>
 *   </ResponsiveOverlay>
 *
 * `title` is the drawer's title row. A dialog body that renders its own
 * `DialogTitle` needs none: Radix Dialog and vaul share one context, so that
 * title names the drawer too. A body reads `useOverlayKind()` to size its
 * controls for touch (44 px) in the drawer. The click that ends a drag of
 * the drawer is eaten, so a drag that starts on a row runs nothing.
 */

import {
  type ComponentProps,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useRef,
} from "react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsPhone } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

type OverlayKind = "popover" | "dialog" | "drawer";

/** A press that moves this far is a drag (of the drawer), not a tap. */
const DRAG_PX = 8;

const OverlayKindContext = createContext<OverlayKind>("popover");

/** The shape the overlay has on this screen. Content can adapt to it (larger rows in a drawer). */
export function useOverlayKind(): OverlayKind {
  return useContext(OverlayKindContext);
}

export function ResponsiveOverlay({
  desktop = "popover",
  open,
  onOpenChange,
  children,
}: {
  /** The shape from `md` up. Phones always get the drawer. */
  desktop?: "popover" | "dialog";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const kind: OverlayKind = useIsPhone() ? "drawer" : desktop;
  const Root = kind === "drawer" ? Drawer : kind === "dialog" ? Dialog : Popover;
  return (
    <OverlayKindContext.Provider value={kind}>
      <Root open={open} onOpenChange={onOpenChange}>
        {children}
      </Root>
    </OverlayKindContext.Provider>
  );
}

export function ResponsiveOverlayTrigger(props: ComponentProps<typeof PopoverTrigger>) {
  const kind = useOverlayKind();
  if (kind === "drawer") return <DrawerTrigger {...props} />;
  if (kind === "dialog") return <DialogTrigger {...props} />;
  return <PopoverTrigger {...props} />;
}

export function ResponsiveOverlayContent({
  title,
  className,
  drawerClassName,
  align,
  side,
  sideOffset,
  showCloseButton,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onKeyDown,
  "aria-label": ariaLabel,
  children,
}: {
  /** The drawer's title row. */
  title?: ReactNode;
  /** The Popover or Dialog content classes (desktop). */
  className?: string;
  /** The drawer body classes (phones). */
  drawerClassName?: string;
  align?: ComponentProps<typeof PopoverContent>["align"];
  side?: ComponentProps<typeof PopoverContent>["side"];
  sideOffset?: number;
  /** The Dialog's corner close button (desktop dialogs only). */
  showCloseButton?: boolean;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  "aria-label"?: string;
  children: ReactNode;
}) {
  const kind = useOverlayKind();
  const focus = { onOpenAutoFocus, onCloseAutoFocus, onKeyDown };
  // A drag that closes the drawer can start on a row: the click that ends it runs nothing.
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null);

  if (kind === "popover") {
    return (
      <PopoverContent
        align={align}
        side={side}
        sideOffset={sideOffset}
        aria-label={ariaLabel}
        className={className}
        {...focus}
      >
        {children}
      </PopoverContent>
    );
  }
  if (kind === "dialog") {
    return (
      <DialogContent
        showCloseButton={showCloseButton}
        aria-label={ariaLabel}
        className={className}
        {...focus}
      >
        {children}
      </DialogContent>
    );
  }
  return (
    <DrawerContent
      aria-label={ariaLabel}
      // A title row has no description line: tell Radix there is none.
      {...(title !== undefined ? { "aria-describedby": undefined } : {})}
      // A body view marked `data-sheet-tall` (a search with results under it)
      // gets a fixed 92 dvh sheet, so its field stays put while rows filter.
      className="pb-[max(0.75rem,env(safe-area-inset-bottom))] data-[vaul-drawer-direction=bottom]:max-h-[85dvh] has-[[data-sheet-tall]]:h-[92dvh] data-[vaul-drawer-direction=bottom]:has-[[data-sheet-tall]]:max-h-[92dvh]"
      {...focus}
      onPointerDownCapture={(event) => {
        press.current = { x: event.clientX, y: event.clientY, dragged: false };
      }}
      onPointerMoveCapture={(event) => {
        const start = press.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= DRAG_PX) {
          start.dragged = true;
        }
      }}
      onClickCapture={(event) => {
        if (!press.current?.dragged) return;
        press.current = null;
        event.preventDefault();
        event.stopPropagation();
      }}
      onOpenAutoFocus={(event) => {
        onOpenAutoFocus?.(event);
        if (event.defaultPrevented) return;
        // The sheet takes the focus, not its first field: a phone keyboard
        // would cover the list it just opened.
        event.preventDefault();
        if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
      }}
    >
      {title !== undefined ? (
        <DrawerHeader className="px-4 pt-3 pb-1">
          <DrawerTitle className="truncate text-sm">{title}</DrawerTitle>
        </DrawerHeader>
      ) : null}
      {/* A list under a title row runs to the edges. A dialog body keeps the
          dialog's inset and its gap. */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain",
          title !== undefined ? "px-2" : "flex flex-col gap-4 px-4 pt-3",
          drawerClassName,
        )}
      >
        {children}
      </div>
    </DrawerContent>
  );
}

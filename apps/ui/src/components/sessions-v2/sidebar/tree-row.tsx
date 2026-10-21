import type { CSSProperties, HTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/**
 * The frame every sidebar row shares: the treeitem role, the indent (14 px a
 * level) with its guide line under the parent's icon, the pointer hover
 * (with the linger), and the keyboard cursor. The tree (`group/tree`) sets
 * `data-kb` while keys drive it: then the cursor row shows a ring and no row
 * fades, so `j`/`k` leave no trail (UX review R9).
 */
export function TreeRow({
  level,
  cursor,
  className,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  level: number;
  cursor: boolean;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: the tree keeps the focus and points at the cursor row with aria-activedescendant, so rows can leave without dropping it
    <div
      role="treeitem"
      aria-level={level + 1}
      data-cursor={cursor ? "true" : undefined}
      style={{ ...style, "--lv": level } as CSSProperties}
      className={cn(
        "group/row relative mx-1.5 flex items-center gap-1.5 rounded-sm pr-1.5 pl-[calc(6px+var(--lv)*14px)] select-none",
        // The avatar rings match the row fill.
        "[--avatar-ring:var(--color-surface)] hover:[--avatar-ring:var(--color-accent)]",
        "transition-colors hover-linger hover:bg-accent group-data-[kb=true]/tree:transition-none",
        "group-data-[kb=true]/tree:data-[cursor=true]:bg-accent group-data-[kb=true]/tree:data-[cursor=true]:ring-2 group-data-[kb=true]/tree:data-[cursor=true]:ring-ring/60 group-data-[kb=true]/tree:data-[cursor=true]:ring-inset",
        level > 0 &&
          "before:pointer-events-none before:absolute before:inset-y-0 before:left-[calc(var(--lv)*14px)] before:border-l before:border-border-subtle",
        className,
      )}
      {...props}
    />
  );
}

/** A control inside a row keeps the focus on the tree, so the list keys keep working. */
export const keepTreeFocus = (event: MouseEvent) => event.preventDefault();

/** No motion while keys drive the tree (DESIGN.md frequency rule): no fade, no turn. */
export const NO_KEYBOARD_MOTION = "group-data-[kb=true]/tree:transition-none";

/** A key inside a tooltip (the tooltip surface is inverted). */
export function TipKey({ children }: { children: string }) {
  return (
    <Kbd aria-hidden className="border-background/30 bg-background/15 text-background">
      {children}
    </Kbd>
  );
}

/**
 * "Needs you" in the row words (SPEC R4): sentence case on the amber tint,
 * not a status tag. Rows show "Needs you", counts "2 need you".
 */
/**
 * The read mark (SPEC R4): a 6 px dot while unread. A read session keeps the
 * empty slot, so titles line up. Decorative: say "Unread" in the accessible name.
 */
export function ReadMark({ unread, className }: { unread: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", unread && "bg-foreground", className)}
    />
  );
}

/** The title of an unread session: bold, in the full foreground color (SPEC R4). */
export const UNREAD_TITLE = "font-semibold text-foreground";

export function NeedsYouBadge({ children }: { children: ReactNode }) {
  return (
    <Badge
      variant="outline"
      className="h-[18px] rounded-sm border-status-active/50 bg-status-active/15 px-1.5 text-meta font-semibold tabular-nums text-status-active-strong"
    >
      {children}
    </Badge>
  );
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

/**
 * `memo` props check for tree rows: every prop by identity, and a `row`
 * model one level down. The row list is rebuilt on each poll, but a row
 * whose fields kept their identity does not render again.
 */
export function rowPropsEqual<P extends object>(prev: P, next: P): boolean {
  const { row: prevRow, ...prevRest } = prev as Record<string, unknown>;
  const { row: nextRow, ...nextRest } = next as Record<string, unknown>;
  const rowsEqual =
    prevRow && nextRow && typeof prevRow === "object" && typeof nextRow === "object"
      ? shallowEqual(prevRow as Record<string, unknown>, nextRow as Record<string, unknown>)
      : prevRow === nextRow;
  return rowsEqual && shallowEqual(prevRest, nextRest);
}

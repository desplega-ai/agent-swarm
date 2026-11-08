/**
 * Page-local building blocks for the phone layout of detail pages. They live
 * next to the skills page because the shared components are off limits for
 * this prototype; the same ideas would move to `components/` as one
 * `DetailHeader` (back button, title, badge row, overflow menu) and a clamped
 * description.
 */

import { Ellipsis } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * A description clamped to `lines` lines. When it is longer, the whole block
 * is one tap target: "more" sits over the end of the last line, and a tap
 * opens the full text in place (no nested scroller, no second row for a
 * button). Short text renders as a plain paragraph.
 */
export function ClampedDescription({
  text,
  lines = 2,
  className,
}: {
  text: string;
  lines?: 2 | 3;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, text]);

  const clamp = lines === 3 ? "line-clamp-3" : "line-clamp-2";
  const tappable = overflowing || expanded;

  return (
    <div className={cn("relative text-sm leading-relaxed text-muted-foreground", className)}>
      <p ref={ref} className={cn(!expanded && clamp)}>
        {text}
        {expanded ? (
          <>
            {" "}
            <span className="font-medium text-foreground">less</span>
          </>
        ) : null}
      </p>
      {!expanded && overflowing ? (
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 bottom-0 bg-linear-to-l from-background from-65% to-transparent pl-8 font-medium text-foreground"
        >
          more
        </span>
      ) : null}
      {tappable ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Show less of the description" : "Show the full description"}
          onClick={() => setExpanded((value) => !value)}
          className="absolute inset-0 cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        />
      ) : null}
    </div>
  );
}

export interface OverflowAction {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
}

/**
 * One "..." button that holds a page's secondary actions (Disable, Delete),
 * so the header keeps a single row. The button is a 36px tap target; the
 * items are 40px tall. Destructive actions sit under a separator and should
 * open a confirmation (`ConfirmDialog`), never act on select.
 */
export function OverflowMenu({
  actions,
  label = "More actions",
}: {
  actions: OverflowAction[];
  label?: string;
}) {
  if (actions.length === 0) return null;
  const firstDestructive = actions.findIndex((action) => action.destructive);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="shrink-0" aria-label={label}>
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {actions.map((action, index) => (
          <div key={action.key}>
            {index === firstDestructive && index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              variant={action.destructive ? "destructive" : "default"}
              className="min-h-10 gap-2"
              onSelect={action.onSelect}
            >
              {action.icon}
              {action.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A delete confirmation opened from a menu item (so it is controlled, not a trigger). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

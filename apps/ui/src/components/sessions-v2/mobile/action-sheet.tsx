/**
 * The phone action sheet (SPEC R8.5): a bottom sheet with a title row and
 * 48 px rows, the touch form of a desktop menu. A tap on a row starts the
 * sheet's close (the drawer's 250 ms exit) and runs the row in the same
 * tap, so a row that opens the next sheet opens it while this one slides
 * out. A switch row flips in place and keeps the sheet open.
 */

import type { LucideIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useId } from "react";
import {
  ResponsiveOverlay,
  ResponsiveOverlayContent,
} from "@/components/shared/responsive-overlay";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const CloseSheet = createContext<() => void>(() => {});

export function ActionSheet({
  open,
  onOpenChange,
  title,
  onCloseAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The title row: what the sheet acts on. */
  title: ReactNode;
  onCloseAutoFocus?: (event: Event) => void;
  children: ReactNode;
}) {
  return (
    <ResponsiveOverlay desktop="dialog" open={open} onOpenChange={onOpenChange}>
      <ResponsiveOverlayContent
        title={title}
        className="sm:max-w-sm"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <CloseSheet.Provider value={() => onOpenChange(false)}>
          <div className="flex flex-col pb-1">{children}</div>
        </CloseSheet.Provider>
      </ResponsiveOverlayContent>
    </ResponsiveOverlay>
  );
}

const ROW =
  "flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left text-base transition-colors active:bg-accent disabled:opacity-50";

export function ActionSheetItem({
  icon: Icon,
  label,
  detail,
  onSelect,
  destructive,
  disabled,
}: {
  icon: LucideIcon;
  label: ReactNode;
  /** Muted words at the right edge (a time). */
  detail?: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const close = useContext(CloseSheet);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        close();
        onSelect();
      }}
      className={cn(ROW, destructive && "text-destructive")}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-5 shrink-0",
          destructive ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? (
        <span className="shrink-0 font-mono text-data tabular-nums text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </button>
  );
}

/**
 * A row that flips a setting and keeps the sheet open. The row is the
 * switch's label, so a tap anywhere on it flips the switch.
 */
export function ActionSheetSwitch({
  icon: Icon,
  label,
  checked,
  onCheckedChange,
}: {
  icon: LucideIcon;
  label: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={ROW}>
      <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}

/** A muted line in the sheet: a note under a row, or why rows are off. */
export function ActionSheetNote({ children }: { children: ReactNode }) {
  return <p className="px-3 pt-1 pb-2 text-data text-muted-foreground">{children}</p>;
}

export function ActionSheetSeparator() {
  return <div aria-hidden className="mx-3 my-1 h-px bg-border-subtle" />;
}

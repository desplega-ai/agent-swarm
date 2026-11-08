import { ArrowLeft, Ellipsis, type LucideIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { ActionSheet, ActionSheetItem } from "@/components/sessions-v2/mobile/action-sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface PhoneMenuAction {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

/**
 * Phone detail header (below `md`), shared by the template and schedule
 * detail pages: one row with a back arrow, the title and one overflow button,
 * then one row of status badges. The desktop header keeps its own layout.
 *
 * `actions` are the buttons that stay visible next to the title (icon-only,
 * 36px); `menu` holds everything else behind the overflow button, in a
 * bottom sheet with 48px rows.
 *
 * Prototype for Taras's review. A shared `DetailHeader` would own this:
 * `shared:detail-header`.
 */
export function PhoneDetailHeader({
  backTo,
  backLabel,
  title,
  badges,
  actions,
  menu,
  menuTitle,
  className,
}: {
  backTo: string;
  backLabel: string;
  title: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  menu?: PhoneMenuAction[];
  menuTitle?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-start gap-1">
        <Link
          to={backTo}
          aria-label={backLabel}
          className="-ml-2 flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="min-w-0 flex-1 py-1.5 text-lg font-semibold leading-tight [overflow-wrap:anywhere]">
          {title}
        </h1>
        {actions}
        {menu && menu.length > 0 ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="-mr-1.5 shrink-0"
              aria-label="More actions"
              onClick={() => setOpen(true)}
            >
              <Ellipsis />
            </Button>
            <ActionSheet open={open} onOpenChange={setOpen} title={menuTitle ?? "Actions"}>
              {menu.map((item) => (
                <ActionSheetItem
                  key={item.key}
                  icon={item.icon}
                  label={item.label}
                  destructive={item.destructive}
                  disabled={item.disabled}
                  onSelect={item.onSelect}
                />
              ))}
            </ActionSheet>
          </>
        ) : null}
      </div>
      {badges ? <div className="flex flex-wrap items-center gap-1.5 pl-8">{badges}</div> : null}
    </div>
  );
}

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A reusable collapsible section with a clickable header that toggles content visibility.
 * Supports two variants:
 * - "plain" (default): minimal styling with just a toggle header
 * - "card": bordered card with optional icon and color theming
 */
export function CollapsibleSection({
  title,
  icon: Icon,
  iconColor,
  borderColor,
  bgColor,
  children,
  defaultOpen = false,
  variant = "plain",
  className,
  badge,
}: {
  title: string;
  icon?: React.ElementType;
  iconColor?: string;
  borderColor?: string;
  bgColor?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  variant?: "plain" | "card";
  className?: string;
  badge?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (variant === "card") {
    return (
      <div className={cn("rounded-md border shrink-0", borderColor, bgColor, className)}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 w-full px-3 py-2 text-left"
        >
          {open ? (
            <ChevronDown className={cn("h-3 w-3 shrink-0", iconColor)} />
          ) : (
            <ChevronRight className={cn("h-3 w-3 shrink-0", iconColor)} />
          )}
          {Icon && <Icon className={cn("h-3.5 w-3.5 shrink-0", iconColor)} />}
          <span className={cn("text-xs font-semibold", iconColor)}>{title}</span>
          {badge}
        </button>
        {open && <div className="px-3 pb-2.5">{children}</div>}
      </div>
    );
  }

  return (
    <div className={cn("space-y-1", className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-left group"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
        {Icon && <Icon className={cn("h-3 w-3 text-muted-foreground", iconColor)} />}
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          {title}
        </span>
        {badge}
      </button>
      {open && children}
    </div>
  );
}

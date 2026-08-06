import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// PageHeader — description + action row that opens every route page in ui.
//
// Plain-string titles are NOT rendered anymore (Taras, 2026-08-06): the
// breadcrumb in the top bar already names the page, so the in-page h1 was
// pure duplication. Call sites keep passing `title` — it documents the page
// and stays the fallback for future layout changes — but only the
// description/action row reaches the DOM (the icon rode along with the
// title, so it's dropped too).
//
// ReactNode titles still render: they carry functional content the
// breadcrumb can't (status badges, back buttons, editable names).

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}

export function PageHeader({ title, description, action, icon: Icon, className }: PageHeaderProps) {
  const titleNode =
    typeof title === "string" ? null : (
      <div className="flex items-center gap-2 min-w-0">
        {Icon ? <Icon className="h-5 w-5 text-muted-foreground shrink-0" /> : null}
        {title}
      </div>
    );

  if (!titleNode) {
    // String title (hidden) — render whatever remains, or nothing at all.
    if (!description && !action) return null;
    if (!action) {
      return <p className={cn("text-sm text-muted-foreground", className)}>{description}</p>;
    }
    return (
      <div className={cn("flex items-center justify-between gap-3", className)}>
        {description ? (
          <p className="text-sm text-muted-foreground min-w-0">{description}</p>
        ) : (
          <div />
        )}
        <div className="flex items-center gap-2 shrink-0">{action}</div>
      </div>
    );
  }

  if (!description && !action) {
    return <div className={cn("flex items-center", className)}>{titleNode}</div>;
  }

  if (description && !action) {
    return (
      <div className={cn("space-y-2", className)}>
        {titleNode}
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    );
  }

  if (action && !description) {
    return (
      <div className={cn("flex items-center justify-between gap-3", className)}>
        {titleNode}
        <div className="flex items-center gap-2 shrink-0">{action}</div>
      </div>
    );
  }

  // both description + action — title row on top, description below
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-3">
        {titleNode}
        <div className="flex items-center gap-2 shrink-0">{action}</div>
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

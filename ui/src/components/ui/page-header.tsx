import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// PageHeader — canonical title + (optional) description + (optional) action
// row that opens every route page in ui. The pre-Phase-9 hand-rolled form
// was `<div className="flex items-center justify-between"><h1>{title}</h1>
// {action}</div>`, sometimes wrapped in `space-y-2` with a description below.
//
// Detail pages with bespoke editable titles (agents/[id]'s pencil-edit name,
// workflow-runs/[id]'s multi-line title) pass JSX into `title` directly —
// the primitive doesn't constrain its content.

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}

export function PageHeader({ title, description, action, icon: Icon, className }: PageHeaderProps) {
  const titleNode = (
    <div className="flex items-center gap-2 min-w-0">
      {Icon ? <Icon className="h-5 w-5 text-muted-foreground shrink-0" /> : null}
      {typeof title === "string" ? (
        <h1 className="text-xl font-semibold truncate">{title}</h1>
      ) : (
        title
      )}
    </div>
  );

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

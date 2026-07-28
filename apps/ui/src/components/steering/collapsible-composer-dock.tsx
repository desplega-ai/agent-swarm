/**
 * Steering — collapsible shell around the task-detail composer dock.
 *
 * The task-detail page is log-dominated: on short viewports the composer eats
 * height the user would rather give to SESSION LOGS. This wraps it in a slim
 * toggle bar so the dock can be folded away and restored, with the preference
 * persisted per-deployment via `useLocalToggle`.
 *
 * Deliberately NOT used on the sessions surface — that page is a chat, where
 * a permanently visible composer is the point.
 */

import { ChevronDown, ChevronUp, MessageSquareShare } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CollapsibleComposerDockProps {
  collapsed: boolean;
  onCollapsedChange: (next: boolean) => void;
  /** Shown on the toggle bar when collapsed. */
  collapsedLabel?: string;
  children: React.ReactNode;
  className?: string;
}

export function CollapsibleComposerDock({
  collapsed,
  onCollapsedChange,
  collapsedLabel = "Send a message to this task",
  children,
  className,
}: CollapsibleComposerDockProps) {
  return (
    <div className={cn("shrink-0 flex flex-col", className)}>
      <button
        type="button"
        onClick={() => onCollapsedChange(!collapsed)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand message composer" : "Collapse message composer"}
        className={cn(
          "group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors",
        )}
      >
        <MessageSquareShare className="size-3 shrink-0" aria-hidden="true" />
        <span className="font-mono text-[10px] uppercase tracking-[0.08em]">Message</span>
        {collapsed ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/80">
            {collapsedLabel}
          </span>
        ) : null}
        {collapsed ? (
          <ChevronUp className="ml-auto size-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronDown className="ml-auto size-3.5 shrink-0" aria-hidden="true" />
        )}
      </button>
      {collapsed ? null : children}
    </div>
  );
}

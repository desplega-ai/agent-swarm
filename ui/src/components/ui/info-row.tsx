import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// InfoRow — a key-above-value pair used in detail pages, modals, and config
// sections. Canonical pre-Phase-9 form was:
//
//   <div>
//     <span className="text-xs text-muted-foreground uppercase tracking-wide">Role</span>
//     <p className="text-sm">{value}</p>
//   </div>
//
// 32 occurrences across 9 files (agents/[id], repos/[id], schedules/[id],
// workflows/[id], config, usage, usage-summary, name-connection-modal,
// step-card). Phase 10 will replace those call sites.

export interface InfoRowProps {
  label: ReactNode;
  className?: string;
  children: ReactNode;
}

export function InfoRow({ label, className, children }: InfoRowProps) {
  return (
    <div className={cn("space-y-0.5", className)}>
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      {typeof children === "string" || typeof children === "number" ? (
        <p className="text-sm">{children}</p>
      ) : (
        <div className="text-sm">{children}</div>
      )}
    </div>
  );
}

// DefinitionList — vertical-spaced container for InfoRows. Saves the
// `space-y-3` (or whatever local spacing) wrapper at the call site.

export interface DefinitionListProps {
  className?: string;
  children: ReactNode;
}

export function DefinitionList({ className, children }: DefinitionListProps) {
  return <div className={cn("space-y-3", className)}>{children}</div>;
}

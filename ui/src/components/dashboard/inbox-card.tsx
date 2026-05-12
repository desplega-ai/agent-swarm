/**
 * Inbox card primitive (Phase 6 ≥1.76.0).
 *
 * One card per inbox item, with three trailing actions: Dismiss (×), Snooze
 * (▼ menu: 1h, 4h, 1d), Done (✓). Dispatched dismiss/snooze/done writes go
 * through `useUpdateInboxItem` (server-side `inbox_item_state`); see
 * `use-inbox-state.ts` for the optimistic-merge contract.
 *
 * Body click triggers the parent's `onActivate` callback — the parent decides
 * whether to navigate (approval/credential/broken/to-read) or open
 * `CreateTaskDialog` (to-start).
 */

import { Check, ChevronDown, X } from "lucide-react";
import type * as React from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface InboxCardProps {
  title: string;
  subtitle: string;
  /** Visual severity class — usually a `--color-status-*` token mapping. */
  toneClass?: string;
  onActivate: () => void;
  onDismiss: () => void;
  onSnooze: (durationMs: number) => void;
  onDone: () => void;
  /** When the action mutation is in flight (optional — disables actions). */
  busy?: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
const SNOOZE_OPTIONS: Array<{ label: string; ms: number }> = [
  { label: "1 hour", ms: 1 * HOUR_MS },
  { label: "4 hours", ms: 4 * HOUR_MS },
  { label: "1 day", ms: 24 * HOUR_MS },
];

/**
 * Stop a child action's click from bubbling into the card body's `onClick`
 * (which would otherwise activate the card alongside the action).
 */
function stop(e: React.MouseEvent | React.KeyboardEvent) {
  e.stopPropagation();
}

export function InboxCard({
  title,
  subtitle,
  toneClass,
  onActivate,
  onDismiss,
  onSnooze,
  onDone,
  busy,
}: InboxCardProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: cannot use <button> at outer because it nests interactive children (action buttons + Radix dropdown trigger) — invalid HTML. Card activation stays keyboard-accessible via tabIndex+role+onKeyDown.
    <div
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        "group relative flex flex-col gap-1 rounded-md border bg-card px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        toneClass,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-snug">{title}</div>
          {subtitle ? (
            <div className="line-clamp-2 text-[11px] text-muted-foreground">{subtitle}</div>
          ) : null}
        </div>
        <div
          className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          onClick={stop}
          onKeyDown={stop}
        >
          {/* Done */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Mark done"
                disabled={busy}
                onClick={(e) => {
                  stop(e);
                  onDone();
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-status-success/10 hover:text-status-success-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Mark done</TooltipContent>
          </Tooltip>
          {/* Snooze */}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger
                  type="button"
                  aria-label="Snooze"
                  disabled={busy}
                  onClick={stop}
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-status-info/10 hover:text-status-info-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Snooze</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" onClick={stop}>
              <DropdownMenuLabel>Snooze for…</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {SNOOZE_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.label}
                  onSelect={() => {
                    onSnooze(opt.ms);
                  }}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Dismiss */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Dismiss"
                disabled={busy}
                onClick={(e) => {
                  stop(e);
                  onDismiss();
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-status-error/10 hover:text-status-error-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Dismiss</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

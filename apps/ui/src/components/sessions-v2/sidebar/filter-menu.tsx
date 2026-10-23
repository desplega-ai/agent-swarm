/**
 * The filter menu at the end of the search row: Show (Mine or All) and one
 * checkbox per root source. A cleared source leaves every list and count,
 * the Inbox included. Both choices are stored in this browser
 * (`lib/sessions-show.ts`). The icon shows a dot while the filter differs
 * from the default (Mine, every source on).
 */

import { ListFilter } from "lucide-react";
import { TaskSourceMark, taskSourceLabel } from "@/components/shared/task-source-mark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type SessionsShow,
  sessionsFilterActive,
  useSessionsHiddenSources,
  useSessionsShow,
} from "@/lib/sessions-show";
import { cn } from "@/lib/utils";

const SHOW_OPTIONS = [
  { value: "mine", label: "Mine", hint: "Sessions you started, and sessions shared with you" },
  { value: "all", label: "All", hint: "Also workflow, schedule, and system runs for you" },
] as const;

/** A menu item stays open on select, so several filters change in one visit. */
const keepOpen = (event: Event) => event.preventDefault();

export function FilterMenu({
  sources,
  canShow,
  phone = false,
}: {
  /** The root sources in this view, with counts (`GET /api/session-tree`). */
  sources: readonly { source: string; total: number }[];
  /** Mine / All needs a picked user: with none, every session shows. */
  canShow: boolean;
  /** The phone search row: a 44 px button. */
  phone?: boolean;
}) {
  const [show, setShow] = useSessionsShow();
  const [hidden, setHidden] = useSessionsHiddenSources();
  const active = sessionsFilterActive(canShow ? show : "mine", hidden);
  // A hidden source with no sessions left still shows, so it can come back.
  const rows = [
    ...sources,
    ...hidden
      .filter((source) => !sources.some((row) => row.source === source))
      .map((source) => ({ source, total: 0 })),
  ];
  const toggle = (source: string, on: boolean) =>
    setHidden(on ? hidden.filter((s) => s !== source) : [...hidden, source]);
  const label = active ? "Filter sessions, filtered" : "Filter sessions";

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              className={cn(
                "relative shrink-0 text-muted-foreground",
                phone && "size-11",
                active && "text-foreground",
              )}
            >
              <ListFilter className={phone ? "size-5" : "size-4"} />
              {active ? (
                <span
                  aria-hidden
                  className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary"
                />
              ) : null}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{active ? "Filter (on)" : "Filter"}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-60">
        {canShow ? (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Show
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={show}
              onValueChange={(next) => setShow(next as SessionsShow)}
            >
              {SHOW_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value} onSelect={keepOpen}>
                  <span className="flex min-w-0 flex-col">
                    <span>{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.hint}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
        {rows.length > 0 ? (
          <>
            {canShow ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Sources
            </DropdownMenuLabel>
            {rows.map(({ source, total }) => (
              <DropdownMenuCheckboxItem
                key={source}
                checked={!hidden.includes(source)}
                onCheckedChange={(on) => toggle(source, on)}
                onSelect={keepOpen}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  <TaskSourceMark source={source} />
                </span>
                <span className="min-w-0 flex-1 truncate">{taskSourceLabel(source)}</span>
                <span className="font-mono text-meta tabular-nums text-muted-foreground">
                  {total}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </>
        ) : null}
        {active ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setShow("mine");
                setHidden([]);
              }}
            >
              Reset filter
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

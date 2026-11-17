/**
 * The filter menu at the end of the search row: Show (Mine or All) and one
 * checkbox per root source. Only ticked sources stay in the lists and counts,
 * the Inbox included; a source never seen before starts unticked. Both
 * choices are stored in this browser (`lib/sessions-show.ts`). The icon shows
 * a dot while the filter differs from the default (Mine, `comb` and `ui` on).
 * On a phone the same choices open as a bottom sheet, like every other menu there.
 */

import { ListFilter, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useAllUsersScope } from "@/api/hooks/use-all-users-scope";
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
  DEFAULT_SHOWN_SOURCES,
  type SessionsShow,
  sessionsFilterActive,
  useSessionsShow,
  useSessionsShownSources,
} from "@/lib/sessions-show";
import { cn } from "@/lib/utils";
import {
  ActionSheet,
  ActionSheetCheck,
  ActionSheetItem,
  ActionSheetNote,
  ActionSheetSeparator,
} from "../mobile/action-sheet";

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
  /** The phone list screen: a 44 px button that opens a bottom sheet. */
  phone?: boolean;
}) {
  const [show, setShow] = useSessionsShow();
  const [shown, setShown] = useSessionsShownSources();
  const allUsers = useAllUsersScope();
  const active = sessionsFilterActive(canShow ? show : "mine", shown) || allUsers.enabled;
  // A shown source with no sessions still has a row, so it can be turned off.
  const rows = [
    ...sources,
    ...shown
      .filter((source) => !sources.some((row) => row.source === source))
      .map((source) => ({ source, total: 0 })),
  ];
  const toggle = (source: string, on: boolean) =>
    setShown(on ? [...shown, source] : shown.filter((s) => s !== source));
  const label = active ? "Filter sessions, filtered" : "Filter sessions";
  const reset = () => {
    setShow("mine");
    setShown(DEFAULT_SHOWN_SOURCES);
    if (allUsers.enabled) allUsers.setEnabled(false);
  };
  const [sheetOpen, setSheetOpen] = useState(false);

  if (phone) {
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-haspopup="dialog"
          onClick={() => setSheetOpen(true)}
          className="relative size-11 shrink-0"
        >
          <ListFilter className="size-5" />
          {active ? (
            <span aria-hidden className="absolute top-2 right-2 size-1.5 rounded-full bg-primary" />
          ) : null}
        </Button>
        <ActionSheet open={sheetOpen} onOpenChange={setSheetOpen} title="Filter sessions">
          {canShow ? (
            <>
              <ActionSheetNote>Show</ActionSheetNote>
              <div role="radiogroup" aria-label="Show" className="flex flex-col">
                {SHOW_OPTIONS.map((option) => (
                  <ActionSheetCheck
                    key={option.value}
                    role="radio"
                    checked={show === option.value}
                    onSelect={() => setShow(option.value)}
                    label={option.label}
                    hint={option.hint}
                  />
                ))}
              </div>
              {allUsers.available ? (
                <ActionSheetCheck
                  role="checkbox"
                  checked={allUsers.enabled}
                  onSelect={() => allUsers.setEnabled(!allUsers.enabled)}
                  label="All users"
                  hint="Admins: Mine and All for every user, read-only"
                />
              ) : null}
            </>
          ) : null}
          {rows.length > 0 ? (
            <>
              {canShow ? <ActionSheetSeparator /> : null}
              <ActionSheetNote>Sources</ActionSheetNote>
              {rows.map(({ source, total }) => (
                <ActionSheetCheck
                  key={source}
                  role="checkbox"
                  checked={shown.includes(source)}
                  onSelect={() => toggle(source, !shown.includes(source))}
                  lead={<TaskSourceMark source={source} />}
                  label={taskSourceLabel(source)}
                  detail={total}
                />
              ))}
            </>
          ) : null}
          {active ? (
            <>
              <ActionSheetSeparator />
              <ActionSheetItem icon={RotateCcw} label="Reset filter" onSelect={reset} />
            </>
          ) : null}
        </ActionSheet>
      </>
    );
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              className={cn("relative shrink-0 text-muted-foreground", active && "text-foreground")}
            >
              <ListFilter className="size-4" />
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
            {allUsers.available ? (
              <DropdownMenuCheckboxItem
                checked={allUsers.enabled}
                onCheckedChange={allUsers.setEnabled}
                onSelect={keepOpen}
              >
                <span className="flex min-w-0 flex-col">
                  <span>All users</span>
                  <span className="text-xs text-muted-foreground">
                    Admins: Mine and All for every user, read-only
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
            ) : null}
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
                checked={shown.includes(source)}
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
            <DropdownMenuItem onSelect={reset}>Reset filter</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

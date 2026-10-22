/**
 * The status bar under the sessions view (plan Phase 8, SPEC R2, R9). On the
 * left, the Running, Needs you, and Unread counts from the tree. Each one is
 * a toggle: on, the sidebar shows only those sessions (an `is:` token in the
 * sidebar search, so the search field shows the filter and Escape clears
 * it). On the right, the tab and pane count, and Keys (`?`), which opens the
 * keys step of the guide.
 *
 * The counts add Inbox, Later, and Done, so a count matches the list its
 * toggle shows. Only the Running ring turns, and only while a session runs.
 */

import { AppWindow, Hourglass, Keyboard } from "lucide-react";
import type { ReactNode } from "react";
import { useSessionTree } from "@/api/hooks/use-session-tree";
import type { SessionSectionCounts, SessionTreeResponse } from "@/api/types";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type QuickFilter, quickFilterOn, toggleQuickFilter } from "@/lib/session-search";
import { plural } from "@/lib/sessions-v2";
import { ReadMark, TipKey } from "./sidebar/tree-row";

type Count = Exclude<keyof SessionSectionCounts, "total">;

function countOf(tree: SessionTreeResponse | undefined, key: Count): number {
  if (!tree) return 0;
  return tree.inbox[key] + tree.later[key] + tree.done[key];
}

function QuickToggle({
  icon,
  count,
  label,
  tip,
  pressed,
  tone,
  onToggle,
}: {
  icon: ReactNode;
  count: number;
  label: string;
  /** What the toggle shows when it is on. */
  tip: string;
  pressed: boolean;
  tone?: "needs";
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={pressed}
          onClick={onToggle}
          className="group/quick h-5.5 gap-1.5 px-2 font-normal text-muted-foreground hover:text-foreground aria-pressed:bg-primary/15 aria-pressed:text-status-active-strong"
        >
          {icon}
          <span
            data-tone={tone}
            className="font-mono font-bold tabular-nums text-foreground group-aria-pressed/quick:text-status-active-strong data-[tone=needs]:text-status-active-strong"
          >
            {count}
          </span>
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{pressed ? "Clear the filter" : tip}</TooltipContent>
    </Tooltip>
  );
}

export function StatusBar({
  query,
  onQueryChange,
  tabCount,
  paneCount,
  onKeys,
}: {
  /** The sidebar search: the toggles add or drop their `is:` token. */
  query: string;
  onQueryChange: (query: string) => void;
  tabCount: number;
  paneCount: number;
  /** Keys: the keys step of the guide. */
  onKeys: () => void;
}) {
  const { data: tree } = useSessionTree();
  const running = countOf(tree, "running");
  const needs = countOf(tree, "needsYou");
  const toggle = (filter: QuickFilter) => () => onQueryChange(toggleQuickFilter(query, filter));
  return (
    <section
      aria-label="Status bar"
      className="hidden h-7 shrink-0 items-center gap-0.5 border-t border-border bg-surface px-2 text-xs text-muted-foreground md:flex"
    >
      <QuickToggle
        icon={
          <TaskStatusIcon
            variant="active"
            className={running > 0 ? "size-3" : "size-3 animate-none"}
          />
        }
        count={running}
        label="running"
        tip="Show only running sessions."
        pressed={quickFilterOn(query, "running")}
        onToggle={toggle("running")}
      />
      <QuickToggle
        icon={<Hourglass aria-hidden className="size-3" />}
        count={needs}
        // The sidebar badge's words: "1 needs you", "13 need you".
        label={needs === 1 ? "needs you" : "need you"}
        tip="Show only sessions that need you."
        tone="needs"
        pressed={quickFilterOn(query, "needs")}
        onToggle={toggle("needs")}
      />
      <QuickToggle
        icon={<ReadMark unread />}
        count={countOf(tree, "unread")}
        label="unread"
        tip="Show only unread sessions."
        pressed={quickFilterOn(query, "unread")}
        onToggle={toggle("unread")}
      />
      <span className="min-w-0 flex-1" />
      <span className="flex items-center gap-1.5 px-2 whitespace-nowrap">
        <AppWindow aria-hidden className="size-3" />
        {plural(tabCount, "tab")} · {plural(paneCount, "pane")}
      </span>
      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-3" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            aria-haspopup="dialog"
            aria-keyshortcuts="Shift+?"
            onClick={onKeys}
            className="h-5.5 gap-1.5 px-2 font-normal text-muted-foreground hover:text-foreground"
          >
            <Keyboard aria-hidden className="size-3" />
            Keys
          </Button>
        </TooltipTrigger>
        <TooltipContent className="flex items-center gap-1.5">
          Guide and keys
          <TipKey>?</TipKey>
        </TooltipContent>
      </Tooltip>
    </section>
  );
}

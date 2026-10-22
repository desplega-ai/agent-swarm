/**
 * "All tabs" (SPEC R9): while the strip overflows, a chevron before "+"
 * lists every tab of the pane, so a tab past the edge is one click away.
 * Each item has the tab's read mark, an ellipsis title (the full title in a
 * tooltip when it is cut), its activity, and a check on the focused tab.
 */

import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ReadMark, UNREAD_TITLE } from "../sidebar/tree-row";
import { TruncatedTitle } from "../truncated-title";
import { TabActivity, tabLabel, useTabInfo } from "./tab-info";

function AllTabsItem({
  tab,
  view,
  selected,
  onFocusTab,
}: {
  tab: string;
  view: string | null;
  selected: boolean;
  onFocusTab: (tab: string) => void;
}) {
  // The strip's tab polls this session already.
  const info = useTabInfo(tab, view, "off");
  const Icon = info.icon;
  return (
    <DropdownMenuItem
      onSelect={() => onFocusTab(tab)}
      aria-label={tabLabel(info)}
      className="gap-2"
    >
      <ReadMark unread={info.unread} />
      {Icon ? <Icon aria-hidden className="size-3.5 shrink-0" /> : null}
      <TruncatedTitle title={info.title} className={cn("flex-1", info.unread && UNREAD_TITLE)} />
      <TabActivity activity={info.activity} />
      <Check
        aria-hidden
        className={cn("size-3.5 shrink-0 text-primary", !selected && "invisible")}
      />
    </DropdownMenuItem>
  );
}

export function AllTabsMenu({
  tabs,
  selected,
  view,
  onFocusTab,
}: {
  tabs: string[];
  selected: string;
  view: string | null;
  onFocusTab: (tab: string) => void;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`All tabs (${tabs.length})`}
              className="ml-0.5 size-7 self-center text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>All tabs</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-h-[60vh] w-72 overflow-y-auto">
        {tabs.map((tab) => (
          <AllTabsItem
            key={tab}
            tab={tab}
            view={view}
            selected={tab === selected}
            onFocusTab={onFocusTab}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

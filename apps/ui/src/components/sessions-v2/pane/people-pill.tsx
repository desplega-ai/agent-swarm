import { Users } from "lucide-react";
import { type RefObject, useState } from "react";
import type { SessionDetailResponse } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PeopleList, useSessionPeople } from "./people-popover";
import { focusQuietly, useQuietTooltip } from "./quiet-focus";

/**
 * The People pill (SPEC R8.1): the users icon and the count, no word. It
 * opens the People popover. `onShare` (the owner) adds its "Share…" row,
 * which closes the popover and opens the Share dialog. `ref` is the pill:
 * the focus comes back to it after the popover (and that Share dialog).
 */
export function PeoplePill({
  detail,
  onShare,
  ref,
}: {
  detail: SessionDetailResponse;
  onShare?: () => void;
  ref: RefObject<HTMLButtonElement | null>;
}) {
  const people = useSessionPeople(detail);
  const [open, setOpen] = useState(false);
  const tooltip = useQuietTooltip();
  const count = people.people.length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip {...tooltip}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              ref={ref}
              variant="outline"
              size="xs"
              aria-label={`People in this session, ${count}`}
              className="h-7 gap-1.5 rounded-full px-2.5 aria-expanded:border-ring"
            >
              <Users className="size-3.5 text-muted-foreground" />
              <span className="font-mono tabular-nums">{count}</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>People in this session</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="w-80 p-1.5"
        aria-label="People in this session"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusQuietly(ref.current);
        }}
      >
        <PeopleList
          {...people}
          onShare={
            onShare
              ? () => {
                  setOpen(false);
                  onShare();
                }
              : undefined
          }
        />
      </PopoverContent>
    </Popover>
  );
}

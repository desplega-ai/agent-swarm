import { Users } from "lucide-react";
import { type RefObject, useState } from "react";
import type { SessionDetailResponse } from "@/api/types";
import {
  ResponsiveOverlay,
  ResponsiveOverlayContent,
  ResponsiveOverlayTrigger,
} from "@/components/shared/responsive-overlay";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PeopleList, useSessionPeople } from "./people-popover";
import { focusQuietly, useQuietTooltip } from "./quiet-focus";

/**
 * The People pill (SPEC R8.1): the users icon and the count, no word. It
 * opens the People popover. `onShare` (the owner) adds its "Share…" row,
 * which closes the popover and opens the Share dialog. `ref` is the pill:
 * the focus comes back to it after the popover (and that Share dialog). On
 * a phone the popover is a bottom sheet (`ResponsiveOverlay`).
 */
export function PeoplePill({
  detail,
  onShare,
  ref,
  className,
}: {
  detail: SessionDetailResponse;
  onShare?: () => void;
  ref: RefObject<HTMLButtonElement | null>;
  /** The phone top bar: a 36 px pill, with a 44 px touch area on touch screens (`hit-area`). */
  className?: string;
}) {
  const people = useSessionPeople(detail);
  const [open, setOpen] = useState(false);
  const tooltip = useQuietTooltip();
  const count = people.people.length;
  return (
    <ResponsiveOverlay open={open} onOpenChange={setOpen}>
      <Tooltip {...tooltip}>
        <TooltipTrigger asChild>
          <ResponsiveOverlayTrigger asChild>
            <Button
              ref={ref}
              variant="outline"
              size="xs"
              aria-label={`People in this session, ${count}`}
              className={cn("h-7 gap-1.5 rounded-full px-2.5 aria-expanded:border-ring", className)}
            >
              <Users className="size-3.5 text-muted-foreground" />
              <span className="font-mono tabular-nums">{count}</span>
            </Button>
          </ResponsiveOverlayTrigger>
        </TooltipTrigger>
        <TooltipContent>People in this session</TooltipContent>
      </Tooltip>
      <ResponsiveOverlayContent
        title="People in this session"
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
      </ResponsiveOverlayContent>
    </ResponsiveOverlay>
  );
}

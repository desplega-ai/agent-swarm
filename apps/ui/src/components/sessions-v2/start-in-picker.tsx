/**
 * "Start in" for a new session (SPEC R3): my groups and subgroups, my
 * personal groups, and No group. Shared with me is not listed. A searchable
 * list in a Popover, at the left of the composer's action row (a bottom
 * sheet on a phone, `ResponsiveOverlay`). A group this connection cannot
 * start a session in shows why and cannot be picked.
 */

import { ChevronDown, Hash, SquareDashed } from "lucide-react";
import { useState } from "react";
import {
  ResponsiveOverlay,
  ResponsiveOverlayContent,
  ResponsiveOverlayTrigger,
} from "@/components/shared/responsive-overlay";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
} from "@/components/ui/command";
import type { GroupTarget } from "@/lib/session-groups";
import { cn } from "@/lib/utils";
import { GroupTargetItems, groupItemValue, NO_GROUP_VALUE } from "./group-target-items";

export function StartInPicker({
  value,
  label,
  targets,
  writeBlock,
  onChange,
  touch = false,
}: {
  /** The group key, or null for No group. */
  value: string | null;
  /** The picked group's path, also when the list does not hold it yet. */
  label: string;
  targets: GroupTarget[];
  /** Why a session cannot start in a group here, or null. */
  writeBlock: (key: string) => string | null;
  onChange: (key: string | null) => void;
  /** The phone New session screen: a 44 px trigger. */
  touch?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pick = (key: string | null) => {
    onChange(key);
    setOpen(false);
  };
  const Icon = value ? Hash : SquareDashed;
  const pickedTarget = targets.find((target) => target.key === value);

  return (
    <ResponsiveOverlay open={open} onOpenChange={setOpen}>
      <ResponsiveOverlayTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`Start in ${label}`}
          className={cn(
            // It shrinks before the mic, attach, and send buttons: the group name truncates.
            "max-w-64 min-w-0 shrink gap-1 text-muted-foreground hover:text-foreground",
            touch && "h-11 text-sm",
          )}
        >
          {/* A phone bar is narrow: the label says "Start in" there. */}
          {touch ? null : <span>Start in</span>}
          <Icon aria-hidden />
          <span className="min-w-0 truncate font-medium text-foreground">{label}</span>
          <ChevronDown aria-hidden />
        </Button>
      </ResponsiveOverlayTrigger>
      <ResponsiveOverlayContent
        title="Start in"
        align="start"
        className="w-96 p-0"
        drawerClassName="px-0 [&_[cmdk-input]]:text-base [&_[cmdk-item]]:min-h-11"
      >
        {/* The list opens on the picked group, so the arrow keys start there. */}
        <Command loop defaultValue={pickedTarget ? groupItemValue(pickedTarget) : NO_GROUP_VALUE}>
          <CommandInput placeholder="Search groups" />
          <CommandList className="max-h-72">
            <CommandEmpty>No group matches.</CommandEmpty>
            <CommandGroup>
              <GroupTargetItems
                targets={targets}
                picked={value}
                writeBlock={writeBlock}
                onPick={pick}
              />
            </CommandGroup>
          </CommandList>
        </Command>
      </ResponsiveOverlayContent>
    </ResponsiveOverlay>
  );
}

/**
 * Later = snooze: the Later menu items and the "Pick a date and time…"
 * dialog (SPEC R4). The time math lives in `snooze-times.ts`.
 */

import {
  Bell,
  CalendarClock,
  CalendarDays,
  Clock,
  type LucideIcon,
  Sunrise,
  Sunset,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { localInputValue, menuTime, type SnoozeChoice, snoozeOptions } from "./snooze-times";

/** "In 1 hour" keeps `Clock`, the one other meaning that glyph has (SPEC R9). */
const CHOICE_ICON: Record<SnoozeChoice, LucideIcon> = {
  hour: Clock,
  evening: Sunset,
  tomorrow: Sunrise,
  week: CalendarDays,
};

/** The items of the Later menu, for a dropdown or a submenu. */
export function SnoozeMenuItems({
  onSnooze,
  onPickDate,
}: {
  onSnooze: (at: string) => void;
  onPickDate: () => void;
}) {
  const now = new Date();
  return (
    <>
      <DropdownMenuLabel className="text-meta font-medium tracking-wide text-muted-foreground uppercase">
        Later until
      </DropdownMenuLabel>
      {snoozeOptions(now).map((option) => {
        const Icon = CHOICE_ICON[option.id];
        return (
          <DropdownMenuItem key={option.id} onSelect={() => onSnooze(option.at)}>
            <Icon />
            {option.label}
            <span className="ml-auto pl-4 font-mono text-meta tabular-nums text-muted-foreground">
              {menuTime(option.at, now)}
            </span>
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuItem onSelect={onPickDate}>
        <CalendarClock />
        Pick a date and time…
      </DropdownMenuItem>
      <p className="flex max-w-64 gap-1.5 px-2 pt-1.5 pb-1 text-meta text-muted-foreground">
        <Bell aria-hidden className="mt-px size-3 shrink-0" />
        We notify you in this browser while the dashboard is open.
      </p>
    </>
  );
}

/** "Pick a date and time…": a small dialog with a date and time field. */
export function SnoozeDateDialog({
  open,
  onOpenChange,
  onSnooze,
  onRestoreFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (at: string) => void;
  /** Focus goes back to the list when the dialog closes (the menu that opened it is gone). */
  onRestoreFocus: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        {/* A new form per open: the field starts from tomorrow 14:00 each time. */}
        {open ? <SnoozeDateForm onSnooze={onSnooze} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function SnoozeDateForm({
  onSnooze,
  onCancel,
}: {
  onSnooze: (at: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(14, 0, 0, 0);
    return localInputValue(d);
  });
  const [hint, setHint] = useState(false);
  const at = value ? new Date(value) : null;
  const time = at?.getTime() ?? Number.NaN;
  const blocked = Number.isNaN(time)
    ? "Pick a date and time."
    : time <= Date.now()
      ? "Pick a time in the future."
      : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!blocked && at) onSnooze(at.toISOString());
  };
  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Later until</DialogTitle>
        <DialogDescription>Back in your Inbox as unread at that time.</DialogDescription>
      </DialogHeader>
      <Input
        type="datetime-local"
        aria-label="Wake date and time"
        value={value}
        min={localInputValue(new Date())}
        onChange={(event) => setValue(event.target.value)}
        aria-invalid={blocked !== null}
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {/* Blocked, not disabled: the tooltip says why (dashboard-ui rule). It stays
            mounted, so the button never remounts when the reason comes and goes. */}
        <Tooltip open={blocked !== null && hint} onOpenChange={setHint}>
          <TooltipTrigger asChild>
            <Button
              type="submit"
              aria-disabled={blocked !== null}
              className="aria-disabled:opacity-50"
            >
              Snooze
            </Button>
          </TooltipTrigger>
          <TooltipContent>{blocked}</TooltipContent>
        </Tooltip>
      </DialogFooter>
    </form>
  );
}

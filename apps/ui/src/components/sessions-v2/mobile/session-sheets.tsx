/**
 * The phone sheets of the sessions list (SPEC R8.5): Later (the snooze
 * choices, opened by a right swipe or the selection bar) and the group
 * sheet (a long-press on a group). They hold the same choices as the
 * desktop Later menu and group menu, in 48 px rows.
 */

import { Bell, CalendarClock } from "lucide-react";
import { type GroupMenuActions, type GroupMenuState, groupMenuItems } from "../sidebar/group-menu";
import { useLastValue } from "../sidebar/point-menu";
import { CHOICE_ICON, LATER_NOTE } from "../sidebar/snooze-picker";
import { menuTime, snoozeOptions } from "../sidebar/snooze-times";
import {
  ActionSheet,
  ActionSheetItem,
  ActionSheetNote,
  ActionSheetSeparator,
} from "./action-sheet";

/** "Later: Weekly price digest", or "Later: 3 sessions" (UX review R9). */
export function SnoozeSheet({
  open,
  onOpenChange,
  what,
  onSnooze,
  onPickDate,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The session title, or "3 sessions". */
  what: string;
  onSnooze: (at: string) => void;
  onPickDate: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const now = new Date();
  return (
    <ActionSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Later: ${what}`}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      {snoozeOptions(now).map((option) => (
        <ActionSheetItem
          key={option.id}
          icon={CHOICE_ICON[option.id]}
          label={option.label}
          detail={menuTime(option.at, now)}
          onSelect={() => onSnooze(option.at)}
        />
      ))}
      <ActionSheetItem icon={CalendarClock} label="Pick a date and time…" onSelect={onPickDate} />
      <ActionSheetNote>
        <Bell aria-hidden className="mr-1.5 inline size-3.5 align-[-2px]" />
        {LATER_NOTE}
      </ActionSheetNote>
    </ActionSheet>
  );
}

/** A long-press on one of my groups: the desktop group menu as a sheet. */
export function GroupSheet({
  state,
  actions,
  onClose,
  onRestoreFocus,
}: {
  state: GroupMenuState | null;
  actions: GroupMenuActions;
  onClose: () => void;
  /** The sheet is gone: run what waited for it, else focus the list. */
  onRestoreFocus: () => void;
}) {
  // The last group stays while the sheet slides out.
  const shown = useLastValue(state);
  if (!shown) return null;
  const { edits, remove } = groupMenuItems(shown, actions);
  return (
    <ActionSheet
      open={state !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`# ${shown.label}`}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        onRestoreFocus();
      }}
    >
      {edits.map(({ label, icon, disabled, run }) => (
        <ActionSheetItem key={label} icon={icon} label={label} disabled={disabled} onSelect={run} />
      ))}
      {shown.writeBlock ? <ActionSheetNote>{shown.writeBlock}</ActionSheetNote> : null}
      <ActionSheetSeparator />
      <ActionSheetItem icon={remove.icon} label={remove.label} destructive onSelect={remove.run} />
    </ActionSheet>
  );
}

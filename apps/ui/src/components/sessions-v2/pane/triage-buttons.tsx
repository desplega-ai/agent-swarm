/**
 * The triage buttons of the session header (SPEC R8.1, R9): Mark read or
 * unread, Done, Later, and Move to group. A session in Done or Later shows a
 * pressed Inbox button that moves it back to the Inbox: the name stays
 * "Done" or "Later", `aria-pressed` carries the state, and the tooltip says
 * "Move back to the Inbox". The tooltips name the sidebar keys, and the
 * keys act here too while the focus is outside the sidebar. Read, Done, and
 * Later need a picked user: without one, only Move shows.
 */

import {
  AlarmClock,
  Archive,
  FolderInput,
  Inbox,
  type LucideIcon,
  Mail,
  MailOpen,
} from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";
import type { SessionListItem } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SnoozeDateDialog, SnoozeMenuItems } from "../sidebar/snooze-picker";
import { TipKey } from "../sidebar/tree-row";
import { useSessionTriageActions } from "../use-session-triage-actions";
import { focusQuietly, useQuietTooltip } from "./quiet-focus";
import { usePaneKeys } from "./use-pane-keys";

/**
 * A 28 px icon button with its name and key in a tooltip. `pressed` makes it
 * a toggle. `tip` replaces the name in the tooltip (what a click does now).
 */
function HeaderButton({
  icon: Icon,
  label,
  tip = label,
  keyName,
  pressed,
  ...props
}: {
  icon: LucideIcon;
  label: string;
  tip?: string;
  /** The key on `aria-keyshortcuts` and in the tooltip. */
  keyName: string;
  pressed?: boolean;
} & ComponentProps<typeof Button>) {
  const tooltip = useQuietTooltip();
  return (
    <Tooltip {...tooltip}>
      <TooltipTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          aria-keyshortcuts={keyName}
          aria-pressed={pressed}
          className="size-7 text-muted-foreground hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          {...props}
        >
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-1.5">
        {tip}
        <TipKey>{keyName.toUpperCase()}</TipKey>
      </TooltipContent>
    </Tooltip>
  );
}

export function TriageButtons({
  session,
  onMove,
  keysActive = true,
}: {
  session: SessionListItem;
  /** Opens the sidebar's move dialog. `returnFocus` runs when it closes. */
  onMove: (sessions: SessionListItem[], returnFocus: () => void) => void;
  /** The pane keys act here (the active pane of a split). */
  keysActive?: boolean;
}) {
  // The focus comes back to the Later button after its menu or the date
  // dialog, and to Move after the move dialog (also for the keys).
  const laterRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const [laterOpen, setLaterOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const { canTriage, actions, doneOrBack, laterOrBack } = useSessionTriageActions({
    pickDate: () => setDateOpen(true),
    pickGroup: (sessions) => onMove(sessions, () => focusQuietly(moveRef.current)),
  });
  const targets = [session];
  const unread = session.readState === "unread";
  const inDone = session.readState === "done";
  const inLater = session.readState === "later";

  const toggleRead = () => actions.toggleRead(targets);
  const done = () => doneOrBack(targets);
  const later = () => laterOrBack(targets, () => setLaterOpen(true));
  const move = () => actions.move(targets);
  usePaneKeys(canTriage ? { read: toggleRead, done, later, move } : { move }, keysActive);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form fields; these are action buttons
    <div role="group" aria-label="Triage" className="flex items-center gap-px">
      {canTriage ? (
        <>
          <HeaderButton
            icon={unread ? MailOpen : Mail}
            label={unread ? "Mark read" : "Mark unread"}
            keyName="u"
            onClick={toggleRead}
          />
          <HeaderButton
            icon={inDone ? Inbox : Archive}
            label="Done"
            tip={inDone ? "Move back to the Inbox" : "Done"}
            keyName="e"
            pressed={inDone}
            onClick={done}
          />
          {/* One button in both states, so the focus stays on it when a snooze
              or "back to the Inbox" swaps its icon. In Later it opens no menu. */}
          <DropdownMenu
            open={laterOpen}
            onOpenChange={(open) => (open && inLater ? later() : setLaterOpen(open))}
          >
            <DropdownMenuTrigger asChild>
              <HeaderButton
                ref={laterRef}
                icon={inLater ? Inbox : AlarmClock}
                label="Later"
                tip={inLater ? "Move back to the Inbox" : "Later"}
                keyName="l"
                pressed={inLater}
                aria-haspopup={inLater ? undefined : "menu"}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-60"
              onCloseAutoFocus={(event) => {
                // The date dialog takes the focus itself.
                event.preventDefault();
                if (!dateOpen) focusQuietly(laterRef.current);
              }}
            >
              <SnoozeMenuItems
                onSnooze={(at) => actions.later(targets, at)}
                onPickDate={() => actions.pickDate(targets)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
      <HeaderButton
        ref={moveRef}
        icon={FolderInput}
        label="Move to group"
        keyName="m"
        onClick={move}
      />
      <SnoozeDateDialog
        open={dateOpen}
        onOpenChange={setDateOpen}
        onSnooze={(at) => {
          actions.later(targets, at);
          setDateOpen(false);
        }}
        onRestoreFocus={() => focusQuietly(laterRef.current)}
      />
    </div>
  );
}

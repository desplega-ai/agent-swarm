/**
 * The bulk bar (SPEC R5): while sessions are selected it covers the sidebar
 * header with the count and Done, Later, Mark read, Move, and Clear. Done,
 * Later, and Mark read need a picked user: without one, only Move and Clear
 * show. Each icon button names its key in a tooltip. The buttons keep the
 * focus on the tree, so the list keys keep working after a click. They are
 * plain buttons in a labelled group: the keys act on the tree, so the bar
 * needs no arrow-key roving.
 *
 * When the selection is every loaded row of a longer list, the count offers
 * "Select all N". Then the bar acts on the whole list on the server: Done
 * and Mark read only (no Later, no Move).
 */

import { AlarmClock, Archive, FolderInput, type LucideIcon, Mail, MailOpen, X } from "lucide-react";
import type { MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { keepTreeFocus, TipKey } from "./tree-row";

function BarButton({
  icon: Icon,
  label,
  shortcut,
  keyName,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  /** The keycap in the tooltip. */
  shortcut: string;
  /** The key on `aria-keyshortcuts`. */
  keyName: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          aria-keyshortcuts={keyName}
          onMouseDown={keepTreeFocus}
          onClick={onClick}
          className="size-7 text-muted-foreground hover:text-foreground"
        >
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-1.5">
        {label}
        <TipKey>{shortcut}</TipKey>
      </TooltipContent>
    </Tooltip>
  );
}

/** "Select all N" for the bulk bars: the list, its size, and whether it is on. */
export interface WholeListOffer {
  /** The list's name: "Inbox", a group. */
  label: string;
  total: number;
  /** On: the bar acts on all `total` sessions. */
  on: boolean;
  onSelect: () => void;
}

/**
 * The count words of the bulk bars: "All N in Inbox" while "Select all N" is
 * on, "10 of N" while it is offered, else "10 selected". The offer acts on
 * the server by list, so it needs a picked user.
 */
export function bulkCount(
  count: number,
  canTriage: boolean,
  whole: WholeListOffer | null | undefined,
): { label: string; wholeOn: boolean; offer: WholeListOffer | null } {
  const wholeOn = whole?.on === true;
  const offer = whole && !wholeOn && canTriage ? whole : null;
  const label = wholeOn
    ? `All ${whole.total} in ${whole.label}`
    : offer
      ? `${count} of ${offer.total}`
      : `${count} selected`;
  return { label, wholeOn, offer };
}

export function BulkBar({
  count,
  canTriage,
  anyUnread,
  onDone,
  onLater,
  onToggleRead,
  onMove,
  onClear,
  whole,
}: {
  count: number;
  /** Read, Done, and Later need a picked user. */
  canTriage: boolean;
  /** Mark read when any selected session is unread, else Mark unread. */
  anyUnread: boolean;
  onDone: () => void;
  /** Opens the Later menu at the button. */
  onLater: (anchor: DOMRect) => void;
  onToggleRead: () => void;
  onMove: () => void;
  onClear: () => void;
  whole?: WholeListOffer | null;
}) {
  // Short words: the bar shares one line with five buttons in a narrow sidebar.
  const { label, wholeOn, offer } = bulkCount(count, canTriage, whole);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form fields; these are action buttons
    <div
      role="group"
      aria-label={wholeOn || offer ? `${label} selected` : label}
      data-bulk-bar=""
      // Over the sidebar header (h-10), on the same fill as a selected row.
      className="absolute inset-x-0 top-0 z-20 flex h-10 items-center gap-0.5 border-b border-primary/30 bg-surface pr-1.5 pl-4 before:absolute before:inset-0 before:-z-10 before:bg-primary/10"
    >
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-semibold tabular-nums">{label}</span>
        {offer ? (
          <button
            type="button"
            aria-label={`Select all ${offer.total} in ${offer.label}`}
            onMouseDown={keepTreeFocus}
            onClick={offer.onSelect}
            className="shrink-0 text-sm text-primary hover:underline"
          >
            Select all
          </button>
        ) : null}
      </span>
      {canTriage ? (
        <>
          <BarButton icon={Archive} label="Done" shortcut="E" keyName="e" onClick={onDone} />
          {wholeOn ? null : (
            <BarButton
              icon={AlarmClock}
              label="Later"
              shortcut="L"
              keyName="l"
              onClick={(event) => onLater(event.currentTarget.getBoundingClientRect())}
            />
          )}
          <BarButton
            icon={anyUnread ? MailOpen : Mail}
            label={anyUnread ? "Mark read" : "Mark unread"}
            shortcut="U"
            keyName="u"
            onClick={onToggleRead}
          />
        </>
      ) : null}
      {wholeOn ? null : (
        <BarButton
          icon={FolderInput}
          label="Move to group"
          shortcut="M"
          keyName="m"
          onClick={onMove}
        />
      )}
      <BarButton
        icon={X}
        label="Clear selection"
        shortcut="Esc"
        keyName="Escape"
        onClick={onClear}
      />
    </div>
  );
}

/**
 * The bulk bar (SPEC R5): while sessions are selected it covers the sidebar
 * header with the count and Done, Later, Mark read, Move, and Clear. Done,
 * Later, and Mark read need a picked user: without one, only Move and Clear
 * show. Each icon button names its key in a tooltip. The buttons keep the
 * focus on the tree, so the list keys keep working after a click. They are
 * plain buttons in a labelled group: the keys act on the tree, so the bar
 * needs no arrow-key roving.
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

export function BulkBar({
  count,
  canTriage,
  anyUnread,
  onDone,
  onLater,
  onToggleRead,
  onMove,
  onClear,
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
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form fields; these are action buttons
    <div
      role="group"
      aria-label={`${count} selected`}
      data-bulk-bar=""
      // Over the sidebar header (h-10), on the same fill as a selected row.
      className="absolute inset-x-0 top-0 z-20 flex h-10 items-center gap-0.5 border-b border-primary/30 bg-surface pr-1.5 pl-4 before:absolute before:inset-0 before:-z-10 before:bg-primary/10"
    >
      <span className="min-w-0 flex-1 truncate text-sm font-semibold tabular-nums">
        {count} selected
      </span>
      {canTriage ? (
        <>
          <BarButton icon={Archive} label="Done" shortcut="E" keyName="e" onClick={onDone} />
          <BarButton
            icon={AlarmClock}
            label="Later"
            shortcut="L"
            keyName="l"
            onClick={(event) => onLater(event.currentTarget.getBoundingClientRect())}
          />
          <BarButton
            icon={anyUnread ? MailOpen : Mail}
            label={anyUnread ? "Mark read" : "Mark unread"}
            shortcut="U"
            keyName="u"
            onClick={onToggleRead}
          />
        </>
      ) : null}
      <BarButton
        icon={FolderInput}
        label="Move to group"
        shortcut="M"
        keyName="m"
        onClick={onMove}
      />
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

/**
 * The phone selection bars (SPEC R8.5): a long-press starts a selection.
 * "N selected" covers the screen's top bar, and a bottom bar holds Done,
 * Later, Read (or Unread), Move, and Cancel in 56 px buttons. Done, Later,
 * and Read need a picked user: without one, only Move and Cancel show.
 *
 * The top bar offers "Select all": first the loaded rows of the list, then
 * "Select all N" for the whole list. On the whole list the bottom bar holds
 * Done, Read, and Cancel (no Later, no Move): it acts on the server.
 *
 * The bottom bar slides up in 200 ms and back down in 150 ms (snappy, UX
 * review R9). Reduced motion drops the slide and keeps the fade (the app's
 * `MotionConfig reducedMotion="user"`).
 */

import { AlarmClock, Archive, FolderInput, type LucideIcon, Mail, MailOpen, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { bulkCount, type WholeListOffer } from "../sidebar/bulk-bar";
import { useLastValue } from "../sidebar/point-menu";

const SNAPPY = [0.2, 0, 0, 1] as const;

function BarButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className="h-14 min-w-0 flex-1 flex-col gap-1 px-1 text-meta font-medium text-muted-foreground active:text-foreground"
    >
      <Icon className="size-5" />
      {label}
    </Button>
  );
}

export interface MobileBulkBarProps {
  /** Sessions are selected. */
  open: boolean;
  count: number;
  canTriage: boolean;
  anyUnread: boolean;
  onDone: () => void;
  onLater: () => void;
  onToggleRead: () => void;
  onMove: () => void;
  onClear: () => void;
  /** "Select all": the loaded rows of the selection's list. Missing when they are all selected. */
  onSelectList?: () => void;
  /** "Select all N" (see `BulkBar`). */
  whole?: WholeListOffer | null;
}

export function MobileBulkBar({ open, count, ...props }: MobileBulkBarProps) {
  // The bars keep their words while they leave.
  const shown = useLastValue(open ? { count, ...props } : null);
  return (
    <AnimatePresence initial={false}>
      {open && shown ? <Bars key="bars" {...shown} /> : null}
    </AnimatePresence>
  );
}

function Bars({
  count,
  canTriage,
  anyUnread,
  onDone,
  onLater,
  onToggleRead,
  onMove,
  onClear,
  onSelectList,
  whole,
}: Omit<MobileBulkBarProps, "open">) {
  const { label, wholeOn, offer } = bulkCount(count, canTriage, whole);
  const select = offer
    ? { text: `Select all ${offer.total}`, run: offer.onSelect }
    : !wholeOn && onSelectList
      ? { text: "Select all", run: onSelectList }
      : null;
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: 0.15, ease: SNAPPY } }}
        exit={{ opacity: 0, transition: { duration: 0.1, ease: SNAPPY } }}
        className="absolute inset-x-0 top-0 z-20 flex h-14 items-center justify-center border-b border-primary/30 bg-background px-4 before:absolute before:inset-0 before:-z-10 before:bg-primary/10"
      >
        <span aria-hidden className="truncate text-base font-semibold tabular-nums">
          {label}
        </span>
        {select ? (
          <Button
            variant="ghost"
            onClick={select.run}
            className="absolute right-1 h-11 px-3 text-base text-primary tabular-nums"
          >
            {select.text}
          </Button>
        ) : null}
      </motion.div>
      <motion.div
        role="group"
        aria-label={label}
        initial={{ y: "100%", opacity: 0 }}
        animate={{ y: 0, opacity: 1, transition: { duration: 0.2, ease: SNAPPY } }}
        exit={{ y: "100%", opacity: 0, transition: { duration: 0.15, ease: SNAPPY } }}
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-background px-1 pb-[env(safe-area-inset-bottom)]"
      >
        {canTriage ? (
          <>
            <BarButton icon={Archive} label="Done" onClick={onDone} />
            {wholeOn ? null : <BarButton icon={AlarmClock} label="Later" onClick={onLater} />}
            <BarButton
              icon={anyUnread ? MailOpen : Mail}
              label={anyUnread ? "Read" : "Unread"}
              onClick={onToggleRead}
            />
          </>
        ) : null}
        {wholeOn ? null : <BarButton icon={FolderInput} label="Move" onClick={onMove} />}
        <BarButton icon={X} label="Cancel" onClick={onClear} />
      </motion.div>
    </>
  );
}

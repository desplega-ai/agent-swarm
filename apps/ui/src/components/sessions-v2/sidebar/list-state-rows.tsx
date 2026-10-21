/**
 * The rows a sidebar list adds around its sessions: "Show 10 more" and
 * "View all N" (SPEC R6), the centered empty state (R5), and the loading
 * placeholder. An empty or loading line carries an id, so the row it sits
 * under can point at it (`aria-describedby`).
 */

import {
  AlarmClock,
  Archive,
  ArrowRight,
  ChevronDown,
  CircleAlert,
  FolderPlus,
  Hash,
  Inbox,
  type LucideIcon,
  SquareDashed,
} from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { TreeRow } from "./tree-row";
import type { EmptyKind } from "./tree-rows";

const EMPTY: Record<EmptyKind, { icon: LucideIcon; title: string; hint?: ReactNode }> = {
  inbox: { icon: Inbox, title: "Inbox clear.", hint: "Nothing waits on you." },
  later: {
    icon: AlarmClock,
    title: "Nothing snoozed.",
    hint: (
      <>
        Press <Kbd>L</Kbd> on a session.
      </>
    ),
  },
  done: {
    icon: Archive,
    title: "Nothing Done yet.",
    hint: (
      <>
        Press <Kbd>E</Kbd> on a session.
      </>
    ),
  },
  nogroup: { icon: SquareDashed, title: "Every session has a group." },
  group: { icon: Hash, title: "Nothing in your Inbox here." },
  groups: {
    icon: FolderPlus,
    title: "Group your sessions",
    hint: "Sessions you move into a group show here.",
  },
  failed: { icon: CircleAlert, title: "Couldn't load these sessions." },
};

/** "Show 10 more" (once) or "View all N" (opens the group tab). */
export function PagingRow({
  id,
  level,
  cursor,
  label,
  all,
  onClick,
}: {
  id: string;
  level: number;
  cursor: boolean;
  label: string;
  /** "View all": an arrow, not a chevron. */
  all: boolean;
  onClick: (event: MouseEvent) => void;
}) {
  const Icon = all ? ArrowRight : ChevronDown;
  return (
    <TreeRow
      id={id}
      level={level}
      cursor={cursor}
      onClick={onClick}
      className="h-[26px] text-data font-medium text-muted-foreground hover:text-foreground"
    >
      <span aria-hidden className="size-4 shrink-0" />
      {label}
      <Icon aria-hidden className="size-3.5" />
    </TreeRow>
  );
}

/** A centered empty state. Its key hint shows only to someone who can triage. */
export function EmptyRow({
  id,
  level,
  kind,
  showHint,
}: {
  id: string;
  level: number;
  kind: EmptyKind;
  showHint: boolean;
}) {
  const empty = EMPTY[kind];
  return (
    <div id={id} role="none" style={{ paddingLeft: `${level * 14}px` }} className="mx-1.5">
      <EmptyState
        compact
        icon={empty.icon}
        title={empty.title}
        description={showHint || kind === "groups" ? empty.hint : undefined}
        className={kind === "groups" ? "py-6" : undefined}
      />
    </div>
  );
}

/** The placeholder while an open list loads. */
export function LoadingRow({ id, level }: { id: string; level: number }) {
  return (
    <div
      id={id}
      role="none"
      style={{ paddingLeft: `${level * 14 + 28}px` }}
      className="mx-1.5 flex flex-col gap-2 py-1.5 pr-3"
    >
      <span className="sr-only">Loading sessions.</span>
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-3/4" />
    </div>
  );
}

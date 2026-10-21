/**
 * The rows a sidebar list adds around its sessions: "Show 10 more" and
 * "View all N" (SPEC R6), the centered empty state (R5), the loading
 * placeholder, and the group rows of My groups: "New group" and the name
 * field of a new group. An empty or loading line carries an id, so the row
 * it sits under can point at it (`aria-describedby`).
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
  Search,
  SquareDashed,
} from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { GroupNameField } from "./group-node";
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
  // SPEC R6: the first visit after the release, when every session has the default key.
  groups: {
    icon: FolderPlus,
    title: "Group your sessions",
    hint: (
      <>
        Select sessions and press <Kbd>M</Kbd> to move them into a group.
      </>
    ),
  },
  fresh: {
    icon: Hash,
    title: "No sessions here yet.",
    hint: (
      <>
        Drag a session here, or press <Kbd>M</Kbd> on one.
      </>
    ),
  },
  search: { icon: Search, title: "No sessions match." },
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

/** The phone words for the hints that name a key: touch has no keys (SPEC R8.5). */
const PHONE_HINT: Partial<Record<EmptyKind, string>> = {
  later: "Swipe a session to the right.",
  done: "Swipe a session to the left.",
  groups: "Long-press sessions, then tap Move.",
  fresh: "Long-press a session, then tap Move.",
};

/** Hints that need a picked user: Later and Done (triage). Move hints work for anyone. */
const TRIAGE_HINTS = new Set<EmptyKind>(["later", "done"]);

/**
 * A centered empty state: text only, so no control sits inside the tree.
 * "New group" is a row of its own. A Later or Done key hint shows only to
 * someone who can triage. `note` replaces the hint (search). `phone` swaps
 * the key hints for touch words.
 */
export function EmptyRow({
  id,
  level,
  kind,
  canTriage,
  note,
  phone,
}: {
  id: string;
  level: number;
  kind: EmptyKind;
  canTriage: boolean;
  note?: string;
  phone?: boolean;
}) {
  const empty = EMPTY[kind];
  const keyHint = phone && PHONE_HINT[kind] !== undefined ? PHONE_HINT[kind] : empty.hint;
  const hint = canTriage || !TRIAGE_HINTS.has(kind) ? keyHint : undefined;
  return (
    <div id={id} role="none" style={{ paddingLeft: `${level * 14}px` }} className="mx-1.5">
      <EmptyState
        compact
        icon={empty.icon}
        title={empty.title}
        description={note ?? hint}
        className={kind === "groups" ? "pt-6 pb-3" : undefined}
      />
    </div>
  );
}

/** "New group" at the end of My groups: it opens the name field. */
export function AddGroupRow({
  id,
  cursor,
  onClick,
}: {
  id: string;
  cursor: boolean;
  onClick: (event: MouseEvent) => void;
}) {
  return (
    <TreeRow
      id={id}
      level={0}
      cursor={cursor}
      onClick={onClick}
      className="h-7 text-data font-medium text-muted-foreground hover:text-foreground"
    >
      <span className="grid size-4 shrink-0 place-items-center">
        <FolderPlus aria-hidden className="size-3.5" />
      </span>
      New group
    </TreeRow>
  );
}

/** The name field of a new group, where its row will be. */
export function CreateGroupRow({
  level,
  subgroup,
  onDone,
}: {
  level: number;
  subgroup: boolean;
  onDone: (name: string | null) => void;
}) {
  return (
    <TreeRow level={level} cursor={false} className="h-7 text-data">
      <span className="grid size-4 shrink-0 place-items-center">
        <Hash aria-hidden className="size-3.5 text-muted-foreground" />
      </span>
      <GroupNameField label={subgroup ? "New subgroup name" : "New group name"} onDone={onDone} />
    </TreeRow>
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

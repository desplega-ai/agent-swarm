/**
 * What a tab shows (plan Phase 8): the title, the tooltip, the icon, the
 * read mark, and the activity mark. The tab strip and "All tabs" share it.
 */

import {
  AlarmClock,
  Archive,
  Hash,
  Inbox,
  type LucideIcon,
  SquareDashed,
  SquarePen,
} from "lucide-react";
import { useSessionLabels } from "@/api/hooks/use-session-tree";
import { type SessionPoll, useSession } from "@/api/hooks/use-sessions";
import { useUsers } from "@/api/hooks/use-users";
import { TaskSourceMark } from "@/components/shared/task-source-mark";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { useCurrentUser } from "@/contexts/current-user-context";
import { groupCrumb, groupLabel, sourceOfGroupKey } from "@/lib/session-groups";
import {
  GROUP_TAB,
  isSessionTab,
  itemFromDetail,
  NEW_SESSION_TAB,
  type SessionSection,
  userName,
} from "@/lib/sessions-v2";
import { sessionDisplayTitle } from "@/lib/utils";
import { type Activity, activityOf } from "../sidebar/session-row";

const SECTION_TABS: Record<SessionSection, { title: string; icon: LucideIcon }> = {
  inbox: { title: "Inbox", icon: Inbox },
  later: { title: "Later", icon: AlarmClock },
  done: { title: "Done", icon: Archive },
  nogroup: { title: "No group", icon: SquareDashed },
};

/** The name and icon of a section list (`?view=inbox`), or undefined for a group key. */
export function sectionTab(view: string | null): { title: string; icon: LucideIcon } | undefined {
  return view && view in SECTION_TABS ? SECTION_TABS[view as SessionSection] : undefined;
}

/** What a tab shows: its title, its tooltip, its icon, its read state, and its activity. */
export interface TabInfo {
  title: string;
  /** The full title and the group path, for the tooltip. */
  tip: string;
  icon: LucideIcon | null;
  /** A source group's tab: the source whose logo shows in place of `icon`. */
  source?: string;
  unread: boolean;
  activity: Activity;
}

/** The icon of a tab: a source group shows its source logo. */
export function TabIcon({ info }: { info: TabInfo }) {
  if (info.source) return <TaskSourceMark source={info.source} />;
  const Icon = info.icon;
  return Icon ? <Icon aria-hidden className="size-3.5 shrink-0" /> : null;
}

const ACTIVITY_WORDS: Record<Exclude<Activity, null>, string> = {
  needs: "Needs you",
  running: "Running",
  failed: "Failed",
};

/** The accessible name of a tab: its read state, its activity, then its title. */
export function tabLabel(info: TabInfo): string {
  const words = [info.unread && "Unread", info.activity && ACTIVITY_WORDS[info.activity]];
  return [...words.filter(Boolean), info.title].join(". ");
}

/**
 * The look of a tab. A session tab reads its session detail (the same cache
 * as the pane). `poll` sets this reader's own timer: a background tab polls
 * every 30 s, so many tabs stay cheap, and a tab whose pane is open, or a
 * menu row, adds none. The group tab names its list.
 */
export function useTabInfo(tab: string, view: string | null, poll: SessionPoll = "off"): TabInfo {
  const { userId } = useCurrentUser();
  const me = userId ?? null;
  const { data: detail, error } = useSession(isSessionTab(tab) ? tab : undefined, { poll });
  const { data: users } = useUsers();
  const nameOf = (id: string) => userName(users, id);
  const labels = useSessionLabels();

  if (tab === NEW_SESSION_TAB) {
    return {
      title: "New session",
      tip: "New session",
      icon: SquarePen,
      unread: false,
      activity: null,
    };
  }
  if (tab === GROUP_TAB) {
    const section = sectionTab(view);
    const crumb = section?.title ?? groupCrumb(view ?? undefined, me, nameOf, labels);
    const title = section?.title ?? (groupLabel(view ?? undefined, me, labels) || crumb);
    return {
      title,
      tip: `All sessions in ${crumb}`,
      icon: section?.icon ?? Hash,
      source: (!section && view && sourceOfGroupKey(view)) || undefined,
      unread: false,
      activity: null,
    };
  }
  if (!detail) {
    const title = error ? "Session unavailable" : "Loading…";
    return { title, tip: title, icon: null, unread: false, activity: null };
  }
  const title = sessionDisplayTitle(detail.root);
  const item = itemFromDetail(detail);
  const crumb = groupCrumb(item.groupKey, me, nameOf, labels);
  return {
    title,
    tip: `${title} · ${crumb}`,
    icon: null,
    unread: item.readState === "unread",
    activity: activityOf(item),
  };
}

/** The activity mark: running turns (Taras, 2026-10-22). Needs you is a small amber dot, so the title keeps its width. */
export function TabActivity({ activity }: { activity: Activity }) {
  if (activity === "needs") {
    return (
      <span
        role="img"
        aria-label="Needs you"
        className="size-[7px] shrink-0 rounded-full bg-status-active"
      />
    );
  }
  if (activity === "running") {
    return <TaskStatusIcon variant="active" label="Running" className="size-3.5" />;
  }
  if (activity === "failed") {
    return <TaskStatusIcon status="failed" label="Failed" className="size-3.5" />;
  }
  return null;
}

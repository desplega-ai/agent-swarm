/**
 * The People popover of the session header (SPEC R3, R7, R8.1): each person
 * with their access, their last message, and a live dot while they are
 * here; general access when it is more than Private; then the workers with
 * their task counts; then "Share…" for the owner.
 */

import type { LucideIcon } from "lucide-react";
import { Share2 } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { useAgents } from "@/api/hooks/use-agents";
import { useSessionShares } from "@/api/hooks/use-sessions";
import { useUsers } from "@/api/hooks/use-users";
import type { SessionDetailResponse } from "@/api/types";
import { PersonRow } from "@/components/sessions/person-row";
import { useSessionPresenceContext } from "@/components/sessions/session-presence";
import { EVERYONE_ICON } from "@/components/sessions/share-session-dialog";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { useOverlayKind } from "@/components/shared/responsive-overlay";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useCurrentUser } from "@/contexts/current-user-context";
import { peerColorVar } from "@/lib/comb/presence";
import type { SessionViewer } from "@/lib/session-presence";
import { plural, userName } from "@/lib/sessions-v2";
import { cn, formatRelativeTime } from "@/lib/utils";

export interface PanePerson {
  id: string;
  name: string;
  /** "Owner", "Can edit", "Can view", or "Everyone" (general access). Null when unknown. */
  access: string | null;
  /** The newest message this person wrote in the session. */
  lastMessageAt: string | null;
  /** Another person here now (their presence color, typing). */
  live: SessionViewer | null;
  me: boolean;
}

export interface PaneEveryone {
  icon: LucideIcon;
  access: string;
}

export interface PaneAgent {
  id: string;
  tasks: number;
}

const SHARE_ACCESS = { read: "Can view", write: "Can edit" } as const;

/**
 * The workers of a session, in order of their first task, with their task
 * counts: the agents of the tasks the lead did not run. The lead speaks as
 * the swarm and never shows by name (SPEC R7).
 */
export function sessionWorkers(detail: SessionDetailResponse): PaneAgent[] {
  const tasks = new Map([detail.root, ...detail.chain].map((task) => [task.id, task]));
  const counts = new Map<string, number>();
  for (const task of tasks.values()) {
    if (!task.agentId || task.isLeadTask) continue;
    counts.set(task.agentId, (counts.get(task.agentId) ?? 0) + 1);
  }
  return [...counts].map(([id, tasks]) => ({ id, tasks }));
}

/**
 * Everyone in the session: the owner, the people who wrote a message (the
 * root, or a dashboard follow-up: a `ui` task with a requester), the people
 * it is shared with, the people here now, and me. Then general access
 * and the workers.
 */
export function useSessionPeople(detail: SessionDetailResponse) {
  const { userId } = useCurrentUser();
  const { data: users } = useUsers();
  const { data: shares } = useSessionShares(detail.root.id);
  const { viewers } = useSessionPresenceContext();

  return useMemo(() => {
    const nameOf = (id: string) =>
      id === detail.owner?.id ? detail.owner.name : userName(users, id);
    const people = new Map<string, PanePerson>();
    const add = (id: string, name?: string) => {
      let person = people.get(id);
      if (!person) {
        person = {
          id,
          name: name ?? nameOf(id),
          access: null,
          lastMessageAt: null,
          live: null,
          me: id === userId,
        };
        people.set(id, person);
      }
      return person;
    };

    if (detail.owner) add(detail.owner.id, detail.owner.name);
    const tasks = new Map([detail.root, ...detail.chain].map((task) => [task.id, task]));
    for (const task of tasks.values()) {
      const message = task.id === detail.root.id || task.source === "ui";
      if (!message || !task.requestedByUserId) continue;
      const person = add(task.requestedByUserId);
      if (!person.lastMessageAt || task.createdAt > person.lastMessageAt) {
        person.lastMessageAt = task.createdAt;
      }
    }
    for (const share of shares?.users ?? []) add(share.userId);
    for (const viewer of viewers) add(viewer.id, viewer.name).live = viewer;
    if (userId) add(userId);

    const everyoneAccess = shares && shares.everyone !== "none" ? shares.everyone : null;
    for (const person of people.values()) {
      const share = shares?.users.find((s) => s.userId === person.id);
      person.access =
        person.id === detail.owner?.id
          ? "Owner"
          : share
            ? SHARE_ACCESS[share.access]
            : person.me && (detail.access === "read" || detail.access === "write")
              ? SHARE_ACCESS[detail.access]
              : everyoneAccess
                ? "Everyone"
                : null;
    }

    return {
      people: [...people.values()],
      everyone: everyoneAccess
        ? { icon: EVERYONE_ICON[everyoneAccess], access: SHARE_ACCESS[everyoneAccess] }
        : null,
      agents: sessionWorkers(detail),
    };
  }, [detail, users, shares, viewers, userId]);
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 pt-1.5 pb-1 text-meta font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  );
}

/** A row of the popover: the shared person row, inset like a menu item. */
const ROW = "px-2";

/** The popover body. `onShare` is set for the owner. */
export function PeopleList({
  people,
  everyone,
  agents,
  onShare,
}: ReturnType<typeof useSessionPeople> & { onShare?: () => void }) {
  const { data: allAgents } = useAgents();
  // In a phone sheet, Share… is a 44 px row.
  const touch = useOverlayKind() === "drawer";
  const agentName = (id: string) =>
    allAgents?.find((agent) => agent.id === id)?.name ?? `${id.slice(0, 8)}…`;
  const access = (label: string) => (
    <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
  );

  return (
    <div className="flex flex-col">
      <SectionLabel>People</SectionLabel>
      <ul className="flex flex-col">
        {people.map((person) => {
          // Mine is always true, so my row has no live mark (UX review R9).
          const live = person.me ? null : person.live;
          return (
            <PersonRow
              key={person.id}
              className={ROW}
              avatar={
                <span className="relative shrink-0">
                  <UserAvatar id={person.id} name={person.name} />
                  {live ? (
                    <span
                      aria-hidden
                      className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-popover"
                      style={{ backgroundColor: peerColorVar(live.color) }}
                    />
                  ) : null}
                </span>
              }
              name={
                <>
                  <span className="truncate">{person.name}</span>
                  {person.me ? <span className="shrink-0 text-muted-foreground">(you)</span> : null}
                  {live ? (
                    <span className="shrink-0 text-meta font-medium text-muted-foreground">
                      {live.typing ? "Typing…" : "Viewing now"}
                    </span>
                  ) : null}
                </>
              }
              detail={
                person.lastMessageAt
                  ? `Last message ${formatRelativeTime(person.lastMessageAt)}`
                  : "No messages yet"
              }
            >
              {person.access ? access(person.access) : null}
            </PersonRow>
          );
        })}
        {everyone ? (
          <PersonRow
            className={ROW}
            avatar={
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
                <everyone.icon aria-hidden className="size-3.5 text-muted-foreground" />
              </span>
            }
            name="Everyone on this swarm"
            detail="General access"
          >
            {access(everyone.access)}
          </PersonRow>
        ) : null}
      </ul>
      {agents.length > 0 ? (
        <>
          <Separator className="my-1 bg-border-subtle" />
          <SectionLabel>Agents</SectionLabel>
          <ul className="flex flex-col">
            {agents.map((agent) => (
              <PersonRow
                key={agent.id}
                className={ROW}
                avatar={
                  <AgentAvatar agentId={agent.id} agentName={agentName(agent.id)} size="sm" />
                }
                name={<span className="truncate">{agentName(agent.id)}</span>}
              >
                <span className="shrink-0 font-mono text-meta tabular-nums text-muted-foreground">
                  {plural(agent.tasks, "task")}
                </span>
              </PersonRow>
            ))}
          </ul>
        </>
      ) : null}
      {onShare ? (
        <>
          <Separator className="my-1 bg-border-subtle" />
          <Button
            variant="ghost"
            size="sm"
            onClick={onShare}
            className={cn("justify-start px-2", touch && "h-11 text-base")}
          >
            <Share2 className="size-3.5" />
            Share…
          </Button>
        </>
      ) : null}
    </div>
  );
}

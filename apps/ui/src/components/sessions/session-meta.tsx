/**
 * Sessions surface — the quiet meta caption under a session title: whole-tree
 * status, task count, agents, failures, requester, and cost. Shared by the
 * `/sessions/:rootTaskId` header and the contextual session panel.
 */

import { type ReactNode, useMemo } from "react";
import { useAgents } from "@/api/hooks/use-agents";
import { useSessionCosts } from "@/api/hooks/use-costs";
import { useUsers } from "@/api/hooks/use-users";
import type { SessionDetailResponse } from "@/api/types";
import { AvatarStack } from "@/components/kibo-ui/avatar-stack";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { StatusBadge } from "@/components/shared/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { deriveSessionStatus } from "@/lib/session-status";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

export interface SessionMetaProps {
  detail: SessionDetailResponse;
  /** Extra controls at the end of the row, e.g. the handoffs toggle. */
  children?: ReactNode;
}

export function SessionMeta({ detail, children }: SessionMetaProps) {
  const { data: users } = useUsers();
  const { data: costs } = useSessionCosts({ taskId: detail.root.id, enabled: true });

  const requestedByUserName = useMemo(() => {
    if (!detail.root.requestedByUserId || !users) return null;
    return users.find((u) => u.id === detail.root.requestedByUserId)?.name ?? null;
  }, [detail, users]);

  // The root task alone can read FAILED while its retry and children are
  // still running, so the header badge reflects the whole tree.
  const sessionStatus = useMemo(() => deriveSessionStatus(detail.root, detail.chain), [detail]);

  // Every agent that worked a task in the session, in order of first appearance.
  const sessionAgentIds = useMemo(() => {
    const ids = [detail.root, ...detail.chain].map((t) => t.agentId).filter(Boolean) as string[];
    return [...new Set(ids)];
  }, [detail]);

  const totalCost = costs?.reduce((sum, c) => sum + c.totalCostUsd, 0) ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground min-w-0 [&>span]:whitespace-nowrap">
      <StatusBadge status={sessionStatus.status} />
      <span className="shrink-0">
        {detail.chain.length} task{detail.chain.length === 1 ? "" : "s"}
      </span>
      {sessionAgentIds.length > 0 ? (
        <>
          <span aria-hidden="true">·</span>
          <SessionAgents agentIds={sessionAgentIds} />
        </>
      ) : null}
      {sessionStatus.failedCount > 0 && sessionStatus.status !== "failed" ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 text-status-error-strong">
            {sessionStatus.failedCount} failed
          </span>
        </>
      ) : null}
      {requestedByUserName ? (
        <>
          <span aria-hidden="true">·</span>
          <span>by {requestedByUserName}</span>
        </>
      ) : null}
      {totalCost > 0 ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="font-mono">{usdFormatter.format(totalCost)}</span>
        </>
      ) : null}
      {children}
    </div>
  );
}

const MAX_STACKED_AGENTS = 5;

/** The session's agents as an overlapping avatar stack; hover lists their names. */
function SessionAgents({ agentIds }: { agentIds: string[] }) {
  const { data: agents } = useAgents();
  const knownName = (id: string) => agents?.find((a) => a.id === id)?.name;
  const names = agentIds.map((id) => knownName(id) ?? `${id.slice(0, 8)}…`);
  const visible = agentIds.slice(0, MAX_STACKED_AGENTS);
  const extra = agentIds.length - visible.length;
  const label = `${agentIds.length} agent${agentIds.length === 1 ? "" : "s"}: ${names.join(", ")}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center gap-1">
          <AvatarStack size={20}>
            {visible.map((id) => (
              <AgentAvatar
                key={id}
                agentId={id}
                agentName={knownName(id)}
                size="xs"
                className="size-full"
              />
            ))}
          </AvatarStack>
          {extra > 0 ? <span className="tabular-nums">+{extra}</span> : null}
          <span className="sr-only">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

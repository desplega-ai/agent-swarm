import { ChevronDown, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import type { Agent } from "@/api/types";
import { HarnessIcon } from "@/components/shared/harness-icon";
import { StatusBadge } from "@/components/shared/status-badge";
import { StatusLine } from "@/components/shared/status-icon";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelative } from "@/lib/relative-time";
import { cn, parseUTCDate } from "@/lib/utils";
import { ExternalTextLink } from "../integrations/pane-parts";

const MAX_ROWS = 8;

/** The lead can take work: some lead agent is idle or busy. */
export function isLeadReady(agents: Agent[] | undefined): boolean {
  return (agents ?? []).some((a) => a.isLead && (a.status === "idle" || a.status === "busy"));
}

function lastSeen(agent: Agent): string {
  const raw = agent.lastActivityAt ?? agent.lastUpdatedAt;
  if (!raw) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - parseUTCDate(raw).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s ago` : formatRelative(raw);
}

/**
 * One secondary line above the composer: the lead's readiness and the agent
 * count. The count opens a popover with the agents.
 */
export function LeadStatusLine({
  agents,
  loading,
  ready,
}: {
  agents: Agent[] | undefined;
  loading: boolean;
  ready: boolean;
}) {
  const list = [...(agents ?? [])].sort((a, b) => Number(b.isLead) - Number(a.isLead));

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm">
      {ready ? (
        <span className="flex items-center gap-2">
          {/* The amber live dot (DESIGN.md): the lead is alive and listening. */}
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
          <span className="font-medium">The lead is ready</span>
        </span>
      ) : (
        <StatusLine tone="busy">Waiting for the lead</StatusLine>
      )}
      <span aria-hidden className="text-muted-foreground/50">
        ·
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-sm text-muted-foreground tabular-nums hover:text-foreground hover-linger transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {loading
              ? "Loading agents"
              : `${list.length} ${list.length === 1 ? "agent" : "agents"}`}
            <ChevronDown className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-80 p-0">
          <AgentList agents={list} loading={loading} />
        </PopoverContent>
      </Popover>
      {ready ? null : (
        <>
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          <span className="text-xs">
            <ExternalTextLink href="https://docs.agent-swarm.dev/docs/guides/deployment">
              How to deploy workers
            </ExternalTextLink>
          </span>
        </>
      )}
    </div>
  );
}

function AgentList({ agents, loading }: { agents: Agent[]; loading: boolean }) {
  const visible = agents.slice(0, MAX_ROWS);
  const hidden = agents.length - visible.length;

  if (loading) {
    return (
      <div className="space-y-2 p-3">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-4/5" />
      </div>
    );
  }
  if (agents.length === 0) {
    return (
      <p className="p-3 text-xs text-muted-foreground">
        No agents yet. With Docker Compose, the lead usually appears within a minute.
      </p>
    );
  }
  return (
    <div>
      <ul className="max-h-72 divide-y divide-border-subtle overflow-y-auto">
        {visible.map((agent) => (
          <li key={agent.id} className="flex items-center gap-2.5 px-3 py-2">
            <Badge
              variant="outline"
              size="tag"
              className={cn("w-14 justify-center", !agent.isLead && "text-muted-foreground")}
            >
              {agent.isLead ? "Lead" : "Worker"}
            </Badge>
            <HarnessIcon harness={agent.harnessProvider ?? agent.provider} className="size-4" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{agent.name}</span>
            <StatusBadge status={agent.status} />
            <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
              {lastSeen(agent)}
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <Link
          to="/agents"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 border-t border-border-subtle px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover-linger transition-colors"
        >
          +{hidden} more
          <ExternalLink className="size-3" />
        </Link>
      ) : null}
    </div>
  );
}

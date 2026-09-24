import { Link } from "react-router-dom";
import type { Agent } from "@/api/types";
import { SetupCard } from "@/components/onboarding/setup-card";
import { HarnessIcon } from "@/components/shared/harness-icon";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
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

export function AgentsCard({
  agents,
  loading,
  ready,
}: {
  agents: Agent[] | undefined;
  loading: boolean;
  ready: boolean;
}) {
  const list = [...(agents ?? [])].sort((a, b) => Number(b.isLead) - Number(a.isLead));
  const visible = list.slice(0, MAX_ROWS);
  const hidden = list.length - visible.length;

  return (
    <div className="space-y-3">
      <SetupCard
        title={
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                ready ? "bg-status-success" : "bg-status-active",
              )}
            />
            {ready ? "The lead is ready." : "Waiting for the lead to be ready"}
          </span>
        }
        status={
          <span className="shrink-0 text-xs text-muted-foreground">
            {list.length} {list.length === 1 ? "agent" : "agents"}
          </span>
        }
        bodyClassName="p-0"
      >
        {/* Shimmer only while we wait on the lead: the one live signal on this step. */}
        {ready ? null : <div className="shimmer-bar relative h-0.5 bg-status-active/60" />}
        {loading ? (
          <div className="space-y-2 px-4 py-3">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-4/5" />
          </div>
        ) : list.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">No agents have registered yet.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {visible.map((agent) => (
              <li key={agent.id} className="flex items-center gap-3 px-4 py-2.5">
                <Badge
                  variant="outline"
                  size="tag"
                  className={cn("w-14", !agent.isLead && "text-muted-foreground")}
                >
                  {agent.isLead ? "Lead" : "Worker"}
                </Badge>
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <HarnessIcon
                    harness={agent.harnessProvider ?? agent.provider}
                    className="size-4"
                  />
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{agent.name}</span>
                <StatusBadge status={agent.status} />
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {lastSeen(agent)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {hidden > 0 ? (
          <Link
            to="/agents"
            className="block border-t border-border-subtle px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover-linger transition-colors"
          >
            +{hidden} more
          </Link>
        ) : null}
      </SetupCard>
      {ready ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2 px-0.5 text-xs text-muted-foreground">
          <span>If you used Docker Compose, the lead usually appears within a minute.</span>
          <ExternalTextLink href="https://docs.agent-swarm.dev/docs/guides/deployment">
            How to deploy workers
          </ExternalTextLink>
        </div>
      )}
    </div>
  );
}

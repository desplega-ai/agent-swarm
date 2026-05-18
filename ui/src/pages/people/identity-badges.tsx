import type { UserIdentity } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Per-kind color token + label for identity-source badges. Uses semantic
 * status/action tokens (no raw Tailwind palette literals — would fail the
 * `check:tokens` lint gate).
 */
const KIND_STYLES: Record<string, { label: string; classes: string }> = {
  slack: {
    label: "Slack",
    classes: "border-status-info/30 bg-status-info/10 text-status-info-strong",
  },
  linear: {
    label: "Linear",
    classes:
      "border-action-delegate-to-agent/30 bg-action-delegate-to-agent/10 text-action-delegate-to-agent",
  },
  github: {
    label: "GitHub",
    classes: "border-status-neutral/30 bg-status-neutral/10 text-foreground",
  },
  gitlab: {
    label: "GitLab",
    classes: "border-status-warning/30 bg-status-warning/10 text-status-warning-strong",
  },
  jira: {
    label: "Jira",
    classes: "border-status-paused/30 bg-status-paused/10 text-status-paused-strong",
  },
  agentmail: {
    label: "AgentMail",
    classes: "border-status-success/30 bg-status-success/10 text-status-success-strong",
  },
  custom: {
    label: "Custom",
    classes: "border-action-script/30 bg-action-script/10 text-action-script",
  },
};

function getKindStyle(kind: string) {
  return (
    KIND_STYLES[kind] ?? {
      label: kind,
      classes: "border-border bg-muted text-foreground",
    }
  );
}

export function IdentityBadge({
  identity,
  showId = false,
}: {
  identity: UserIdentity;
  showId?: boolean;
}) {
  const style = getKindStyle(identity.kind);
  // Show truncated externalId, full on hover.
  const idTrunc =
    identity.externalId.length > 12 ? `${identity.externalId.slice(0, 10)}…` : identity.externalId;
  const display = showId ? `${style.label}: ${idTrunc}` : style.label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" size="tag" className={cn("font-mono normal-case", style.classes)}>
          {display}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-xs">
        {style.label} · {identity.externalId}
      </TooltipContent>
    </Tooltip>
  );
}

export function IdentityBadgeList({
  identities,
  showId = false,
}: {
  identities: UserIdentity[] | undefined;
  showId?: boolean;
}) {
  if (!identities || identities.length === 0) {
    return <span className="text-xs italic text-muted-foreground/50">No identities</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {identities.map((i) => (
        <IdentityBadge key={`${i.kind}:${i.externalId}`} identity={i} showId={showId} />
      ))}
    </div>
  );
}

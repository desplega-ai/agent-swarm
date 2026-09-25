import { ChevronDown, ExternalLink, SquareTerminal } from "lucide-react";
import { Link } from "react-router-dom";
import { useConfigs } from "@/api/hooks/use-config-api";
import {
  type Agent,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffortLevel,
  type SwarmConfig,
} from "@/api/types";
import { setupExitHref } from "@/components/onboarding/onboarding-redirect";
import { ModelLabel } from "@/components/shared/model-logo";
import { REASONING_EFFORT_LABEL } from "@/components/shared/reasoning-effort-icon";
import { StatusBadge } from "@/components/shared/status-badge";
import { StatusLine } from "@/components/shared/status-icon";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HARNESS_LABEL } from "@/lib/agent-runtime-models";
import { type AgentModelDisplay, getAgentModelDisplay } from "@/lib/agents-list-model-display";
import { formatRelative } from "@/lib/relative-time";
import { cn, parseUTCDate } from "@/lib/utils";
import { AiHarnessIcon } from "../ai/harness-switch";
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
        <PopoverContent
          align="center"
          collisionPadding={16}
          className="w-[30rem] max-w-[calc(100vw-2rem)] p-0"
          // Focus the list, not the first harness icon: that would open its tooltip on every open.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
          }}
        >
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

interface AgentOverrides {
  model?: string;
  effort?: ReasoningEffortLevel;
}

function isEffortLevel(value: string): value is ReasoningEffortLevel {
  return (REASONING_EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Agent-scope MODEL_OVERRIDE and REASONING_EFFORT_OVERRIDE rows, by agent id. */
function overridesByAgent(configs: SwarmConfig[] | undefined): Map<string, AgentOverrides> {
  const byAgent = new Map<string, AgentOverrides>();
  for (const row of configs ?? []) {
    if (row.scope !== "agent" || !row.scopeId) continue;
    const value = row.value.trim();
    const entry = byAgent.get(row.scopeId) ?? {};
    if (row.key === "MODEL_OVERRIDE" && value) entry.model = value;
    else if (row.key === "REASONING_EFFORT_OVERRIDE" && isEffortLevel(value)) entry.effort = value;
    else continue;
    byAgent.set(row.scopeId, entry);
  }
  return byAgent;
}

/** The harness icon. Hover or focus shows the harness, the model, and the effort. */
function RuntimeTip({
  harness,
  model,
  modelLoading,
}: {
  harness: string | null | undefined;
  model: AgentModelDisplay;
  modelLoading: boolean;
}) {
  const label = harness ? (HARNESS_LABEL[harness] ?? harness) : "Unknown harness";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the tooltip, so keyboard users can read the model
          tabIndex={0}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <AiHarnessIcon harness={harness} />
          {/* No mark for an unknown harness: a neutral glyph keeps the tooltip reachable. */}
          <SquareTerminal aria-hidden className="hidden size-4 opacity-80 only:block" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-80 text-left">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="opacity-60">Harness</dt>
          <dd>{label}</dd>
          <dt className="opacity-60">Model</dt>
          <dd className="min-w-0">
            {model.primary ? (
              <>
                <ModelLabel model={model.primary} className="max-w-full font-medium" />
                <div className="break-words font-mono text-[10px] opacity-70">{model.primary}</div>
              </>
            ) : modelLoading ? (
              "Loading…"
            ) : (
              "Harness default"
            )}
          </dd>
          {model.reasoningEffort ? (
            <>
              <dt className="opacity-60">Effort</dt>
              <dd>{REASONING_EFFORT_LABEL[model.reasoningEffort]}</dd>
            </>
          ) : null}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}

function AgentList({ agents, loading }: { agents: Agent[]; loading: boolean }) {
  // Mounted only while the popover is open, so the config poll stops when it closes.
  const configsQ = useConfigs({ scope: "agent" });
  const overrides = overridesByAgent(configsQ.data);
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
        {visible.map((agent) => {
          const override = overrides.get(agent.id);
          const latest = agent.credStatus?.latestModel;
          // The configured model first, else the last one the agent reported.
          const model = getAgentModelDisplay(
            override?.model,
            latest?.model,
            override?.effort ?? latest?.reasoningEffort,
          );
          return (
            <li key={agent.id} className="flex items-center gap-2.5 px-3 py-2">
              <Badge
                variant="outline"
                size="tag"
                className={cn("w-14 justify-center", !agent.isLead && "text-muted-foreground")}
              >
                {agent.isLead ? "Lead" : "Worker"}
              </Badge>
              <RuntimeTip
                harness={agent.harnessProvider ?? agent.provider}
                model={model}
                modelLoading={configsQ.isPending}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs sm:min-w-20">
                {agent.name}
              </span>
              {/* Gives way to a long status before the name does. */}
              <span className="hidden w-32 min-w-0 text-xs text-muted-foreground sm:flex">
                {model.primary ? <ModelLabel model={model.primary} /> : null}
              </span>
              {/* Fits the common statuses, so the model column lines up. */}
              <span className="flex min-w-15 shrink-0 justify-end">
                <StatusBadge status={agent.status} />
              </span>
              <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {lastSeen(agent)}
              </span>
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <Link
          to={setupExitHref("/agents")}
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

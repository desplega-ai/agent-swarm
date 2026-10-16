import { ModelEffortLabel } from "@/components/shared/model-effort-label";
import { ReasoningEffortIcon } from "@/components/shared/reasoning-effort-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { LiveModelsCatalog } from "@/lib/agent-runtime-models";
import { type AgentModelDisplay, getAgentModelPresentation } from "@/lib/agents-list-model-display";
import { ProviderIcon } from "./provider-icon";

interface AgentModelCellProps {
  display: AgentModelDisplay;
  liveCatalog?: LiveModelsCatalog;
}

export function AgentModelCell({ display, liveCatalog }: AgentModelCellProps) {
  const primary = getAgentModelPresentation(display.primary, liveCatalog);

  if (!primary) {
    return <span className="text-muted-foreground">—</span>;
  }

  const configured = getAgentModelPresentation(display.configured, liveCatalog);
  const lastUsed = getAgentModelPresentation(display.lastUsed, liveCatalog);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex max-w-full min-w-0 cursor-default items-center gap-1.5 text-xs leading-none">
          <ModelEffortLabel
            model={primary.raw}
            effort={display.reasoningEffort}
            catalog={liveCatalog}
            className="flex-1 font-medium text-foreground"
          />
          {display.diverged ? (
            <span className="shrink-0 text-[11px] font-medium text-status-warning-strong">
              next task
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" sideOffset={6} className="max-w-sm p-3 text-left">
        <div className="flex flex-col gap-2 text-xs leading-relaxed">
          <div className="flex items-center gap-2">
            <ProviderIcon provider={primary.providerId} className="opacity-90" />
            <div className="min-w-0">
              <div className="truncate font-semibold">{primary.label}</div>
              {primary.provider ? <div className="opacity-70">{primary.provider}</div> : null}
            </div>
          </div>

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="opacity-60">Model ID</dt>
            <dd className="break-all font-mono">{primary.raw}</dd>

            {display.reasoningEffort ? (
              <>
                <dt className="opacity-60">Reasoning effort</dt>
                <dd className="flex items-center gap-1.5 font-mono">
                  <ReasoningEffortIcon level={display.reasoningEffort} />
                  {display.reasoningEffort}
                </dd>
              </>
            ) : null}

            {display.diverged ? (
              <>
                <dt className="opacity-60">Configured</dt>
                <dd className="break-all font-mono">{configured?.raw ?? "not set"}</dd>

                <dt className="opacity-60">Last used</dt>
                <dd className="break-all font-mono">{lastUsed?.raw ?? "not reported"}</dd>

                <dt className="opacity-60">Applies</dt>
                <dd>on the next task</dd>
              </>
            ) : null}
          </dl>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

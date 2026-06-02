import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type AgentModelDisplay, getAgentModelPresentation } from "@/lib/agents-list-model-display";
import { ProviderIcon } from "./provider-icon";

interface AgentModelCellProps {
  display: AgentModelDisplay;
}

export function AgentModelCell({ display }: AgentModelCellProps) {
  const primary = getAgentModelPresentation(display.primary);

  if (!primary) {
    return <span className="text-muted-foreground">—</span>;
  }

  const configured = getAgentModelPresentation(display.configured);
  const lastUsed = getAgentModelPresentation(display.lastUsed);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex max-w-full min-w-0 cursor-default items-center gap-1.5 text-xs leading-none">
          <ProviderIcon provider={primary.providerId} className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {primary.label}
          </span>
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

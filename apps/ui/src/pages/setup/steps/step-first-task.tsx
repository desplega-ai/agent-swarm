import { useAgents } from "@/api/hooks/use-agents";
import type { StepProps } from "../step-contract";
import { isLeadReady, LeadStatusLine } from "./first-task/agents-card";
import { FirstTaskComposer } from "./first-task/first-message-card";

/**
 * Step 6: one secondary status line (the lead, the agent count), then a big
 * centered composer. The composer shows while the lead is still starting, but
 * stays disabled until it is ready.
 */
export function StepFirstTask({ onboarding, act }: StepProps) {
  const agentsQ = useAgents();
  const ready = isLeadReady(agentsQ.data);

  return (
    <div className="flex flex-col gap-5 pt-2 sm:pt-6">
      {onboarding.state.firstTaskId ? null : (
        <LeadStatusLine agents={agentsQ.data} loading={agentsQ.isPending} ready={ready} />
      )}
      <FirstTaskComposer onboarding={onboarding} act={act} leadReady={ready} />
    </div>
  );
}

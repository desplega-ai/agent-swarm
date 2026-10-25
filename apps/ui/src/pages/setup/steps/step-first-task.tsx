import { useAgents } from "@/api/hooks/use-agents";
import type { StepProps } from "../step-contract";
import { LeadStatusLine, leadReadiness } from "./first-task/agents-card";
import { FirstTaskComposer } from "./first-task/first-message-card";

/**
 * Step 7: one secondary status line (the lead, the agent count), then a big
 * centered composer. The composer shows while the lead is still starting, and
 * enables once the lead is online. With no verified key it warns, not blocks.
 */
export function StepFirstTask({ onboarding, act }: StepProps) {
  const agentsQ = useAgents();
  const readiness = leadReadiness(agentsQ.data, onboarding.signals.providers);

  return (
    <div className="flex flex-col gap-5 pt-2 sm:pt-6">
      {onboarding.state.firstTaskId ? null : (
        <LeadStatusLine agents={agentsQ.data} loading={agentsQ.isPending} readiness={readiness} />
      )}
      <FirstTaskComposer onboarding={onboarding} act={act} lead={readiness.state} />
    </div>
  );
}

import { useAgents } from "@/api/hooks/use-agents";
import type { StepProps } from "../step-contract";
import { AgentsCard, isLeadReady } from "./first-task/agents-card";
import { FirstMessageCard } from "./first-task/first-message-card";

export function StepFirstTask({ onboarding, act }: StepProps) {
  const agentsQ = useAgents();
  const ready = isLeadReady(agentsQ.data);

  return (
    <div className="space-y-3">
      <AgentsCard agents={agentsQ.data} loading={agentsQ.isPending} ready={ready} />
      {ready || onboarding.state.firstTaskId ? (
        <FirstMessageCard onboarding={onboarding} act={act} />
      ) : null}
    </div>
  );
}

import { AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { useVisibleOnboardingSteps } from "@/api/hooks/use-onboarding";
import type { OnboardingAgentsMethod } from "@/api/types";
import { setupStepHref, stepNumber } from "@/components/onboarding/step-status";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { AutosaveScopeContext, useAutosaveScope } from "@/hooks/use-autosave";
import { DIAL_LEVELS } from "@/lib/model-dial";
import type { StepProps } from "../step-contract";
import { AgentModels } from "./agents/agent-models";
import { PRESENCE_KEYS } from "./ai/model";

function isAgentsMethod(method: string | null): method is OnboardingAgentsMethod {
  return method === "mixed" || DIAL_LEVELS.some((level) => level === method);
}

/** Step 4: the model level of each agent. Continue applies Optimal where none is set. */
export function StepAgents({ onboarding, act, setContinueBlocker, setContinueAction }: StepProps) {
  const scope = useAutosaveScope(setContinueBlocker);
  const steps = useVisibleOnboardingSteps();
  const { data: agents = [], isPending } = useAgents();
  // Same query as step 3: the OpenRouter key decides how dsh routes.
  const { data: presence = {} } = useEnvPresence(PRESENCE_KEYS);
  const { data: configs = [] } = useConfigs({ scope: "global" });
  const step = onboarding.state.steps.agents;
  const completed = step.status === "done" && isAgentsMethod(step.method) ? step.method : null;
  // The levels below name models, but no agent can run one until a worker checked a key.
  const providerVerified = onboarding.signals.providers.some((p) => p.state === "verified");

  async function onComplete(method: OnboardingAgentsMethod) {
    await act({ action: "complete", step: "agents", method });
  }
  // A settled step needs no action: Continue moves on, as before.
  const onSkip =
    step.status === "done" || step.status === "skipped"
      ? null
      : async () => {
          await act({ action: "skip", step: "agents" });
        };

  return (
    <AutosaveScopeContext.Provider value={scope}>
      <div className="space-y-3">
        {providerVerified ? null : (
          <AlertCallout
            tone="warning"
            icon={AlertTriangle}
            role="note"
            title="No AI provider is verified yet"
            action={
              <Button asChild variant="outline" size="sm">
                <Link to={setupStepHref("ai")} replace>
                  Go to step {stepNumber("ai", steps)}
                </Link>
              </Button>
            }
          >
            Agents run these models only after a worker checks a provider key.
          </AlertCallout>
        )}
        <AgentModels
          agents={agents}
          agentsLoading={isPending}
          configs={configs}
          presence={presence}
          completed={completed}
          onComplete={onComplete}
          onSkip={onSkip}
          setContinueAction={setContinueAction}
        />
      </div>
    </AutosaveScopeContext.Provider>
  );
}

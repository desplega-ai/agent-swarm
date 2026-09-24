import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CheckCircle2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { ONBOARDING_QUERY_KEY } from "@/api/hooks/use-onboarding";
import type { OnboardingAiMethod } from "@/api/types";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import type { StepProps } from "../step-contract";
import { ClaudeCard } from "./ai/claude-card";
import { CodexCard } from "./ai/codex-card";
import { DevinCard } from "./ai/devin-card";
import {
  type AiCardId,
  type AiCardProps,
  cardRollup,
  isAiMethod,
  METHOD_CARD,
  METHOD_PROVIDER,
  PRESENCE_KEYS,
} from "./ai/model";
import { OpenHarnessCard } from "./ai/open-harness-card";

const CARD_NAME: Record<AiCardId, string> = {
  claude: "Claude",
  codex: "Codex",
  open: "OpenRouter",
  devin: "Devin",
};

export function StepAi({ onboarding, act }: StepProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: agents = [] } = useAgents();
  const { data: presence = {} } = useEnvPresence(PRESENCE_KEYS);
  const { data: configs = [] } = useConfigs({ scope: "global" });
  const [openCard, setOpenCard] = useState<AiCardId | null>("claude");
  const [deviceDone, setDeviceDone] = useState(false);
  // The card the user saved on, and the method that save completes the step with.
  const pending = useRef<{ card: AiCardId; method: OnboardingAiMethod } | null>(null);
  const cliRecorded = useRef(false);

  const providers = onboarding.signals.providers;
  const rollups = useMemo(
    () => ({
      claude: cardRollup("claude", providers),
      codex: cardRollup("codex", providers),
      open: cardRollup("open", providers),
      devin: cardRollup("devin", providers),
    }),
    [providers],
  );
  const aiStep = onboarding.state.steps.ai;
  const recorded = aiStep.status === "done" ? aiStep.method : null;

  // The API derives `done` with an inferred method as soon as a worker verifies.
  // Record the precise method once the card the user worked on verifies, unless
  // another card finished the step first (first writer wins).
  useEffect(() => {
    const p = pending.current;
    if (!p || !rollups[p.card].verified) return;
    pending.current = null;
    if (recorded === p.method) return;
    if (isAiMethod(recorded) && METHOD_CARD[recorded] !== p.card) return;
    act({ action: "complete", step: "ai", method: p.method }).catch(() => {});
  }, [rollups, recorded, act]);

  // A codex worker verified without a device flow here: the CLI login stored the token.
  // After a device flow the API already recorded `codex_device`.
  useEffect(() => {
    if (!rollups.codex.verified || deviceDone || recorded || cliRecorded.current) return;
    cliRecorded.current = true;
    act({ action: "complete", step: "ai", method: "codex_cli" }).catch(() => {});
  }, [rollups, deviceDone, recorded, act]);

  const aiDone = aiStep.status === "done";
  const onSaved = useCallback(
    (method: OnboardingAiMethod) => {
      // A save after the step is done adds a provider. It never rewrites the method.
      pending.current = aiDone ? null : { card: METHOD_CARD[method], method };
      void queryClient.invalidateQueries({ queryKey: ["config", "env-presence"] });
      void queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
    },
    [queryClient, aiDone],
  );
  const onDeviceComplete = useCallback(() => setDeviceDone(true), []);

  // Settings is outside /setup: minimize first so the shell does not send us back.
  async function openSettings() {
    await act({ action: "minimize" }).catch(() => null);
    void navigate("/settings/integrations");
  }

  const cardProps = (card: AiCardId): AiCardProps => ({
    open: openCard === card,
    onOpenChange: (open) => setOpenCard(open ? card : null),
    rollup: rollups[card],
    presence,
    configs,
    agents,
    onSaved,
  });

  const verifiedCard = (Object.keys(rollups) as AiCardId[]).find((c) => rollups[c].verified);
  const doneProvider = isAiMethod(aiStep.method)
    ? METHOD_PROVIDER[aiStep.method]
    : verifiedCard
      ? CARD_NAME[verifiedCard]
      : "A provider";

  return (
    <div className="space-y-2">
      {aiDone ? (
        <AlertCallout tone="success" icon={CheckCircle2} className="mb-3">
          {doneProvider} verified. You can continue or add more providers.
        </AlertCallout>
      ) : null}
      <ClaudeCard {...cardProps("claude")} />
      <CodexCard {...cardProps("codex")} onDeviceComplete={onDeviceComplete} />
      <OpenHarnessCard {...cardProps("open")} />
      <DevinCard {...cardProps("devin")} />
      <div className="space-y-1 pt-2">
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={openSettings}
          className="h-auto px-0 has-[>svg]:px-0"
        >
          More providers (OpenAI, Bedrock, Claude Managed) in Settings
          <ArrowUpRight />
        </Button>
        <p className="text-xs text-muted-foreground">One verified provider finishes this step.</p>
      </div>
    </div>
  );
}

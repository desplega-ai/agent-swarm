import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { useModelTiers } from "@/api/hooks/use-model-tiers";
import { useModelsCatalog } from "@/api/hooks/use-models-catalog";
import type { ModelTierPreview, OnboardingAiMethod } from "@/api/types";
import { setupExitHref } from "@/components/onboarding/onboarding-redirect";
import { Button } from "@/components/ui/button";
import { AutosaveScopeContext, useAutosaveScope } from "@/hooks/use-autosave";
import { hasRuntimeCredential } from "@/lib/agent-runtime-models";
import { type DialContext, dialHarness } from "@/lib/model-dial";
import type { StepProps } from "../step-contract";
import { ClaudeCard } from "./ai/claude-card";
import { CodexCard } from "./ai/codex-card";
import { DevinCard } from "./ai/devin-card";
import { switchAgentsTo } from "./ai/harness-switch";
import {
  type AiCardId,
  type AiCardProps,
  cardRollup,
  type FirstCredentialSwitch,
  firstCredentialSwitch,
  isAiMethod,
  METHOD_CARD,
  PRESENCE_KEYS,
} from "./ai/model";
import { OpenHarnessCard } from "./ai/open-harness-card";

/** Stable, so a failed tier load does not rebuild the dial context on every render. */
const NO_TIER_ROWS: ModelTierPreview[] = [];

export function StepAi({ onboarding, act, setContinueBlocker }: StepProps) {
  const scope = useAutosaveScope(setContinueBlocker);
  const queryClient = useQueryClient();
  const { data: agents = [] } = useAgents();
  const { data: presence = {} } = useEnvPresence(PRESENCE_KEYS);
  const { data: configs = [] } = useConfigs({ scope: "global" });
  const [openCard, setOpenCard] = useState<AiCardId | null>("claude");
  const [deviceDone, setDeviceDone] = useState(false);
  // The card the user saved on, and the method that save completes the step with.
  const pending = useRef<{ card: AiCardId; method: OnboardingAiMethod } | null>(null);
  const cliRecorded = useRef(false);
  const openrouter = hasRuntimeCredential("OPENROUTER_API_KEY", configs, presence);
  const { data: modelsCatalog } = useModelsCatalog();
  const catalog = modelsCatalog?.providers ?? null;
  const tiersQuery = useModelTiers();
  // A failed tier load leaves an empty list: no level carries over, and the
  // switch changes only the harness (never a guessed model).
  const tiers = tiersQuery.data ?? (tiersQuery.isError ? NO_TIER_ROWS : null);
  const dialContext = useMemo<DialContext>(
    () => ({ openrouter, catalog, tiers }),
    [openrouter, catalog, tiers],
  );

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

  // Each card's saved state, as its header shows it.
  const savedCards = useRef<Partial<Record<AiCardId, boolean>>>({});
  const reportSaved = useCallback((card: AiCardId, saved: boolean) => {
    savedCards.current[card] = saved;
  }, []);
  // The switch runs from save callbacks: it reads the latest data from here.
  const latest = useRef({ agents, rollups, dialContext });
  useEffect(() => {
    latest.current = { agents, rollups, dialContext };
  });
  const [autoSwitch, setAutoSwitch] = useState<FirstCredentialSwitch | null>(null);
  const autoSwitchRunning = useRef(false);
  // A save that came while the tier models load: its switch runs when they arrive.
  const waitingForTiers = useRef<OnboardingAiMethod | null>(null);

  /**
   * The first credential moves every agent to its card's harness, so that a
   * worker can check the key. It runs once per save, never on view. A save
   * that finds agents on the harness, or a credential on another card, keeps
   * the manual switch list.
   */
  const switchOnFirstCredential = useCallback(
    async (method: OnboardingAiMethod) => {
      if (autoSwitchRunning.current) return;
      const { agents, rollups, dialContext } = latest.current;
      const plan = firstCredentialSwitch(method, savedCards.current, rollups, agents);
      if (!plan) return;
      // The carried model level needs the tier models: wait for them, then switch.
      if (!dialContext.tiers && dialHarness(plan.target)) {
        waitingForTiers.current = method;
        return;
      }
      autoSwitchRunning.current = true;
      setAutoSwitch(plan);
      try {
        await switchAgentsTo(queryClient, plan.agentIds, plan.target, dialContext, true);
      } finally {
        autoSwitchRunning.current = false;
        setAutoSwitch(null);
      }
    },
    [queryClient],
  );
  useEffect(() => {
    const method = waitingForTiers.current;
    if (!method || !tiers) return;
    waitingForTiers.current = null;
    void switchOnFirstCredential(method);
  }, [tiers, switchOnFirstCredential]);

  const aiDone = aiStep.status === "done";
  // The card's save already refreshed env presence and the onboarding signals.
  const onSaved = useCallback(
    (method: OnboardingAiMethod) => {
      // A save after the step is done adds a provider. It never rewrites the method.
      pending.current = aiDone ? null : { card: METHOD_CARD[method], method };
      void switchOnFirstCredential(method);
    },
    [aiDone, switchOnFirstCredential],
  );
  const onDeviceComplete = useCallback(() => {
    setDeviceDone(true);
    void switchOnFirstCredential("codex_device");
  }, [switchOnFirstCredential]);

  const cardProps = (card: AiCardId): AiCardProps => ({
    open: openCard === card,
    onOpenChange: (open) => setOpenCard(open ? card : null),
    rollup: rollups[card],
    presence,
    configs,
    agents,
    onSaved,
    dialContext,
    reportSaved,
    autoSwitching: autoSwitch?.card === card ? autoSwitch.target : null,
  });

  return (
    <AutosaveScopeContext.Provider value={scope}>
      <div className="space-y-2">
        <ClaudeCard {...cardProps("claude")} />
        <CodexCard {...cardProps("codex")} onDeviceComplete={onDeviceComplete} />
        <OpenHarnessCard {...cardProps("open")} />
        <DevinCard {...cardProps("devin")} />
        <div className="pt-2">
          <Button
            asChild
            variant="link"
            size="xs"
            className="h-auto max-w-full whitespace-normal px-0 text-left has-[>svg]:px-0"
          >
            {/* A new tab keeps setup open in this one. */}
            <Link
              to={setupExitHref("/settings/integrations")}
              target="_blank"
              rel="noopener noreferrer"
            >
              More providers (OpenAI, Bedrock, Claude Managed) in Settings
              <ArrowUpRight />
            </Link>
          </Button>
        </div>
      </div>
    </AutosaveScopeContext.Provider>
  );
}

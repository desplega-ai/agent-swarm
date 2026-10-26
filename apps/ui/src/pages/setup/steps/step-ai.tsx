import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useConfigs } from "@/api/hooks/use-config-api";
import { type EnvPresenceMap, useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { useModelTiers } from "@/api/hooks/use-model-tiers";
import { useModelsCatalog } from "@/api/hooks/use-models-catalog";
import type { ModelTierPreview, OnboardingAiMethod, SwarmConfig } from "@/api/types";
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
const NO_PRESENCE: EnvPresenceMap = {};
const NO_CONFIGS: SwarmConfig[] = [];

export function StepAi({ onboarding, act, setContinueBlocker }: StepProps) {
  const scope = useAutosaveScope(setContinueBlocker);
  const queryClient = useQueryClient();
  const { data: agents = [] } = useAgents();
  const presenceQuery = useEnvPresence(PRESENCE_KEYS);
  const configsQuery = useConfigs({ scope: "global" });
  const presence = presenceQuery.data ?? NO_PRESENCE;
  const configs = configsQuery.data ?? NO_CONFIGS;
  // The cards' saved state comes from these two. Restored cache data can be
  // old, so a card counts as empty only when both have loaded and do not fetch.
  const savedStateSettled =
    presenceQuery.data !== undefined &&
    configsQuery.data !== undefined &&
    !presenceQuery.isFetching &&
    !configsQuery.isFetching;
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
  // The cards that showed no credential: their next save is a first credential.
  // A card that loads with a key never arms, so a second key does not switch.
  const armed = useRef<Partial<Record<AiCardId, boolean>>>({});
  // A save that came while the tier models load: its switch runs when they arrive.
  const waitingForTiers = useRef<{ card: AiCardId; method: OnboardingAiMethod } | null>(null);
  const reportSaved = useCallback(
    (card: AiCardId, saved: boolean) => {
      savedCards.current[card] = saved;
      if (saved) return;
      // The key of a queued switch is gone: drop the switch.
      if (waitingForTiers.current?.card === card) waitingForTiers.current = null;
      if (savedStateSettled) armed.current[card] = true;
    },
    [savedStateSettled],
  );
  // The switch runs from save callbacks: it reads the latest data from here.
  const latest = useRef({ agents, rollups, dialContext });
  useEffect(() => {
    latest.current = { agents, rollups, dialContext };
  });
  const [autoSwitch, setAutoSwitch] = useState<FirstCredentialSwitch | null>(null);
  const autoSwitchRunning = useRef(false);

  /**
   * The first credential moves every agent to its card's harness, so that a
   * worker can check the key. It runs once per save, never on view, and only
   * for the first key of a card that showed no credential. A save that finds
   * agents on the harness, or a credential on another card, keeps the manual
   * switch list.
   */
  const runSwitch = useCallback(
    async (method: OnboardingAiMethod) => {
      if (autoSwitchRunning.current) return;
      const { agents, rollups, dialContext } = latest.current;
      const plan = firstCredentialSwitch(method, savedCards.current, rollups, agents);
      if (!plan) return;
      // The carried model level needs the tier models: wait for them, then switch.
      if (!dialContext.tiers && dialHarness(plan.target)) {
        waitingForTiers.current = { card: plan.card, method };
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
  const switchOnFirstCredential = useCallback(
    (method: OnboardingAiMethod) => {
      const card = METHOD_CARD[method];
      if (!armed.current[card]) return;
      // The card holds a credential now: a later key is not the first.
      armed.current[card] = false;
      void runSwitch(method);
    },
    [runSwitch],
  );
  useEffect(() => {
    const waiting = waitingForTiers.current;
    if (!waiting || !tiers) return;
    waitingForTiers.current = null;
    if (savedCards.current[waiting.card]) void runSwitch(waiting.method);
  }, [tiers, runSwitch]);

  const aiDone = aiStep.status === "done";
  // The card's save already refreshed env presence and the onboarding signals.
  const onSaved = useCallback(
    (method: OnboardingAiMethod) => {
      // A save after the step is done adds a provider. It never rewrites the method.
      pending.current = aiDone ? null : { card: METHOD_CARD[method], method };
      switchOnFirstCredential(method);
    },
    [aiDone, switchOnFirstCredential],
  );
  const onDeviceComplete = useCallback(() => {
    setDeviceDone(true);
    switchOnFirstCredential("codex_device");
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

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
import { useConfig } from "@/hooks/use-config";
import { deriveStorageKey } from "@/hooks/use-dismissible-card-key";
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

/** The stored mark that the first save on `card` was decided, switch or not (one per API). */
function switchMarkKey(apiUrl: string, card: AiCardId): string {
  return deriveStorageKey(apiUrl, `setup-first-credential-switch:${card}`);
}

function hasSwitchMark(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function writeSwitchMark(key: string): void {
  try {
    localStorage.setItem(key, new Date().toISOString());
  } catch {
    // Storage is off: the mark in memory still holds until a reload.
  }
}

export function StepAi({ onboarding, act, setContinueBlocker }: StepProps) {
  const scope = useAutosaveScope(setContinueBlocker);
  const queryClient = useQueryClient();
  const { data: agents = [] } = useAgents();
  const presenceQuery = useEnvPresence(PRESENCE_KEYS);
  const configsQuery = useConfigs({ scope: "global" });
  const presence = presenceQuery.data ?? NO_PRESENCE;
  const configs = configsQuery.data ?? NO_CONFIGS;
  // The cards' saved state comes from these two. Restored cache data can be
  // old, and a failed load has no data, so the state is final only when both
  // hold data and do not fetch.
  const savedStateSettled = [presenceQuery, configsQuery].every(
    (q) => q.data !== undefined && !q.isFetching,
  );
  const { config } = useConfig();
  const apiUrl = config.apiUrl || window.location.origin;
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
  // A save waits here while the cards' saved state or the tier models load.
  const queued = useRef<{ card: AiCardId; method: OnboardingAiMethod } | null>(null);
  const reportSaved = useCallback((card: AiCardId, saved: boolean) => {
    savedCards.current[card] = saved;
    // The key of a queued switch is gone: drop the switch.
    if (!saved && queued.current?.card === card) queued.current = null;
  }, []);
  // The switch runs from save callbacks: it reads the latest data from here.
  const latest = useRef({ agents, rollups, dialContext, savedStateSettled });
  useEffect(() => {
    latest.current = { agents, rollups, dialContext, savedStateSettled };
  });
  const [autoSwitch, setAutoSwitch] = useState<FirstCredentialSwitch | null>(null);
  const autoSwitchRunning = useRef(false);
  // The cards whose first save was decided. The stored mark keeps this across
  // reloads, so agents that the user moved later stay where they are.
  const decided = useRef<Partial<Record<AiCardId, boolean>>>({});

  /**
   * Runs the queued switch when its data is there. `afterWait`: the save came
   * earlier, so its key must still be saved.
   */
  const runQueuedSwitch = useCallback(
    async (afterWait: boolean) => {
      const job = queued.current;
      if (!job || autoSwitchRunning.current) return;
      const { agents, rollups, dialContext, savedStateSettled } = latest.current;
      // The other cards' saved state decides the switch: wait until it loads.
      if (!savedStateSettled) return;
      const plan = firstCredentialSwitch(job.method, savedCards.current, rollups, agents);
      // The carried model level needs the tier models: wait for them, then switch.
      if (plan && !dialContext.tiers && dialHarness(plan.target)) return;
      queued.current = null;
      if (afterWait && !savedCards.current[job.card]) return;
      // Decided, also when no switch runs (the agents ran the card's harness
      // already). With no agent yet, a later key can still switch them.
      if (agents.length > 0) {
        decided.current[job.card] = true;
        writeSwitchMark(switchMarkKey(apiUrl, job.card));
      }
      if (!plan) return;
      autoSwitchRunning.current = true;
      setAutoSwitch(plan);
      try {
        await switchAgentsTo(queryClient, plan.agentIds, plan.target, dialContext, true);
      } finally {
        autoSwitchRunning.current = false;
        setAutoSwitch(null);
      }
    },
    [queryClient, apiUrl],
  );
  useEffect(() => {
    if (tiers && savedStateSettled) void runQueuedSwitch(true);
  }, [tiers, savedStateSettled, runQueuedSwitch]);

  /**
   * The first credential moves every agent to its card's harness, so that a
   * worker can check the key. It runs on a save, never on view. The first
   * save of each card decides it once. A save that finds agents on the
   * harness, or a credential on another card, keeps the manual switch list.
   */
  const switchOnFirstCredential = useCallback(
    (method: OnboardingAiMethod) => {
      const card = METHOD_CARD[method];
      if (autoSwitchRunning.current || decided.current[card]) return;
      if (hasSwitchMark(switchMarkKey(apiUrl, card))) return;
      queued.current = { card, method };
      void runQueuedSwitch(false);
    },
    [apiUrl, runQueuedSwitch],
  );

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

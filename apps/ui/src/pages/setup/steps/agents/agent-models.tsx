import { type UseQueryResult, useQueries, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Bot, Gauge } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUpdateAgentRuntime } from "@/api/hooks/use-agents";
import { resolvedConfigsQuery } from "@/api/hooks/use-config-api";
import type { EnvPresenceMap } from "@/api/hooks/use-integrations-meta";
import type {
  AgentWithTasks,
  OnboardingAgentsMethod,
  ReasoningEffortLevel,
  SwarmConfig,
} from "@/api/types";
import { SetupCard, SetupChip } from "@/components/onboarding/setup-card";
import { ModelLabel } from "@/components/shared/model-logo";
import { REASONING_EFFORT_LABEL } from "@/components/shared/reasoning-effort-icon";
import { StatusIcon } from "@/components/shared/status-icon";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAutosave, useContinueAction, useContinueHold } from "@/hooks/use-autosave";
import { HARNESS_LABEL, hasRuntimeCredential } from "@/lib/agent-runtime-models";
import { formatCost } from "@/lib/cost-format";
import {
  DIAL_LEVEL_LABEL,
  DIAL_LEVELS,
  type DialContext,
  type DialHarness,
  type DialLevel,
  type DialPosition,
  type DialSetting,
  dialHarness,
  dialMatches,
  dialPrice,
  dialSetting,
  dialSettingApplied,
} from "@/lib/model-dial";
import { cn } from "@/lib/utils";
import type { StepProps } from "../../step-contract";
import { AiHarnessIcon } from "../ai/harness-switch";

/** Who picks the model for a harness without a dial. */
const MANAGED_BY: Record<string, string> = {
  devin: "Managed by Devin",
  "claude-managed": "Managed by Anthropic",
  acp: "Managed by the ACP server",
};

/** Every agent defaults to it (Taras, 2026-09-24). */
const RECOMMENDED: DialLevel = "optimal";

const LEVEL_BLURB: Record<DialLevel, string> = {
  cheap: "Lowest cost. Fine for routine work.",
  optimal: "The best balance of quality and cost.",
  max: "The strongest models, at the highest cost.",
};

const NOT_APPLIED = "Not applied yet. Continue applies Optimal.";
const LOAD_FAILED = "The model did not load, so Continue skips this agent. Click to retry.";

/** A level the operator picked. `nonce` makes a repeated pick store again (a retry). */
interface Intent {
  level: DialLevel;
  nonce: number;
}

interface Row {
  agent: AgentWithTasks;
  /** `null`: the harness picks its own model (Devin, Claude Managed, ACP) or is unknown. */
  harness: DialHarness | null;
  /** A dial row's resolved config is still loading (or loading again after a failure). */
  loading: boolean;
  /** A dial row's resolved config did not load: Continue skips this agent. */
  loadFailed: boolean;
  /** Load the resolved config again. */
  retry: () => void;
  model: string;
  effort: string;
  position: DialPosition | null;
  intent: Intent | undefined;
  /** What to store now: the setting of the picked level. */
  target: DialSetting | null;
  applied: boolean;
  /** The level the dial shows. `null` selects none (custom model, or loading). */
  shown: DialLevel | null;
  /** No model override yet: Continue stores Optimal. */
  notApplied: boolean;
}

function configValue(configs: SwarmConfig[] | undefined, key: string): SwarmConfig | undefined {
  return configs?.find((c) => c.key === key);
}

function buildRow(
  agent: AgentWithTasks,
  query: UseQueryResult<SwarmConfig[]>,
  intent: Intent | undefined,
  remembered: DialLevel | undefined,
  context: DialContext,
): Row {
  const harness = dialHarness(agent.harnessProvider);
  const configs = query.data;
  const loaded = configs !== undefined;
  const model = configValue(configs, "MODEL_OVERRIDE")?.value ?? "";
  const effort = configValue(configs, "REASONING_EFFORT_OVERRIDE")?.value ?? "";
  const matches = harness ? dialMatches(harness, model, effort, context) : [];
  const first = matches.length > 0 ? matches[0] : undefined;
  // A model outside the dial (Custom) changes only on an explicit pick. The
  // step 3 harness switch already moved a dial level to the new harness.
  const position: DialPosition | null = harness && model ? (first ?? "custom") : null;
  const target = harness && intent ? dialSetting(harness, intent.level, context) : null;
  // Two levels can store the same setting (dsh): show the one the operator picked.
  const stored = remembered && matches.includes(remembered) ? remembered : first;
  const notApplied = Boolean(harness) && loaded && !model && !intent;
  return {
    agent,
    harness,
    // Only a dial row needs its resolved config.
    loading: Boolean(harness) && !loaded && (query.isPending || query.isFetching),
    loadFailed: Boolean(harness) && !loaded && query.isError && !query.isFetching,
    retry: () => void query.refetch(),
    model,
    effort,
    position,
    intent,
    target,
    applied: target ? dialSettingApplied(target, model, effort) : false,
    shown: intent?.level ?? stored ?? (notApplied ? RECOMMENDED : null),
    notApplied,
  };
}

/** "High effort · $5.00 in, $25.00 out per 1M tokens" for a model. */
function modelDetails(harness: DialHarness, model: string, effort: string | null): string | null {
  const price = dialPrice({ harness, model, effort: null, custom: false });
  const details = [
    effort ? `${REASONING_EFFORT_LABEL[effort as ReasoningEffortLevel] ?? effort} effort` : null,
    price
      ? `${formatCost(price.input, { precision: 2, placeholder: "?" })} in, ${formatCost(price.output, { precision: 2, placeholder: "?" })} out per 1M tokens`
      : null,
  ].filter(Boolean);
  return details.length > 0 ? details.join(" · ") : null;
}

/** Pretty name, exact id, effort, and price of one model, for a tooltip. */
function ModelTip({
  harness,
  model,
  effort,
  note,
}: {
  harness: DialHarness;
  model: string;
  effort: string | null;
  note?: string;
}) {
  const details = modelDetails(harness, model, effort);
  return (
    <span className="flex flex-col gap-0.5">
      <ModelLabel model={model} className="font-medium" />
      <span className="font-mono opacity-70">{model}</span>
      {details ? <span className="opacity-70">{details}</span> : null}
      {note ? <span className="opacity-70">{note}</span> : null}
    </span>
  );
}

function levelOptions(
  tip: (level: DialLevel) => SegmentedControlOption<DialLevel>["tooltip"],
): SegmentedControlOption<DialLevel>[] {
  return DIAL_LEVELS.map((level) => ({
    value: level,
    label: DIAL_LEVEL_LABEL[level],
    tooltip: tip(level),
  }));
}

/**
 * Step 4: one dial per agent (Cheap, Optimal, Max) that stores a concrete
 * model and effort for the agent's harness. The level tiles set every agent
 * at once. Picks store at once. Viewing never stores: agents without a model
 * override show Optimal (recommended) with a hollow dot, and Continue stores
 * Optimal for them, then completes the step with the level every agent got.
 * Continue waits until every dial row has loaded.
 */
export function AgentModels({
  agents,
  agentsLoading,
  configs,
  presence,
  completed,
  onComplete,
  setContinueAction,
}: {
  agents: AgentWithTasks[];
  agentsLoading: boolean;
  /** Global config rows, to see a stored OpenRouter key. */
  configs: SwarmConfig[];
  presence: EnvPresenceMap;
  /** The method the step is done with, `null` while it is not done. */
  completed: OnboardingAgentsMethod | null;
  onComplete: (method: OnboardingAgentsMethod) => Promise<void>;
  setContinueAction: StepProps["setContinueAction"];
}) {
  const queryClient = useQueryClient();
  const listed = useMemo(
    () =>
      agents
        // Extension identities are API principals, not workers.
        .filter((a) => a.role !== "extension")
        .sort((a, b) => Number(b.isLead) - Number(a.isLead) || a.name.localeCompare(b.name)),
    [agents],
  );
  const openrouter = hasRuntimeCredential("OPENROUTER_API_KEY", configs, presence);
  const context = useMemo<DialContext>(() => ({ openrouter }), [openrouter]);

  // The call and cache entry of `useResolvedConfigs({ agentId })`, one per agent.
  const resolved = useQueries({
    queries: listed.map((agent) => ({
      ...resolvedConfigsQuery({ agentId: agent.id }),
      // A save refetches its own row; other changes can arrive slower.
      refetchInterval: 30_000,
    })),
  });

  const [intents, setIntents] = useState<Record<string, Intent>>({});
  const [remembered, setRemembered] = useState<Record<string, DialLevel>>({});
  const nonce = useRef(0);

  const pick = useCallback((ids: string[], level: DialLevel) => {
    nonce.current += 1;
    const intent = { level, nonce: nonce.current };
    setIntents((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, intent])) }));
    setRemembered((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, level])) }));
  }, []);

  // The stored setting caught up with the pick: stop driving writes from it.
  const settle = useCallback((id: string, settled: number) => {
    setIntents((prev) => {
      if (prev[id]?.nonce !== settled) return prev;
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const { mutateAsync: updateRuntime } = useUpdateAgentRuntime();
  const write = useCallback(
    async (agentId: string, setting: DialSetting) => {
      await updateRuntime({
        id: agentId,
        harnessProvider: setting.harness,
        model: setting.model,
        allowCustomModel: setting.custom,
        reasoningEffort: setting.effort,
      });
      // The hook already invalidated the rows: wait for this agent's refetch.
      await queryClient.invalidateQueries(
        { queryKey: resolvedConfigsQuery({ agentId }).queryKey },
        { cancelRefetch: false },
      );
    },
    [updateRuntime, queryClient],
  );

  const rows = listed.map((agent, index) =>
    buildRow(agent, resolved[index], intents[agent.id], remembered[agent.id], context),
  );
  const dialRows = rows.filter((row) => row.harness !== null);
  useContinueHold(
    agentsLoading
      ? "Loading agents…"
      : dialRows.some((row) => row.loading)
        ? "Loading agent settings…"
        : null,
  );
  // A row that did not load is left out: Continue skips it (its icon says so).
  const shownLevels = dialRows.filter((row) => !row.loadFailed).map((row) => row.shown);
  const allLevel =
    shownLevels.length > 0 &&
    shownLevels.every((level) => level !== null && level === shownLevels[0])
      ? shownLevels[0]
      : null;
  const harnessesInUse = [...new Set(dialRows.map((row) => row.harness as DialHarness))];

  // Continue stores Optimal on agents that have no model override yet, then
  // completes the step with the level every agent got.
  const defaults = dialRows.filter((row) => row.notApplied);
  const method: OnboardingAgentsMethod = allLevel ?? "mixed";
  useContinueAction(
    (action) => setContinueAction(action, { unlocks: true }),
    dialRows.length > 0
      ? async () => {
          // Completing records the level every agent got: it must be stored first.
          if (dialRows.some((row) => row.intent && !row.applied)) {
            throw new Error("A model change did not save. Pick the level again, or skip.");
          }
          if (shownLevels.length === 0) {
            throw new Error("The agent settings did not load. Retry them, or skip.");
          }
          const results = await Promise.allSettled(
            defaults.map((row) =>
              write(row.agent.id, dialSetting(row.harness as DialHarness, RECOMMENDED, context)),
            ),
          );
          const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
          if (failed.length > 0) {
            const reason = failed[0].reason instanceof Error ? ` ${failed[0].reason.message}` : "";
            throw new Error(
              `Could not apply Optimal to ${failed.length} agent${failed.length === 1 ? "" : "s"}.${reason}`,
            );
          }
          if (completed !== method) await onComplete(method);
        }
      : null,
  );

  if (agentsLoading) {
    return (
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          {DIAL_LEVELS.map((level) => (
            <Skeleton key={level} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  if (listed.length === 0) {
    return (
      <SetupCard
        icon={<Bot className="size-4" />}
        title="No agents online yet"
        description="Agents show here once they connect to the API. You can skip this step and pick models later in each agent's settings."
      />
    );
  }

  return (
    <div className="space-y-3">
      {dialRows.length > 0 ? (
        <LevelTiles
          value={allLevel}
          harnesses={harnessesInUse}
          context={context}
          onPick={(level) =>
            pick(
              dialRows.map((row) => row.agent.id),
              level,
            )
          }
        />
      ) : null}
      <SetupCard
        icon={<Gauge className="size-4" />}
        title="Per agent"
        description={
          dialRows.length > 0 ? (
            // Touch screens have no hover, so the price tooltip never opens there.
            <>
              <span className="[@media(hover:hover)_and_(pointer:fine)]:hidden">
                Pick a level for one agent. Its row shows the model it runs.
              </span>
              <span className="hidden [@media(hover:hover)_and_(pointer:fine)]:inline">
                Pick a level for one agent. Hover a level to see its model and price.
              </span>
            </>
          ) : (
            "These agents pick their own models. Skip this step."
          )
        }
        bodyClassName="p-0"
      >
        <ul className="divide-y divide-border-subtle">
          {rows.map((row) => (
            <AgentModelRow
              key={row.agent.id}
              row={row}
              context={context}
              onPick={(level) => pick([row.agent.id], level)}
              onSettle={settle}
              write={write}
            />
          ))}
        </ul>
      </SetupCard>
    </div>
  );
}

/** Cheap, Optimal (recommended), Max: one tile per level, applied to every agent. */
function LevelTiles({
  value,
  harnesses,
  context,
  onPick,
}: {
  /** The level every agent shares, `null` when they differ. */
  value: DialLevel | null;
  harnesses: DialHarness[];
  context: DialContext;
  onPick: (level: DialLevel) => void;
}) {
  return (
    <fieldset className="grid gap-3 sm:grid-cols-3">
      <legend className="sr-only">Level for all agents</legend>
      {DIAL_LEVELS.map((level) => {
        const selected = value === level;
        // One line per model: two harnesses can run the same model (pi, opencode).
        const settings = [
          ...new Map(
            harnesses.map((harness) => {
              const setting = dialSetting(harness, level, context);
              return [`${setting.model}:${setting.effort}`, setting] as const;
            }),
          ).values(),
        ];
        return (
          <Tooltip key={level}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onPick(level)}
                className={cn(
                  "flex flex-col gap-2 rounded-xl border bg-card p-3.5 text-left shadow-sm hover:bg-accent/50 hover-linger transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                  selected ? "border-primary/60 bg-primary/5 hover:bg-primary/10" : "border-border",
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-3.5 place-items-center rounded-full border",
                      selected ? "border-primary" : "border-muted-foreground/50",
                    )}
                  >
                    {selected ? <span className="size-1.5 rounded-full bg-primary" /> : null}
                  </span>
                  <span className="text-sm font-semibold">{DIAL_LEVEL_LABEL[level]}</span>
                  {level === RECOMMENDED ? (
                    <span className="ml-auto">
                      <SetupChip tone="info">Recommended</SetupChip>
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">{LEVEL_BLURB[level]}</span>
                <span className="flex flex-col gap-1 text-xs">
                  {settings.map((setting) => (
                    <span
                      key={`${setting.model}:${setting.effort}`}
                      className="flex min-w-0 items-center gap-1.5"
                    >
                      <ModelLabel model={setting.model} />
                      {setting.effort ? (
                        <span className="shrink-0 text-muted-foreground">
                          {REASONING_EFFORT_LABEL[setting.effort]}
                        </span>
                      ) : null}
                    </span>
                  ))}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-80">
              <span className="flex flex-col gap-2">
                {harnesses.map((harness) => {
                  const setting = dialSetting(harness, level, context);
                  return (
                    <span key={harness} className="flex flex-col gap-0.5">
                      <span className="opacity-70">{HARNESS_LABEL[harness] ?? harness}</span>
                      <ModelTip harness={harness} model={setting.model} effort={setting.effort} />
                    </span>
                  );
                })}
              </span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </fieldset>
  );
}

function AgentModelRow({
  row,
  context,
  onPick,
  onSettle,
  write,
}: {
  row: Row;
  context: DialContext;
  onPick: (level: DialLevel) => void;
  onSettle: (agentId: string, nonce: number) => void;
  write: (agentId: string, setting: DialSetting) => Promise<void>;
}) {
  const { agent, harness, target, intent } = row;

  useEffect(() => {
    if (intent && row.applied) onSettle(agent.id, intent.nonce);
  }, [intent, row.applied, onSettle, agent.id]);

  // The value carries the pick nonce, so picking a level again retries a failed save.
  const save = useAutosave({
    value: target && intent ? JSON.stringify([intent.nonce, target]) : "",
    dirty: target !== null && !row.applied,
    ready: true,
    delayMs: 150,
    save: async (value) => {
      const [, setting] = JSON.parse(value) as [unknown, DialSetting];
      await write(agent.id, setting);
    },
  });

  const harnessLabel = agent.harnessProvider
    ? (HARNESS_LABEL[agent.harnessProvider] ?? agent.harnessProvider)
    : "Unknown";

  let status: { tone: "busy" | "saved" | "dirty" | "error" | "none"; label?: string } | null;
  if (save.phase === "pending" || save.phase === "saving")
    status = { tone: "busy", label: "Saving…" };
  else if (save.phase === "error") status = { tone: "error", label: save.error ?? "Not saved." };
  else if (row.loading) status = { tone: "busy", label: "Loading the current model…" };
  // `null`: the retry button takes the slot.
  else if (row.loadFailed) status = null;
  else if (row.notApplied) status = { tone: "dirty", label: NOT_APPLIED };
  else if (save.phase === "saved") status = { tone: "saved", label: "Saved" };
  else status = { tone: "none" };

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
      <span className="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
        <span className="w-14 shrink-0">
          <SetupChip>{agent.isLead ? "Lead" : "Worker"}</SetupChip>
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-xs">{agent.name}</span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <AiHarnessIcon harness={agent.harnessProvider} />
            {harnessLabel}
          </span>
        </span>
      </span>
      {harness ? (
        <span className="flex w-full min-w-0 flex-wrap items-center gap-x-4 gap-y-2 sm:ml-auto sm:w-auto sm:justify-end">
          <RowModel row={row} harness={harness} context={context} />
          <span className="flex h-9 items-center gap-3">
            <SegmentedControl
              aria-label={`Level for ${agent.name}`}
              value={row.shown}
              onValueChange={onPick}
              disabled={row.loading}
              options={levelOptions((level) => {
                const setting = dialSetting(harness, level, context);
                return (
                  <ModelTip
                    harness={harness}
                    model={setting.model}
                    effort={setting.effort}
                    note={level === RECOMMENDED ? "Recommended" : undefined}
                  />
                );
              })}
            />
            {status ? (
              <StatusIcon tone={status.tone} label={status.label} />
            ) : (
              <LoadRetry onRetry={row.retry} />
            )}
          </span>
        </span>
      ) : (
        <span className="ml-auto text-xs text-muted-foreground">
          {(agent.harnessProvider && MANAGED_BY[agent.harnessProvider]) ?? "No harness reported"}
        </span>
      )}
    </li>
  );
}

/**
 * The model the row runs, or will run: the pick being saved, the stored
 * model, or Optimal's model (muted) when nothing is stored yet. The tooltip
 * names the exact id, effort, and price.
 */
function RowModel({
  row,
  harness,
  context,
}: {
  row: Row;
  harness: DialHarness;
  context: DialContext;
}) {
  if (row.loading || row.loadFailed) {
    return <Skeleton className="h-4 w-32" />;
  }
  const upcoming =
    row.target ?? (row.notApplied ? dialSetting(harness, RECOMMENDED, context) : null);
  const model = upcoming?.model ?? row.model;
  const effort = upcoming ? upcoming.effort : row.effort || null;
  if (!model) return null;
  const custom = !upcoming && row.position === "custom";
  const note = custom
    ? "A custom model. Pick a level to replace it."
    : row.notApplied
      ? NOT_APPLIED
      : undefined;
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        className={cn(
          "flex w-52 min-w-0 items-center gap-1.5 rounded-sm text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          row.notApplied && "text-muted-foreground",
        )}
      >
        <ModelLabel model={model} className="min-w-0" />
        {effort ? (
          <span className="shrink-0 text-muted-foreground">
            {REASONING_EFFORT_LABEL[effort as ReasoningEffortLevel] ?? effort}
          </span>
        ) : null}
        {custom ? <SetupChip>Custom</SetupChip> : null}
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <ModelTip harness={harness} model={model} effort={effort} note={note} />
      </TooltipContent>
    </Tooltip>
  );
}

/** The error icon of a row whose model did not load. A click loads it again. */
function LoadRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        onClick={onRetry}
        aria-label="Retry loading the model"
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <AlertCircle className="size-4 text-status-error-strong" aria-hidden />
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{LOAD_FAILED}</TooltipContent>
    </Tooltip>
  );
}

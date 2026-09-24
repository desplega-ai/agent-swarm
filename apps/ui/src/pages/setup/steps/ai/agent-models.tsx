import { type UseQueryResult, useQueries, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Gauge } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUpdateAgentRuntime } from "@/api/hooks/use-agents";
import { resolvedConfigsQuery } from "@/api/hooks/use-config-api";
import type { EnvPresenceMap } from "@/api/hooks/use-integrations-meta";
import type { AgentWithTasks, ReasoningEffortLevel, SwarmConfig } from "@/api/types";
import { SetupCard, SetupChip } from "@/components/onboarding/setup-card";
import { REASONING_EFFORT_LABEL } from "@/components/shared/reasoning-effort-icon";
import { StatusIcon } from "@/components/shared/status-icon";
import { InfoTip } from "@/components/ui/info-tip";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
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
  dialLevelOfAnyHarness,
  dialMatches,
  dialPrice,
  dialSetting,
  dialSettingApplied,
} from "@/lib/model-dial";
import type { StepProps } from "../../step-contract";
import { AiHarnessIcon } from "./harness-switch";

/** Who picks the model for a harness without a dial. */
const MANAGED_BY: Record<string, string> = {
  devin: "Managed by Devin",
  "claude-managed": "Managed by Anthropic",
  acp: "Managed by the ACP server",
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
  /**
   * What to store now: the picked level, or the level carried over after the
   * operator switched this agent's harness in this session.
   */
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
  switched: boolean,
  context: DialContext,
): Row {
  const harness = dialHarness(agent.harnessProvider);
  const configs = query.data;
  const loaded = configs !== undefined;
  const modelRow = configValue(configs, "MODEL_OVERRIDE");
  const model = modelRow?.value ?? "";
  const effort = configValue(configs, "REASONING_EFFORT_OVERRIDE")?.value ?? "";
  const matches = harness ? dialMatches(harness, model, effort, context) : [];
  const first = matches.length > 0 ? matches[0] : undefined;
  const position: DialPosition | null = harness && model ? (first ?? "custom") : null;
  // The operator switched this agent's harness here (the R2 switch), and it
  // still runs a dial model of its old harness: carry the level over. Any
  // other model outside the dial (Custom) changes only on an explicit pick.
  // Global or repo overrides stay as they are.
  const carried =
    switched && position === "custom" && modelRow?.scope === "agent"
      ? dialLevelOfAnyHarness(model, effort, context)
      : null;
  const level = intent?.level ?? carried;
  const target = harness && level ? dialSetting(harness, level, context) : null;
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
    shown: intent?.level ?? stored ?? carried ?? (notApplied ? "optimal" : null),
    notApplied,
  };
}

/** Model id, effort, and price of one level, for its tooltip. */
function LevelTip({ setting }: { setting: DialSetting }) {
  const price = dialPrice(setting);
  const details = [
    setting.harness === "dsh"
      ? null
      : setting.effort
        ? `${REASONING_EFFORT_LABEL[setting.effort]} effort`
        : "Default effort",
    price
      ? `${formatCost(price.input, { precision: 2, placeholder: "?" })} in, ${formatCost(price.output, { precision: 2, placeholder: "?" })} out per 1M tokens`
      : null,
  ].filter(Boolean);
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-mono">{setting.model}</span>
      {details.length > 0 ? <span className="opacity-70">{details.join(" · ")}</span> : null}
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
 * Step 3, under the provider cards: one dial per agent (Cheap, Optimal,
 * Max) that stores a concrete model and effort for the agent's harness.
 * Picks store at once. Viewing never stores: agents without a model
 * override show Optimal with a hollow dot, and Continue stores Optimal for
 * them. Continue waits until every dial row has loaded.
 */
export function AgentModels({
  agents,
  configs,
  presence,
  switchedAgentIds,
  setContinueAction,
  className,
}: {
  agents: AgentWithTasks[];
  /** Global config rows, to see a stored OpenRouter key. */
  configs: SwarmConfig[];
  presence: EnvPresenceMap;
  /** Agents whose harness the operator switched in this session (the R2 switch). */
  switchedAgentIds: ReadonlySet<string>;
  setContinueAction: StepProps["setContinueAction"];
  className?: string;
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
    buildRow(
      agent,
      resolved[index],
      intents[agent.id],
      remembered[agent.id],
      switchedAgentIds.has(agent.id),
      context,
    ),
  );
  const dialRows = rows.filter((row) => row.harness !== null);
  useContinueHold(dialRows.some((row) => row.loading) ? "Loading agent settings…" : null);
  const shownLevels = dialRows.map((row) => row.shown);
  const allLevel =
    shownLevels.length > 0 &&
    shownLevels.every((level) => level !== null && level === shownLevels[0])
      ? shownLevels[0]
      : null;
  const harnessesInUse = [...new Set(dialRows.map((row) => row.harness as DialHarness))];

  // Continue stores Optimal on agents that have no model override yet. A row
  // that did not load is not among them (its icon says so).
  const defaults = dialRows.filter((row) => row.notApplied);
  useContinueAction(
    setContinueAction,
    defaults.length > 0
      ? async () => {
          const results = await Promise.allSettled(
            defaults.map((row) =>
              write(row.agent.id, dialSetting(row.harness as DialHarness, "optimal", context)),
            ),
          );
          const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
          if (failed.length > 0) {
            const reason = failed[0].reason instanceof Error ? ` ${failed[0].reason.message}` : "";
            throw new Error(
              `Could not apply Optimal to ${failed.length} agent${failed.length === 1 ? "" : "s"}.${reason}`,
            );
          }
        }
      : null,
  );

  if (listed.length === 0) return null;

  return (
    <SetupCard
      className={className}
      icon={<Gauge className="size-4" />}
      title="Models per agent"
      description={
        <span className="inline-flex items-center gap-1.5">
          Each agent runs its harness at one of three levels.
          <InfoTip content="Cheap costs least, Max runs the strongest model. Hover a level to see its model, effort, and price." />
        </span>
      }
      bodyClassName="p-0"
    >
      <div className="divide-y divide-border-subtle">
        {dialRows.length > 1 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-muted/30 px-4 py-1">
            <span className="min-w-0 flex-1 basis-40 text-xs font-medium">All agents</span>
            <span className="ml-auto flex items-center gap-3">
              <SegmentedControl
                aria-label="Level for all agents"
                value={allLevel}
                onValueChange={(level) =>
                  pick(
                    dialRows.map((row) => row.agent.id),
                    level,
                  )
                }
                options={levelOptions((level) => (
                  <span className="flex flex-col gap-0.5">
                    {harnessesInUse.map((harness) => (
                      <span key={harness}>
                        {HARNESS_LABEL[harness] ?? harness}:{" "}
                        <span className="font-mono">
                          {dialSetting(harness, level, context).model}
                        </span>
                      </span>
                    ))}
                  </span>
                ))}
              />
              {/* Keeps this dial in line with the per-agent dials. */}
              <span aria-hidden className="size-4 shrink-0" />
            </span>
          </div>
        ) : null}
        {/* About six rows show; more scroll inside the card. */}
        <ul className="max-h-[17rem] divide-y divide-border-subtle overflow-y-auto">
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
      </div>
    </SetupCard>
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
    value: target ? JSON.stringify([intent?.nonce ?? "carried", target]) : "",
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
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1">
      <span className="flex min-w-0 flex-1 basis-40 items-center gap-2.5">
        <span className="w-14 shrink-0">
          <SetupChip>{agent.isLead ? "Lead" : "Worker"}</SetupChip>
        </span>
        <span className="min-w-0 truncate font-mono text-xs">{agent.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <AiHarnessIcon harness={agent.harnessProvider} />
          {harnessLabel}
          {row.position === "custom" && !target ? <CustomModel row={row} /> : null}
        </span>
      </span>
      <span className="ml-auto flex h-9 items-center gap-3">
        {harness ? (
          <SegmentedControl
            aria-label={`Level for ${agent.name}`}
            value={row.shown}
            onValueChange={onPick}
            disabled={row.loading}
            options={levelOptions((level) => (
              <LevelTip setting={dialSetting(harness, level, context)} />
            ))}
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            {(agent.harnessProvider && MANAGED_BY[agent.harnessProvider]) ?? "No harness reported"}
          </span>
        )}
        {status ? (
          <StatusIcon tone={status.tone} label={status.label} />
        ) : (
          <LoadRetry onRetry={row.retry} />
        )}
      </span>
    </li>
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

/** "Custom": the agent runs a model outside the dial. The tooltip names it. */
function CustomModel({ row }: { row: Row }) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        className="rounded-sm text-muted-foreground/80 outline-none hover:text-foreground hover-linger transition-colors focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        · Custom
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <span className="flex flex-col gap-0.5">
          <span className="font-mono">{row.model}</span>
          <span className="opacity-70">
            {row.effort
              ? `${REASONING_EFFORT_LABEL[row.effort as ReasoningEffortLevel] ?? row.effort} effort. `
              : ""}
            Pick a level to replace it.
          </span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

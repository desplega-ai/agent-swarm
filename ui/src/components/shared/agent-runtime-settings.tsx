import { AlertTriangle, ArrowUpCircle, Check, ChevronsUpDown, Lock, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useUpdateAgentRuntime } from "@/api/hooks/use-agents";
import { useResolvedConfigs } from "@/api/hooks/use-config-api";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { type Agent, REASONING_EFFORT_LEVELS, type ReasoningEffortLevel } from "@/api/types";
import { HarnessIcon } from "@/components/shared/harness-icon";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  findModelOption,
  HARNESS_LABEL,
  isLocalHarness,
  type LiveBedrockStatus,
  LOCAL_HARNESSES,
  type LocalHarnessProvider,
  type ModelGroup,
  type ModelOption,
  modelGroupsForHarness,
  pickDefaultModelForHarness,
} from "@/lib/agent-runtime-models";
import { cn } from "@/lib/utils";

const REASONING_EFFORT_LABEL: Record<ReasoningEffortLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
};

/** Unset sentinel — no `REASONING_EFFORT_OVERRIDE` (harness-native default). */
type EffortValue = ReasoningEffortLevel | "";

const RUNTIME_EDIT_MIN_VERSION = "1.77.2";

const CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "CODEX_OAUTH",
];

function configuredModel(configs: { key: string; value: string }[] | undefined): string {
  return configs?.find((c) => c.key === "MODEL_OVERRIDE")?.value ?? "";
}

function configuredEffort(configs: { key: string; value: string }[] | undefined): EffortValue {
  const raw = configs?.find((c) => c.key === "REASONING_EFFORT_OVERRIDE")?.value;
  return (REASONING_EFFORT_LEVELS as readonly string[]).includes(raw ?? "")
    ? (raw as ReasoningEffortLevel)
    : "";
}

/** Nearest supported level by canonical-order distance — used to make the grey-out tooltip suggest an alternative without hardcoding any model name. */
function nearestSupportedLevel(
  level: ReasoningEffortLevel,
  levels: ReadonlyArray<ReasoningEffortLevel>,
): ReasoningEffortLevel | null {
  if (levels.length === 0) return null;
  const idx = REASONING_EFFORT_LEVELS.indexOf(level);
  return [...levels].sort(
    (a, b) =>
      Math.abs(REASONING_EFFORT_LEVELS.indexOf(a) - idx) -
      Math.abs(REASONING_EFFORT_LEVELS.indexOf(b) - idx),
  )[0];
}

export function AgentRuntimeSettings({ agent }: { agent: Agent }) {
  const initialHarness = isLocalHarness(agent.harnessProvider) ? agent.harnessProvider : "claude";
  const configsQuery = useResolvedConfigs({ agentId: agent.id });
  const envPresenceQuery = useEnvPresence(CREDENTIAL_KEYS);
  const updateRuntime = useUpdateAgentRuntime();
  const gate = useFeatureGate(RUNTIME_EDIT_MIN_VERSION);

  const configs = configsQuery.data ?? [];
  const [harness, setHarness] = useState<LocalHarnessProvider>(initialHarness);
  const [model, setModel] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [effort, setEffort] = useState<EffortValue>("");

  const liveBedrockStatus = useMemo<LiveBedrockStatus | null>(
    () =>
      agent.credStatus?.bedrock != null
        ? {
            ready: agent.credStatus.bedrock.ready,
            models: agent.credStatus.bedrock.models,
            error: agent.credStatus.bedrock.error,
          }
        : null,
    [agent.credStatus?.bedrock],
  );
  const groups = useMemo(
    () => modelGroupsForHarness(harness, configs, envPresenceQuery.data, liveBedrockStatus),
    [harness, configs, envPresenceQuery.data, liveBedrockStatus],
  );
  const modelOption = findModelOption(model, groups);
  const latestModel = agent.credStatus?.latestModel ?? null;

  useEffect(() => {
    const nextModel = configuredModel(configs);
    const nextGroups = modelGroupsForHarness(
      initialHarness,
      configs,
      envPresenceQuery.data,
      liveBedrockStatus,
    );
    setHarness(initialHarness);
    setModel(nextModel || pickDefaultModelForHarness(initialHarness, nextGroups));
    setEffort(configuredEffort(configs));
  }, [configs, initialHarness, envPresenceQuery.data, liveBedrockStatus]);

  // Clears `effort` whenever it ends up unsupported by the (possibly new)
  // selected model, rather than silently coercing it to a supported value.
  function clearEffortIfUnsupported(option: ModelOption | null) {
    setEffort((current) => {
      if (!current) return current;
      if (option?.reasoningLevels && !option.reasoningLevels.includes(current)) return "";
      return current;
    });
  }

  function changeModel(nextModel: string) {
    setModel(nextModel);
    clearEffortIfUnsupported(findModelOption(nextModel, groups));
  }

  function changeHarness(nextHarness: LocalHarnessProvider) {
    const nextGroups = modelGroupsForHarness(
      nextHarness,
      configs,
      envPresenceQuery.data,
      liveBedrockStatus,
    );
    setHarness(nextHarness);
    const nextModel = findModelOption(model, nextGroups)
      ? model
      : pickDefaultModelForHarness(nextHarness, nextGroups);
    if (nextModel !== model) setModel(nextModel);
    clearEffortIfUnsupported(findModelOption(nextModel, nextGroups));
  }

  function save() {
    if (!model.trim()) return;
    updateRuntime.mutate(
      {
        id: agent.id,
        harnessProvider: harness,
        model: model.trim(),
        allowCustomModel: customMode && !modelOption,
        reasoningEffort: effort || null,
      },
      {
        onSuccess: () => toast.success("Runtime settings updated"),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Update failed"),
      },
    );
  }

  const disabledChoice =
    !customMode && modelOption
      ? !groups.find((g) => g.provider === modelOption.provider)?.enabled
      : false;

  if (!gate.supported) {
    return (
      <UnsupportedApiNotice
        agent={agent}
        modelOption={modelOption}
        configuredModel={model}
        currentVersion={gate.currentVersion}
        requiredVersion={gate.requiredVersion}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44 space-y-1.5">
          <Label>Harness</Label>
          <Select value={harness} onValueChange={(v) => changeHarness(v as LocalHarnessProvider)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCAL_HARNESSES.map((h) => (
                <SelectItem key={h} value={h}>
                  <span className="flex items-center gap-2">
                    <HarnessIcon harness={h} className="h-4 w-4 opacity-100" />
                    {HARNESS_LABEL[h]}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-[260px] flex-1 space-y-1.5">
          <Label>Model</Label>
          {customMode ? (
            <Input value={model} onChange={(event) => changeModel(event.target.value)} />
          ) : (
            <ModelCombobox
              value={model}
              onChange={changeModel}
              groups={groups}
              selected={modelOption}
            />
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Reasoning effort</Label>
        <ReasoningEffortToggle
          value={effort}
          onChange={setEffort}
          levels={modelOption?.reasoningLevels}
          modelLabel={modelOption?.label ?? null}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={customMode} onCheckedChange={setCustomMode} />
          Allow unsupported/custom model
        </label>
        <Button
          onClick={save}
          disabled={updateRuntime.isPending || !model.trim() || disabledChoice}
        >
          <Save className="h-4 w-4" />
          Save
        </Button>
      </div>

      {disabledChoice ? (
        <p className="flex items-center gap-1.5 text-xs text-status-warning">
          <AlertTriangle className="h-3.5 w-3.5" />
          This model requires a missing provider key. Enable custom mode to save it anyway.
        </p>
      ) : null}

      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <span>
          Configured: <code>{model || "unset"}</code>
        </span>
        <span>
          Last used: <code>{latestModel?.model ?? "not reported"}</code>
        </span>
        <span>
          Effort: <code>{effort || "unset"}</code>
        </span>
        <span>
          Last effort: <code>{latestModel?.reasoningEffort ?? "not reported"}</code>
        </span>
      </div>

      {modelOption?.cost ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-mono tabular-nums">
            {formatCost(modelOption.cost.input) ?? "?"} in /{" "}
            {formatCost(modelOption.cost.output) ?? "?"} out
          </span>{" "}
          per 1M tokens
          {modelOption.contextWindow
            ? ` · ${formatContext(modelOption.contextWindow)} context`
            : ""}
          . Prices from <code>models.dev</code> snapshot — verify against provider billing.
        </p>
      ) : null}
    </div>
  );
}

interface ReasoningEffortToggleProps {
  value: EffortValue;
  onChange: (next: EffortValue) => void;
  /** Undefined = no capability data for the selected model — don't grey out anything. */
  levels: ReadonlyArray<ReasoningEffortLevel> | undefined;
  modelLabel: string | null;
}

function ReasoningEffortToggle({
  value,
  onChange,
  levels,
  modelLabel,
}: ReasoningEffortToggleProps) {
  return (
    <div className="inline-flex w-fit overflow-hidden rounded-md border border-border">
      {REASONING_EFFORT_LEVELS.map((level, index) => {
        const supported = levels ? levels.includes(level) : true;
        const active = value === level;
        const segment = (
          <button
            key={level}
            type="button"
            disabled={!supported}
            onClick={() => onChange(active ? "" : level)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors",
              index > 0 && "border-l border-border",
              active
                ? "bg-primary text-primary-foreground"
                : "bg-transparent text-foreground hover:bg-accent",
              !supported && "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
          >
            {REASONING_EFFORT_LABEL[level]}
          </button>
        );

        if (supported) return segment;

        const suggestion = levels?.length ? nearestSupportedLevel(level, levels) : null;
        return (
          <Tooltip key={level}>
            <TooltipTrigger asChild>
              <span>{segment}</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64">
              {modelLabel ?? "This model"} doesn't support "{REASONING_EFFORT_LABEL[level]}"
              {suggestion ? ` — use "${REASONING_EFFORT_LABEL[suggestion]}" instead.` : "."}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function UnsupportedApiNotice({
  agent,
  modelOption,
  configuredModel: configured,
  currentVersion,
  requiredVersion,
}: {
  agent: Agent;
  modelOption: ModelOption | null;
  configuredModel: string;
  currentVersion: string | null;
  requiredVersion: string;
}) {
  const harness = isLocalHarness(agent.harnessProvider) ? agent.harnessProvider : null;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-status-info/30 bg-status-info/5 p-3 text-xs">
        <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-info" />
        <div className="space-y-1">
          <p className="font-medium text-foreground">Runtime editor disabled</p>
          <p className="text-muted-foreground">
            Editing harness/model requires API{" "}
            <span className="font-mono">≥ {requiredVersion}</span>. This swarm is running{" "}
            {currentVersion ? (
              <span className="font-mono">v{currentVersion}</span>
            ) : (
              <span className="italic">an unknown version</span>
            )}
            . Showing current settings read-only.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">Harness:</span>
          {harness ? <HarnessIcon harness={harness} className="h-4 w-4" /> : null}
          <span>{harness ? HARNESS_LABEL[harness] : (agent.harnessProvider ?? "unknown")}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">Model:</span>
          {modelOption ? (
            <ProviderIcon provider={modelOption.providerId} className="h-4 w-4" />
          ) : null}
          <span>{modelOption ? modelOption.label : configured || "unset"}</span>
        </span>
      </div>
    </div>
  );
}

// Phase 12a — call the shared `formatCost` utility and adapt its return type
// (this component's call sites expect `null` for missing values rather than
// the shared utility's placeholder string).
import { formatCost as sharedFormatCost } from "@/lib/cost-format";

function formatCost(value: number | undefined): string | null {
  if (value === undefined || value === null) return null;
  return sharedFormatCost(value);
}

function formatContext(tokens: number | undefined): string | null {
  if (!tokens) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return `${tokens}`;
}

function ModelPrice({
  cost,
  contextWindow,
}: {
  cost: { input?: number; output?: number } | undefined;
  contextWindow: number | undefined;
}) {
  const inCost = formatCost(cost?.input);
  const outCost = formatCost(cost?.output);
  const ctx = formatContext(contextWindow);
  if (!inCost && !outCost && !ctx) return null;
  return (
    <span className="ml-2 hidden shrink-0 flex-col items-end text-[10px] leading-tight text-muted-foreground sm:flex">
      {(inCost || outCost) && (
        <span className="font-mono tabular-nums">
          {inCost ?? "?"} <span className="opacity-60">in</span> · {outCost ?? "?"}{" "}
          <span className="opacity-60">out</span>
        </span>
      )}
      {ctx && <span className="opacity-70">{ctx} ctx</span>}
    </span>
  );
}

interface ModelComboboxProps {
  value: string;
  onChange: (next: string) => void;
  groups: ModelGroup[];
  selected: ModelOption | null;
}

function ModelCombobox({ value, onChange, groups, selected }: ModelComboboxProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {selected ? <ProviderIcon provider={selected.providerId} className="h-4 w-4" /> : null}
            <span className="truncate">{selected ? selected.label : value || "Select model"}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-[280px] p-0" align="start">
        <Command
          filter={(itemValue, search) => {
            const haystack = itemValue.toLowerCase();
            const needle = search.toLowerCase().trim();
            if (!needle) return 1;
            const tokens = needle.split(/\s+/);
            return tokens.every((t) => haystack.includes(t)) ? 1 : 0;
          }}
        >
          <CommandInput placeholder="Search models..." />
          <CommandList className="max-h-72">
            <CommandEmpty>No models match.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup
                key={group.provider}
                heading={
                  <span className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-1.5">
                      {!group.enabled && <Lock className="h-3 w-3" />}
                      {group.provider}
                    </span>
                    {!group.enabled && group.disabledReason ? (
                      <span className="font-normal text-[10px] text-muted-foreground normal-case">
                        {group.disabledReason}
                      </span>
                    ) : null}
                  </span>
                }
              >
                {group.models.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={`${option.label} ${option.id} ${option.provider}`}
                    disabled={!group.enabled}
                    onSelect={() => {
                      onChange(option.id);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn("h-4 w-4", value === option.id ? "opacity-100" : "opacity-0")}
                    />
                    <ProviderIcon provider={option.providerId} className="h-4 w-4" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{option.label}</span>
                      <span className="truncate text-xs text-muted-foreground">{option.id}</span>
                    </span>
                    <ModelPrice cost={option.cost} contextWindow={option.contextWindow} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

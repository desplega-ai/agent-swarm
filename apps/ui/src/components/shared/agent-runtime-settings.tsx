import { AlertTriangle, ArrowUpCircle, Check, ChevronsUpDown, Lock, Save } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useUpdateAgentRuntime } from "@/api/hooks/use-agents";
import { useResolvedConfigs } from "@/api/hooks/use-config-api";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { useModelsCatalog } from "@/api/hooks/use-models-catalog";
import {
  type AcpSessionConfigOption,
  type AcpTarget,
  type Agent,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffortLevel,
} from "@/api/types";
import { HarnessIcon } from "@/components/shared/harness-icon";
import { ProviderIcon } from "@/components/shared/provider-icon";
import {
  AUTO_DESCRIPTION,
  AUTO_LABEL,
  REASONING_EFFORT_DESCRIPTION,
  REASONING_EFFORT_LABEL,
  ReasoningEffortIcon,
} from "@/components/shared/reasoning-effort-icon";
import { AlertCallout } from "@/components/ui/alert-callout";
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
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ACP_TARGET_CATALOG } from "@/lib/acp-target-catalog";
import {
  findModelOption,
  HARNESS_LABEL,
  harnessSupportsModelSelection,
  isLocalHarness,
  type LiveBedrockStatus,
  LOCAL_HARNESSES,
  type LocalHarnessProvider,
  type ModelGroup,
  type ModelOption,
  modelGroupsForAcpTarget,
  modelGroupsForHarness,
  pickDefaultModelForHarness,
} from "@/lib/agent-runtime-models";
import { cn } from "@/lib/utils";

/** Unset sentinel — no `REASONING_EFFORT_OVERRIDE` (harness-native default). */
type EffortValue = ReasoningEffortLevel | "";

const RUNTIME_EDIT_MIN_VERSION = "1.77.2";
const ACP_RUNTIME_EDIT_MIN_VERSION = "1.142.0";

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

function configuredValue(
  configs: { key: string; value: string }[] | undefined,
  key: string,
): string {
  return configs?.find((config) => config.key === key)?.value ?? "";
}

export function configuredAcpCommand(
  configs: { key: string; value: string }[] | undefined,
): string {
  return configuredValue(configs, "ACP_TARGET_COMMAND") || configuredValue(configs, "ACP_COMMAND");
}

function configuredStringList(
  configs: { key: string; value: string }[] | undefined,
  key: string,
  fallbackSeparator: RegExp,
): string[] {
  const raw = configuredValue(configs, key).trim();
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  } catch {
    // Fall through to the runtime-compatible legacy representation.
  }
  return raw.split(fallbackSeparator).filter(Boolean);
}

export function configuredAcpInvocation(configs: { key: string; value: string }[] | undefined): {
  command: string;
  args: string[];
} {
  const command = configuredAcpCommand(configs).trim();
  const args = configuredStringList(configs, "ACP_TARGET_ARGS", /\s+/);
  if (!command || args.length > 0) return { command, args };

  const [executable = "", ...inlineArgs] = command.split(/\s+/).filter(Boolean);
  return { command: executable, args: inlineArgs };
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function configuredAcpTarget(
  configs: { key: string; value: string }[] | undefined,
  fallback: AcpTarget,
): AcpTarget {
  const target = configuredValue(configs, "ACP_TARGET");
  return target === "opencode" || target === "custom" ? target : fallback;
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
  const acpGate = useFeatureGate(ACP_RUNTIME_EDIT_MIN_VERSION);

  const configs = configsQuery.data ?? [];
  const [harness, setHarness] = useState<LocalHarnessProvider>(initialHarness);
  const [model, setModel] = useState(() => configuredModel(configs));
  const [customMode, setCustomMode] = useState(false);
  const [effort, setEffort] = useState<EffortValue>("");
  const [acpTarget, setAcpTarget] = useState<AcpTarget>(
    configuredAcpTarget(configs, initialHarness === "acp" ? "custom" : "opencode"),
  );
  const [acpCommand, setAcpCommand] = useState(() => configuredAcpInvocation(configs).command);
  const [acpArgs, setAcpArgs] = useState(() => configuredAcpInvocation(configs).args.join("\n"));
  const [acpEnvKeys, setAcpEnvKeys] = useState(() =>
    configuredStringList(configs, "ACP_TARGET_ENV_KEYS", /\s*,\s*/).join("\n"),
  );
  const [acpModelEnvKey, setAcpModelEnvKey] = useState(() =>
    configuredValue(configs, "ACP_MODEL_ENV_KEY"),
  );
  const modelSelectionEnabled = harnessSupportsModelSelection(harness);
  const acpSelected = harness === "acp";

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
  const catalogQuery = useModelsCatalog();
  const liveCatalog = catalogQuery.data?.providers ?? null;
  const groups = useMemo(
    () =>
      modelGroupsForHarness(
        harness,
        configs,
        envPresenceQuery.data,
        liveBedrockStatus,
        liveCatalog,
      ),
    [harness, configs, envPresenceQuery.data, liveBedrockStatus, liveCatalog],
  );
  const modelOption = findModelOption(model, groups);
  const acpModelGroups = useMemo(
    () => modelGroupsForAcpTarget(acpTarget, liveCatalog),
    [acpTarget, liveCatalog],
  );
  const acpModelOption = findModelOption(model, acpModelGroups);
  const latestModel = agent.credStatus?.latestModel ?? null;

  // Re-syncs the editable fields from PERSISTED settings only when those
  // settings actually change. The async inputs (env presence, Bedrock probe,
  // live catalog — which also refetches on an interval) stay in the dependency
  // list because the default-model pick reads them, but their arrival must not
  // reinitialize the form and discard in-progress edits — hence the syncKey
  // guard.
  const syncKey = [
    agent.id,
    initialHarness,
    configuredModel(configs),
    configuredEffort(configs),
    configuredValue(configs, "ACP_TARGET"),
    configuredValue(configs, "ACP_TARGET_COMMAND"),
    configuredValue(configs, "ACP_COMMAND"),
    configuredValue(configs, "ACP_TARGET_ARGS"),
    configuredValue(configs, "ACP_TARGET_ENV_KEYS"),
    configuredValue(configs, "ACP_MODEL_ENV_KEY"),
  ].join("|");
  const lastSyncKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastSyncKey.current === syncKey) return;
    lastSyncKey.current = syncKey;
    const nextModel = configuredModel(configs);
    const nextGroups = modelGroupsForHarness(
      initialHarness,
      configs,
      envPresenceQuery.data,
      liveBedrockStatus,
      liveCatalog,
    );
    setHarness(initialHarness);
    setModel(nextModel || pickDefaultModelForHarness(initialHarness, nextGroups));
    setEffort(harnessSupportsModelSelection(initialHarness) ? configuredEffort(configs) : "");
    setAcpTarget(configuredAcpTarget(configs, initialHarness === "acp" ? "custom" : "opencode"));
    const invocation = configuredAcpInvocation(configs);
    setAcpCommand(invocation.command);
    setAcpArgs(invocation.args.join("\n"));
    setAcpEnvKeys(configuredStringList(configs, "ACP_TARGET_ENV_KEYS", /\s*,\s*/).join("\n"));
    setAcpModelEnvKey(configuredValue(configs, "ACP_MODEL_ENV_KEY"));
  }, [syncKey, configs, initialHarness, envPresenceQuery.data, liveBedrockStatus, liveCatalog]);

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
      liveCatalog,
    );
    setHarness(nextHarness);
    if (nextHarness === "acp" && harness !== "acp") setAcpTarget("opencode");
    if (!harnessSupportsModelSelection(nextHarness)) setEffort("");
    const nextModel = findModelOption(model, nextGroups)
      ? model
      : pickDefaultModelForHarness(nextHarness, nextGroups);
    if (nextModel !== model) setModel(nextModel);
    if (harnessSupportsModelSelection(nextHarness)) {
      clearEffortIfUnsupported(findModelOption(nextModel, nextGroups));
    }
  }

  function save() {
    if (modelSelectionEnabled && !model.trim()) return;
    if (acpSelected && acpTarget === "custom" && !acpCommand.trim()) return;
    updateRuntime.mutate(
      {
        id: agent.id,
        harnessProvider: harness,
        model: modelSelectionEnabled || acpSelected ? model.trim() || null : null,
        allowCustomModel: modelSelectionEnabled && customMode && !modelOption,
        reasoningEffort: modelSelectionEnabled ? effort || null : null,
        ...(acpSelected
          ? {
              acp:
                acpTarget === "custom"
                  ? {
                      target: acpTarget,
                      command: acpCommand.trim() || null,
                      args: lines(acpArgs),
                      envKeys: lines(acpEnvKeys),
                      modelEnvKey: acpModelEnvKey.trim() || null,
                    }
                  : { target: acpTarget },
            }
          : {}),
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

        {modelSelectionEnabled ? (
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
        ) : null}
      </div>

      {acpSelected ? (
        <div className="space-y-3 rounded-md border border-border p-3">
          {!acpGate.supported ? (
            <AlertCallout tone="info" icon={ArrowUpCircle}>
              <p className="text-muted-foreground">
                ACP target configuration requires API{" "}
                <span className="font-mono">≥ {ACP_RUNTIME_EDIT_MIN_VERSION}</span>.
              </p>
            </AlertCallout>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>ACP preset</Label>
              <Select value={acpTarget} onValueChange={(value) => setAcpTarget(value as AcpTarget)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACP_TARGET_CATALOG.map((target) => (
                    <SelectItem key={target.id} value={target.id}>
                      {target.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Model</Label>
              <ModelCombobox
                value={model}
                onChange={setModel}
                groups={acpModelGroups}
                selected={acpModelOption}
                placeholder="Use target default"
                creatable
              />
              <p className="text-xs text-muted-foreground">
                Choose a known model or enter any model ID. Applied through ACP when the target
                advertises a model option, with the preset fallback otherwise.
              </p>
            </div>
          </div>

          {acpTarget === "custom" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="acp-command">Command</Label>
                <Input
                  id="acp-command"
                  value={acpCommand}
                  onChange={(event) => setAcpCommand(event.target.value)}
                  placeholder="path/to/acp-agent"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="acp-args">Arguments</Label>
                <Textarea
                  id="acp-args"
                  value={acpArgs}
                  onChange={(event) => setAcpArgs(event.target.value)}
                  placeholder={"One argument per line"}
                  className="min-h-24 font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="acp-env-keys">Environment keys</Label>
                <Textarea
                  id="acp-env-keys"
                  value={acpEnvKeys}
                  onChange={(event) => setAcpEnvKeys(event.target.value)}
                  placeholder={"One config or environment key per line"}
                  className="min-h-24 font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="acp-model-env-key">Model fallback environment key</Label>
                <Input
                  id="acp-model-env-key"
                  value={acpModelEnvKey}
                  onChange={(event) => setAcpModelEnvKey(event.target.value)}
                  placeholder="Optional"
                  className="font-mono"
                />
              </div>
            </div>
          ) : null}

          <AcpAdvertisedOptions options={agent.credStatus?.acp?.configOptions} />
        </div>
      ) : null}

      {modelSelectionEnabled ? (
        <div className="space-y-1.5">
          <Label>Reasoning effort</Label>
          <ReasoningEffortToggle
            value={effort}
            onChange={setEffort}
            levels={modelOption?.reasoningLevels}
            modelLabel={modelOption?.label ?? null}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {modelSelectionEnabled ? (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={customMode} onCheckedChange={setCustomMode} />
            Allow unsupported/custom model
          </label>
        ) : null}
        <Button
          onClick={save}
          disabled={
            updateRuntime.isPending ||
            (acpSelected && !acpGate.supported) ||
            (modelSelectionEnabled && (!model.trim() || disabledChoice)) ||
            (acpSelected && acpTarget === "custom" && !acpCommand.trim())
          }
        >
          <Save className="h-4 w-4" />
          Save
        </Button>
      </div>

      {disabledChoice ? (
        <p className="flex items-center gap-1.5 text-xs text-status-warning-strong">
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
        {modelSelectionEnabled ? (
          <>
            <span className="flex items-center gap-1.5">
              Effort:{" "}
              <ReasoningEffortIcon level={effort || undefined} className="text-muted-foreground" />{" "}
              <code>{effort ? REASONING_EFFORT_LABEL[effort] : AUTO_LABEL}</code>
            </span>
            <span className="flex items-center gap-1.5">
              Last effort:{" "}
              <ReasoningEffortIcon
                level={latestModel?.reasoningEffort}
                className="text-muted-foreground"
              />{" "}
              <code>
                {latestModel?.reasoningEffort
                  ? REASONING_EFFORT_LABEL[latestModel.reasoningEffort]
                  : "not reported"}
              </code>
            </span>
          </>
        ) : null}
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
          . Prices from <code>models.dev</code>{" "}
          {catalogQuery.data?.source === "live" ? "live catalog" : "snapshot"} — verify against
          provider billing.
        </p>
      ) : null}
    </div>
  );
}

function AcpAdvertisedOptions({ options }: { options: AcpSessionConfigOption[] | undefined }) {
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div>
        <p className="text-sm font-medium">Advertised options</p>
        <p className="text-xs text-muted-foreground">
          Options reported by the most recent ACP session.
        </p>
      </div>
      {options === undefined ? (
        <p className="text-xs text-muted-foreground">Not reported yet.</p>
      ) : options.length === 0 ? (
        <p className="text-xs text-muted-foreground">This target advertised no options.</p>
      ) : (
        <div className="space-y-2">
          {options.map((option) => {
            const choices =
              option.type === "select"
                ? option.options.flatMap((entry) =>
                    "group" in entry ? entry.options.map((item) => item.name) : [entry.name],
                  )
                : [];
            return (
              <div key={option.id} className="rounded-md bg-muted/40 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{option.name}</span>
                  <code>{String(option.currentValue)}</code>
                </div>
                <p className="mt-0.5 text-muted-foreground">
                  <code>{option.id}</code> · {option.category ?? option.type}
                </p>
                {option.description ? (
                  <p className="mt-1 text-muted-foreground">{option.description}</p>
                ) : null}
                {choices.length > 0 ? (
                  <p className="mt-1 text-muted-foreground">Available: {choices.join(", ")}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
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

function ReasoningEffortSegment({
  active,
  disabled,
  onClick,
  bordered,
  icon,
  label,
  description,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  bordered: boolean;
  icon: ReactNode;
  label: string;
  description: string;
}) {
  const segment = (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-9 items-center gap-1.5 px-3 text-xs font-medium transition-colors",
        bordered && "border-l border-border",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-transparent text-foreground hover:bg-accent",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{segment}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        <span className="font-medium">{label}</span> — {description}
      </TooltipContent>
    </Tooltip>
  );
}

function ReasoningEffortToggle({
  value,
  onChange,
  levels,
  modelLabel,
}: ReasoningEffortToggleProps) {
  return (
    <div className="inline-flex w-fit overflow-hidden rounded-md border border-border">
      <ReasoningEffortSegment
        active={value === ""}
        disabled={false}
        onClick={() => onChange("")}
        bordered={false}
        icon={<ReasoningEffortIcon level={undefined} />}
        label={AUTO_LABEL}
        description={AUTO_DESCRIPTION}
      />
      {REASONING_EFFORT_LEVELS.map((level) => {
        const supported = levels ? levels.includes(level) : true;
        const active = value === level;

        if (supported) {
          return (
            <ReasoningEffortSegment
              key={level}
              active={active}
              disabled={false}
              onClick={() => onChange(active ? "" : level)}
              bordered
              icon={<ReasoningEffortIcon level={level} />}
              label={REASONING_EFFORT_LABEL[level]}
              description={REASONING_EFFORT_DESCRIPTION[level]}
            />
          );
        }

        const suggestion = levels?.length ? nearestSupportedLevel(level, levels) : null;
        const unsupportedReason = `${modelLabel ?? "This model"} doesn't support "${REASONING_EFFORT_LABEL[level]}"${
          suggestion ? ` — use "${REASONING_EFFORT_LABEL[suggestion]}" instead.` : "."
        }`;
        return (
          <ReasoningEffortSegment
            key={level}
            active={false}
            disabled={true}
            onClick={() => {}}
            bordered
            icon={<ReasoningEffortIcon level={level} />}
            label={REASONING_EFFORT_LABEL[level]}
            description={unsupportedReason}
          />
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
        <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-info-strong" />
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
  placeholder?: string;
  creatable?: boolean;
}

function ModelCombobox({
  value,
  onChange,
  groups,
  selected,
  placeholder = "Select model",
  creatable = false,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const customValue = search.trim();
  const exactMatch = groups.some((group) =>
    group.models.some((option) => option.id === customValue),
  );

  function choose(nextValue: string) {
    onChange(nextValue);
    setSearch("");
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {selected ? <ProviderIcon provider={selected.providerId} className="h-4 w-4" /> : null}
            <span className="truncate">{selected ? selected.label : value || placeholder}</span>
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
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={creatable ? "Search or enter a model ID..." : "Search models..."}
          />
          <CommandList className="max-h-72">
            <CommandEmpty>
              {creatable ? "Type a model ID to use it." : "No models match."}
            </CommandEmpty>
            {creatable && customValue && !exactMatch ? (
              <CommandGroup heading="Custom">
                <CommandItem value={customValue} onSelect={() => choose(customValue)}>
                  <span className="truncate">
                    Use <span className="font-mono">{customValue}</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
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
                    onSelect={() => choose(option.id)}
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

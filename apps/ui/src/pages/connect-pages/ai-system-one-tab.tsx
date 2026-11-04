import { Workflow } from "lucide-react";
import { useId } from "react";
import { useConfigs, useUpsertConfigsBatch } from "@/api/hooks/use-config-api";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import type { SwarmConfig } from "@/api/types";
import { ProviderLogo } from "@/components/providers/provider-logo";
import { EmptyState } from "@/components/shared/empty-state";
import { KeyStatusPill, type KeyStatusTone } from "@/components/shared/key-status-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { type AiProvider, findAiProvider } from "@/lib/ai-providers";
import {
  SYSTEM_ONE_DECIDE_DEFAULT_KEY,
  SYSTEM_ONE_EXTRACT_DEFAULT_KEY,
  SYSTEM_ONE_FALLBACK,
  SYSTEM_ONE_HOST_VIEWS,
  type SystemOneCapability,
  type SystemOneHostView,
  systemOneHostLabel,
  systemOneHostName,
  systemOneHostsServing,
  systemOneModels,
  systemOneRequiredKeys,
  systemOneServiceModels,
} from "@/lib/system-one-hosts";
import { cn } from "@/lib/utils";
import { TabIntro } from "./ai-tab-parts";

const WORKFLOWS_GUIDE = "https://docs.agent-swarm.dev/docs/concepts/workflows#systemone-decision";

/** Host, Serves, Models, Credential, Status, action. Rows stack on phones. */
const HOST_GRID =
  "md:grid md:grid-cols-[minmax(0,1.5fr)_8.5rem_minmax(0,1fr)_minmax(0,1.3fr)_6.5rem_4.5rem] md:items-center md:gap-x-4";

/** Keys the env decides: the OpenRouter pool and an env-only default. */
const PRESENCE_KEYS = [
  ...SYSTEM_ONE_HOST_VIEWS.filter((h) => h.sharedWithLlms).map((h) => h.keyName),
  SYSTEM_ONE_DECIDE_DEFAULT_KEY,
  SYSTEM_ONE_EXTRACT_DEFAULT_KEY,
];

export type SystemOneHostState = "configured" | "partial" | "unset";

export interface SystemOneHostRow {
  host: SystemOneHostView;
  state: SystemOneHostState;
  /** The keys still missing, for a partial host. */
  missing: string[];
}

function globalValue(configs: SwarmConfig[], key: string): string | undefined {
  const value = configs.find((c) => c.scope === "global" && c.key === key)?.value.trim();
  return value ? value : undefined;
}

/**
 * Credential state of each host, read like the server does: the OpenRouter
 * key from the API server's environment, every other key from its global
 * config row (the executor reads only the row).
 */
export function systemOneHostRows(
  configs: SwarmConfig[],
  presence: Record<string, boolean>,
): SystemOneHostRow[] {
  return SYSTEM_ONE_HOST_VIEWS.map((host) => {
    const isSet = (key: string) =>
      host.sharedWithLlms ? presence[key] === true : globalValue(configs, key) !== undefined;
    const groups = systemOneRequiredKeys(host);
    const missing = groups.filter((group) => !group.some(isSet)).map((group) => group[0] ?? "");
    const state: SystemOneHostState =
      missing.length === 0 ? "configured" : missing.length < groups.length ? "partial" : "unset";
    return { host, state, missing };
  });
}

/** The host a node without `provider` uses: the stored row, else the server fallback. */
export function systemOneDefault(
  configs: SwarmConfig[],
  capability: SystemOneCapability,
): { id: string; stored: boolean } {
  const key =
    capability === "decide" ? SYSTEM_ONE_DECIDE_DEFAULT_KEY : SYSTEM_ONE_EXTRACT_DEFAULT_KEY;
  const value = globalValue(configs, key)?.toLowerCase();
  const valid = systemOneHostsServing(capability).some((h) => h.id === value);
  return valid && value
    ? { id: value, stored: true }
    : { id: SYSTEM_ONE_FALLBACK[capability], stored: false };
}

/** Host rows plus the reads behind them, for the tab and its count. */
export function useSystemOneHosts() {
  const configs = useConfigs({ scope: "global" });
  const presence = useEnvPresence(PRESENCE_KEYS);
  const list = configs.data ?? [];
  return {
    configs: list,
    presence: presence.data ?? {},
    rows: systemOneHostRows(list, presence.data ?? {}),
    loading: configs.isLoading,
  };
}

/** The panel a host's Set up opens: OpenRouter shares the LLMs panel. */
export function systemOnePanelId(host: SystemOneHostView): string {
  return host.sharedWithLlms ? host.id : `system-one-${host.id}`;
}

function panelOf(host: SystemOneHostView): AiProvider | undefined {
  return findAiProvider(systemOnePanelId(host));
}

const STATE_PILL: Record<SystemOneHostState, { tone: KeyStatusTone; label: string }> = {
  configured: { tone: "success", label: "Configured" },
  partial: { tone: "warning", label: "Incomplete" },
  unset: { tone: "neutral", label: "Not set" },
};

function DefaultSelect({
  capability,
  title,
  description,
  configs,
  presence,
}: {
  capability: SystemOneCapability;
  title: string;
  description: string;
  configs: SwarmConfig[];
  presence: Record<string, boolean>;
}) {
  const id = useId();
  const key =
    capability === "decide" ? SYSTEM_ONE_DECIDE_DEFAULT_KEY : SYSTEM_ONE_EXTRACT_DEFAULT_KEY;
  const upsert = useUpsertConfigsBatch();
  const current = systemOneDefault(configs, capability);
  const hosts = systemOneHostsServing(capability);
  const envOnly = !current.stored && presence[key] === true;

  return (
    <div className="flex min-w-0 flex-col gap-2 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-semibold">
          {title}
        </label>
        <code className="truncate font-mono text-[11px] text-muted-foreground">{key}</code>
      </div>
      <p className="text-xs text-muted-foreground">
        {description}
        {envOnly ? " The deployment env sets it too. A pick here wins." : null}
      </p>
      <Select
        value={current.id}
        disabled={upsert.isPending}
        onValueChange={(value) => upsert.mutate([{ key, value, isSecret: false, scope: "global" }])}
      >
        <SelectTrigger id={id} className="w-full sm:max-w-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {hosts.map((host) => (
            <SelectItem key={host.id} value={host.id}>
              {systemOneHostLabel(host, capability)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ServesTag({ active, children }: { active: boolean; children: string }) {
  return (
    <Badge variant="outline" size="tag" className="gap-1.5">
      {active ? (
        <span
          role="img"
          aria-label="default"
          className="size-1.5 shrink-0 rounded-full bg-primary"
        />
      ) : null}
      {children}
    </Badge>
  );
}

function HostRow({
  row,
  defaults,
  onSetUp,
}: {
  row: SystemOneHostRow;
  defaults: Record<SystemOneCapability, string>;
  onSetUp: (panelId: string) => void;
}) {
  const { host, state, missing } = row;
  const panel = panelOf(host);
  const pill = STATE_PILL[state];
  const models = systemOneModels(host);
  const keys = systemOneRequiredKeys(host).map((group) => group[0] ?? "");
  const name = systemOneHostName(host);

  return (
    <li className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 px-4 py-3", HOST_GRID)}>
      <div className="flex min-w-0 items-center gap-3">
        {panel ? <ProviderLogo provider={panel} /> : null}
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm">
            <span className="font-medium">{host.family}</span>
            {host.via ? <span className="text-muted-foreground"> via {host.via}</span> : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">{host.detail}</span>
        </div>
      </div>
      <div className="col-span-2 flex flex-wrap gap-1.5 md:col-span-1">
        {host.decide ? <ServesTag active={defaults.decide === host.id}>Decide</ServesTag> : null}
        {host.extract ? <ServesTag active={defaults.extract === host.id}>Extract</ServesTag> : null}
      </div>
      <span className="col-span-2 min-w-0 font-mono text-xs text-muted-foreground md:col-span-1">
        {models.length > 0
          ? [systemOneServiceModels(host.decide), systemOneServiceModels(host.extract)]
              .filter((list) => list.length > 0)
              .map((list) => list.join(", "))
              .join(" · ")
          : "Picked from the text"}
      </span>
      <div className="col-span-2 flex min-w-0 flex-row flex-wrap items-start gap-1 md:col-span-1 md:flex-col">
        {keys.map((key) => (
          <code
            key={key}
            className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
          >
            {key}
          </code>
        ))}
        {host.sharedWithLlms ? (
          <span className="text-xs text-muted-foreground">Shared with LLMs</span>
        ) : null}
      </div>
      <div className="col-start-2 row-start-1 flex flex-col items-end gap-1 md:col-start-auto md:row-start-auto md:items-start">
        <KeyStatusPill tone={pill.tone}>{pill.label}</KeyStatusPill>
        {state === "partial" ? (
          <span className="text-xs text-status-warning-strong">Needs {missing.join(", ")}</span>
        ) : null}
      </div>
      <div className="col-span-2 flex md:col-span-1 md:justify-end">
        {panel ? (
          <Button
            type="button"
            variant={state === "configured" ? "ghost" : "outline"}
            size="sm"
            aria-label={`${state === "configured" ? "Edit" : "Set up"} ${name}`}
            onClick={() => onSetUp(panel.id)}
          >
            {state === "configured" ? "Edit" : "Set up"}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** Hosts whose name, id, model or key matches the search. */
function matchHosts(rows: SystemOneHostRow[], search: string): SystemOneHostRow[] {
  const q = search.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(({ host }) =>
    [
      systemOneHostName(host),
      host.id,
      host.detail,
      ...systemOneModels(host),
      ...systemOneRequiredKeys(host).flat(),
    ].some((text) => text.toLowerCase().includes(q)),
  );
}

/**
 * Connect › AI providers › System One: the two defaults (decide, extract) on
 * top, then one row per host with what it serves, its models, the keys it
 * reads and whether they are set. Set up and Edit open the shared side panel.
 */
export function SystemOneTab({
  search,
  onSetUp,
}: {
  search: string;
  onSetUp: (panelId: string) => void;
}) {
  const { configs, presence, rows, loading } = useSystemOneHosts();
  const defaults = {
    decide: systemOneDefault(configs, "decide").id,
    extract: systemOneDefault(configs, "extract").id,
  };
  const shown = matchHosts(rows, search);

  return (
    <div className="flex flex-col gap-3">
      <TabIntro href={WORKFLOWS_GUIDE} label="Workflows guide">
        Fast typed decisions and extraction in workflows and gates.
      </TabIntro>

      {loading ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="grid overflow-hidden rounded-lg border border-border md:grid-cols-2 md:divide-x divide-y md:divide-y-0 divide-border">
          <DefaultSelect
            capability="decide"
            title="Decisions"
            description="For a node or call that names no provider. Applies to the next decision."
            configs={configs}
            presence={presence}
          />
          <DefaultSelect
            capability="extract"
            title="Extraction"
            description="For an extraction node that names no provider. Applies to the next extraction."
            configs={configs}
            presence={presence}
          />
        </div>
      )}

      {shown.length === 0 && !loading ? (
        <EmptyState
          icon={Workflow}
          title="No hosts match"
          description="Clear the search to see every host."
          compact
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div
            aria-hidden
            className={cn(
              HOST_GRID,
              "hidden border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground",
            )}
          >
            <span>Host</span>
            <span className="flex items-center gap-1.5">
              Serves
              <span className="size-1.5 rounded-full bg-primary" />
              <span className="font-normal">default</span>
            </span>
            <span>Models</span>
            <span>Credential</span>
            <span>Status</span>
            <span />
          </div>
          {loading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <ul aria-label="System One hosts" className="divide-y divide-border-subtle">
              {shown.map((row) => (
                <HostRow key={row.host.id} row={row} defaults={defaults} onSetUp={onSetUp} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

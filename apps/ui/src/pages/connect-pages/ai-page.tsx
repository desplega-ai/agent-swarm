import { ArrowLeftRight, Cpu, Info } from "lucide-react";
import { useState } from "react";
import { AddProviderMenu } from "@/components/providers/add-provider-menu";
import { PROVIDER_GRID } from "@/components/providers/pool-key-row";
import { ProviderListRow } from "@/components/providers/provider-row";
import { ProviderSetupPanel } from "@/components/providers/provider-setup-panel";
import { useLlmProviderRows } from "@/components/providers/use-llm-provider-rows";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import {
  AI_PROVIDERS,
  countLabel,
  findAiProvider,
  matchAiProviders,
  type ProviderRow,
} from "@/lib/ai-providers";
import { formatCost } from "@/lib/cost-format";
import { cn } from "@/lib/utils";
import { EmbeddingsPanel, EmbeddingsTab } from "./ai-embeddings-tab";
import { SystemOneTab, useSystemOneHosts } from "./ai-system-one-tab";
import { TranscriptionPanel, TranscriptionTab } from "./ai-transcription-tab";
import { ConnectPhoneTitle, ConnectSearch } from "./connect-shell";

const TABS = [
  { value: "llm", label: "LLMs" },
  { value: "system-one", label: "System One" },
  { value: "embeddings", label: "Embeddings" },
  { value: "transcription", label: "Transcription" },
] as const;
type AiTab = (typeof TABS)[number]["value"];

function coerceTab(value: string): AiTab {
  return TABS.some((tab) => tab.value === value) ? (value as AiTab) : "llm";
}

/** `?add=` values of the two tabs whose panel changes the one setup they show. */
const EMBEDDINGS_PANEL = "embeddings";
const TRANSCRIPTION_PANEL = "transcription";

/** Rows whose provider, harness or key name matches the search. */
function matchRows(rows: ProviderRow[], search: string): ProviderRow[] {
  const q = search.trim().toLowerCase();
  if (!q) return rows;
  const providers = new Set(matchAiProviders(AI_PROVIDERS, q).map((p) => p.id));
  return rows.filter(
    (row) =>
      providers.has(row.provider.id) ||
      row.keys.some(
        (k) => k.label.toLowerCase().includes(q) || (k.suffix ?? "").toLowerCase().includes(q),
      ),
  );
}

/** Provider id to its key count, or "Set up" for a provider without a pool of its own. */
function configuredMap(rows: ProviderRow[], presence: Record<string, boolean>) {
  const map: Record<string, string> = {};
  for (const row of rows) map[row.provider.id] = countLabel(row.keys.length, row.provider.noun);
  for (const provider of AI_PROVIDERS) {
    if (provider.configuredBy?.every((key) => presence[key])) map[provider.id] = "Set up";
  }
  return map;
}

function LlmList({
  rows,
  loading,
  searching,
  onAdd,
}: {
  rows: ProviderRow[];
  loading: boolean;
  /** A search is on: an empty list means no match, not no providers. */
  searching: boolean;
  onAdd: (providerId: string) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (loading && rows.length === 0) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Cpu}
        title={searching ? "No AI providers match" : "No AI providers yet"}
        description={
          searching
            ? "Clear the search, or add a provider."
            : "Agents need at least one model. Pick a provider from Add provider."
        }
        compact
      />
    );
  }

  const keyCount = rows.reduce((sum, row) => sum + row.keys.length, 0);
  const today = rows.reduce((sum, row) => sum + row.costToday, 0);
  const week = rows.reduce((sum, row) => sum + row.cost7d, 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-lg border border-border">
        <div
          aria-hidden
          className={cn(
            PROVIDER_GRID,
            "hidden border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground",
          )}
        >
          <span>Provider</span>
          <span>Type</span>
          <span>Keys</span>
          <span>Status</span>
          <span className="text-right">Today</span>
          <span className="text-right">7 days</span>
          <span />
        </div>
        <ul aria-label="Configured AI providers">
          {rows.map((row) => (
            <ProviderListRow
              key={row.provider.id}
              row={row}
              open={open.has(row.provider.id)}
              onToggle={() => toggle(row.provider.id)}
              onAdd={() => onAdd(row.provider.id)}
            />
          ))}
        </ul>
        <div
          className={cn(
            PROVIDER_GRID,
            "flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs",
          )}
        >
          <span className="text-muted-foreground md:col-span-4">
            {countLabel(keyCount, "key")} across {countLabel(rows.length, "provider")}
            <span className="md:hidden">
              {" "}
              · Today {formatCost(today, { placeholder: "$0" })} · 7 days{" "}
              {formatCost(week, { placeholder: "$0" })}
            </span>
          </span>
          <span className="hidden text-right font-mono font-semibold md:block">
            {formatCost(today, { placeholder: "$0" })}
          </span>
          <span className="hidden text-right font-mono font-semibold md:block">
            {formatCost(week, { placeholder: "$0" })}
          </span>
          <span className="hidden md:block" />
        </div>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Info aria-hidden className="size-3.5 shrink-0" />
        Today and 7 days show the API value of each run. Subscriptions bill a flat monthly fee.
      </p>
    </div>
  );
}

/**
 * Connect › AI providers: tabs LLMs | System One | Embeddings | Transcription
 * (`?tab=`). LLMs is one list of the configured providers with their keys,
 * status and spend, plus "Add provider", which opens a side panel with the
 * setup steps (`?add=<provider>`). System One lists the typed decision and
 * extraction hosts and the two defaults; its Set up opens the same panel
 * (`?add=system-one-<host>`). Embeddings and Transcription show the one setup
 * in use; "Change provider" opens their own panel (`?add=embeddings`,
 * `?add=transcription`).
 */
export default function AiProvidersPage() {
  const { searchParams, setParam } = useUrlSearchState();
  const tab = coerceTab(readStringParam(searchParams, "tab", "llm"));
  const search = readStringParam(searchParams, "search");
  const add = readStringParam(searchParams, "add");
  const panel = findAiProvider(add) ?? null;
  const { rows, loading, presence, unhealthyKeys } = useLlmProviderRows();
  const systemOne = useSystemOneHosts();
  const systemOneReady = systemOne.rows.filter((row) => row.state === "configured").length;
  const openPanel = (providerId: string) => setParam("add", providerId);
  const closePanel = (isOpen: boolean) => {
    if (!isOpen) setParam("add", null);
  };

  return (
    <Tabs
      value={tab}
      onValueChange={(value) =>
        setParam("tab", value, { defaultValue: "llm", reset: ["search", "add"] })
      }
      className="flex flex-1 min-h-0 flex-col gap-3"
    >
      <ConnectPhoneTitle title="AI providers" />
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        <TabsList
          variant="line"
          className="w-full justify-start overflow-x-auto sm:w-fit sm:overflow-visible"
        >
          {TABS.map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value} className="flex-none">
              {entry.label}
              {entry.value === "llm" && rows.length > 0 ? (
                <span className="font-mono text-xs text-muted-foreground">{rows.length}</span>
              ) : null}
              {entry.value === "system-one" && systemOneReady > 0 ? (
                <span className="font-mono text-xs text-muted-foreground">{systemOneReady}</span>
              ) : null}
              {entry.value === "llm" && unhealthyKeys > 0 ? (
                <span
                  role="img"
                  aria-label={`${unhealthyKeys} provider ${unhealthyKeys === 1 ? "key is" : "keys are"} rate limited or failing`}
                  className="size-1.5 rounded-full bg-status-warning"
                />
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        {tab === "llm" ? (
          <div className="flex w-full items-center gap-2 md:ml-auto md:w-auto">
            <ConnectSearch
              placeholder="Search providers and keys"
              className="flex-1 md:flex-none"
            />
            <AddProviderMenu configured={configuredMap(rows, presence)} onPick={openPanel} />
          </div>
        ) : null}
        {tab === "system-one" ? (
          <ConnectSearch placeholder="Search hosts" className="md:ml-auto" />
        ) : null}
        {tab === "embeddings" || tab === "transcription" ? (
          <Button
            type="button"
            className="md:ml-auto"
            onClick={() => openPanel(tab === "embeddings" ? EMBEDDINGS_PANEL : TRANSCRIPTION_PANEL)}
          >
            <ArrowLeftRight />
            Change provider
          </Button>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
        <TabsContent value="llm">
          <LlmList
            rows={matchRows(rows, search)}
            loading={loading}
            searching={search.trim() !== ""}
            onAdd={openPanel}
          />
        </TabsContent>
        <TabsContent value="system-one">
          <SystemOneTab search={search} onSetUp={openPanel} />
        </TabsContent>
        <TabsContent value="embeddings">
          <EmbeddingsTab />
        </TabsContent>
        <TabsContent value="transcription">
          <TranscriptionTab />
        </TabsContent>
      </div>

      <ProviderSetupPanel provider={panel} onOpenChange={closePanel} />
      <EmbeddingsPanel open={add === EMBEDDINGS_PANEL} onOpenChange={closePanel} />
      <TranscriptionPanel open={add === TRANSCRIPTION_PANEL} onOpenChange={closePanel} />
    </Tabs>
  );
}

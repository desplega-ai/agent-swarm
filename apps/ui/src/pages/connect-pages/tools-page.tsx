import { ChevronDown, ChevronUp, Plug, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { useMcpServers } from "@/api/hooks/use-mcp-servers";
import { useOAuthApps, useScriptConnections } from "@/api/hooks/use-script-connections";
import type { OAuthAppSummary, ScriptConnection } from "@/api/types";
import { IntegrationCard } from "@/components/integrations/integration-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { getPresenceKeys, INTEGRATIONS, type IntegrationDef } from "@/lib/integrations-catalog";
import {
  deriveProviderStatus,
  isProviderInUse,
  OAUTH_ONLY_TOOLS,
  OAUTH_PROVIDER_BY_TOOL,
  type ProviderStatus,
  scriptConnectionTerm,
} from "@/lib/provider-status";
import { layoutToolCards } from "@/lib/tools-search";
import { ScriptConnectionsPanel } from "@/pages/connections/page";
import { McpServersPanel } from "@/pages/mcp-servers/page";
import { ConnectPhoneTitle, ConnectSearch } from "./connect-shell";

function catalogDefs(ids: readonly string[]): IntegrationDef[] {
  return ids.flatMap((id) => INTEGRATIONS.filter((def) => def.id === id));
}

/** Code hosts and trackers first, then the OAuth-only mail tools. */
const PRIMARY_TOOLS = [
  ...catalogDefs(["github", "gitlab", "bitbucket", "linear", "jira"]),
  ...OAUTH_ONLY_TOOLS,
];
/** Shown in the grid when in use; the rest waits behind "Show N more". */
const MORE_TOOLS = catalogDefs([
  "attio",
  "sentry",
  "agentmail",
  "composio",
  "serply",
  "gsc",
  "agentfs",
  "business-use",
]);
const ALL_TOOLS = [...PRIMARY_TOOLS, ...MORE_TOOLS];
const PRESENCE_KEYS = Array.from(new Set(ALL_TOOLS.flatMap((def) => getPresenceKeys(def))));

const TABS = [
  { value: "tools", label: "Tools" },
  { value: "connections", label: "Script connections" },
  { value: "oauth-apps", label: "OAuth apps" },
  { value: "mcp", label: "MCP servers" },
] as const;
type ToolsTab = (typeof TABS)[number]["value"];

/** Params one tab sets that mean something else (or nothing) on another tab. */
const TAB_SCOPED_PARAMS = ["new", "search", "kind", "scope", "transport", "name", "url", "preset"];

/** The script connection lists share this filter, so the counts reuse one query. */
const ALL_CONNECTIONS = { kind: "all", scope: "all" } as const;

function coerceTab(value: string): ToolsTab {
  return TABS.some((tab) => tab.value === value) ? (value as ToolsTab) : "tools";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Connect › Tools: provider cards, script connections, OAuth apps and MCP
 * servers behind one tab row (`?tab=`). The tab row also holds the active
 * tab's search and add action, and ends with a link to Settings › Advanced.
 */
export default function ToolsPage() {
  const { searchParams, setParam } = useUrlSearchState();
  const tab = coerceTab(readStringParam(searchParams, "tab", "tools"));
  const search = readStringParam(searchParams, "search");
  const connections = useScriptConnections(ALL_CONNECTIONS);
  const oauthApps = useOAuthApps();
  const mcpServers = useMcpServers();
  const counts: Record<ToolsTab, number | undefined> = {
    tools: ALL_TOOLS.length,
    connections: connections.data?.length,
    "oauth-apps": oauthApps.data?.length,
    mcp: mcpServers.data?.total,
  };

  const tabList = (
    <TabsList variant="line" className="w-full justify-start overflow-x-auto sm:w-fit">
      {TABS.map((entry) => (
        <TabsTrigger key={entry.value} value={entry.value} className="flex-none">
          {entry.label}
          {counts[entry.value] !== undefined ? (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {counts[entry.value]}
            </span>
          ) : null}
        </TabsTrigger>
      ))}
    </TabsList>
  );
  const advanced = (
    <Link
      to="/settings/connection-playground"
      className="shrink-0 rounded-sm px-1 text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      Advanced
    </Link>
  );

  return (
    <Tabs
      value={tab}
      onValueChange={(value) =>
        setParam("tab", value, { defaultValue: "tools", reset: TAB_SCOPED_PARAMS })
      }
      className="flex flex-1 min-h-0 flex-col gap-3"
    >
      <ConnectPhoneTitle title="Tools" />
      {tab === "connections" || tab === "oauth-apps" ? (
        <ScriptConnectionsPanel tab={tab} leading={tabList} trailing={advanced} />
      ) : tab === "mcp" ? (
        <McpServersPanel leading={tabList} trailing={advanced} />
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
            {tabList}
            <div className="flex w-full items-center gap-2 md:ml-auto md:w-auto">
              <ConnectSearch
                placeholder="Search tools"
                className="min-w-0 flex-1 md:w-56 md:flex-none"
              />
              <AddMenu />
              {advanced}
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
            <ToolCardGrid
              search={search}
              oauthApps={oauthApps.data ?? []}
              connectionsLoading={connections.isLoading || oauthApps.isLoading}
              connections={connections.data ?? []}
            />
          </div>
        </>
      )}
    </Tabs>
  );
}

/** On the Tools tab, Add opens each other tab's create flow. */
function AddMenu() {
  const items = [
    { label: "Script connection", to: "?tab=connections&new=connection" },
    { label: "OAuth app", to: "?tab=oauth-apps&new=oauth-app" },
    { label: "MCP server", to: "?tab=mcp&new=1" },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="shrink-0">
          <Plus className="size-4" />
          <span className="max-md:sr-only">Add</span>
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {items.map((item) => (
          <DropdownMenuItem key={item.label} asChild>
            <Link to={item.to}>{item.label}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ToolCardGrid({
  search,
  oauthApps,
  connections,
  connectionsLoading,
}: {
  search: string;
  oauthApps: OAuthAppSummary[];
  connections: ScriptConnection[];
  connectionsLoading: boolean;
}) {
  const { data: configs, isLoading, error } = useConfigs({ scope: "global" });
  const { data: presence } = useEnvPresence(PRESENCE_KEYS);
  const [showMore, setShowMore] = useState(false);

  const statuses = useMemo(() => {
    const inputs = {
      configs: configs ?? [],
      presence: presence ?? {},
      oauthApps,
      scriptConnections: connections,
    };
    return new Map(ALL_TOOLS.map((def) => [def.id, deriveProviderStatus(def, inputs)]));
  }, [configs, presence, oauthApps, connections]);

  if (isLoading || connectionsLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {PRIMARY_TOOLS.slice(0, 3).map((def) => (
          <Skeleton key={def.id} className="h-36" />
        ))}
      </div>
    );
  }

  const statusOf = (def: IntegrationDef) => statuses.get(def.id) as ProviderStatus;
  const { shown, hidden } = layoutToolCards(
    PRIMARY_TOOLS,
    MORE_TOOLS,
    (def) => isProviderInUse(statusOf(def)),
    search,
  );
  const cards = showMore ? [...shown, ...hidden] : shown;

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load configuration: {error instanceof Error ? error.message : String(error)}
          </AlertDescription>
        </Alert>
      ) : null}
      {cards.length === 0 ? (
        <EmptyState icon={Plug} title="No tools match your search" compact />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((def) => (
            <ToolCard key={def.id} def={def} status={statusOf(def)} oauthApps={oauthApps} />
          ))}
        </div>
      )}
      {hidden.length > 0 ? (
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0"
            aria-expanded={showMore}
            onClick={() => setShowMore((open) => !open)}
          >
            {showMore ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {showMore ? "Show fewer" : `Show ${hidden.length} more`}
          </Button>
          {showMore ? null : (
            <span className="min-w-0 truncate">{hidden.map((def) => def.name).join(", ")}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** How the provider is connected, then a link to its script connections. */
function ToolCard({
  def,
  status,
  oauthApps,
}: {
  def: IntegrationDef;
  status: ProviderStatus;
  oauthApps: OAuthAppSummary[];
}) {
  const oauthOnly = OAUTH_ONLY_TOOLS.includes(def);
  const provider = OAUTH_PROVIDER_BY_TOOL[def.id];
  const app = provider ? oauthApps.find((candidate) => candidate.provider === provider) : undefined;
  const inUse = isProviderInUse(status);

  const oauthText =
    status.oauth === "authorized"
      ? status.accounts > 1
        ? `OAuth · ${plural(status.accounts, "account", "accounts")}`
        : "OAuth authorized"
      : status.oauth === "app"
        ? "OAuth app"
        : null;
  const meta =
    oauthText || status.scriptConnections > 0 ? (
      <>
        {oauthText}
        {oauthText && status.scriptConnections > 0 ? " · " : null}
        {status.scriptConnections > 0 ? (
          <Link
            to={`?tab=connections&search=${encodeURIComponent(scriptConnectionTerm(def))}`}
            className="rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {plural(status.scriptConnections, "script connection", "script connections")}
          </Link>
        ) : null}
      </>
    ) : null;

  // OAuth-only cards open their app, or the add dialog with the preset.
  const href = oauthOnly
    ? app
      ? `/integrations/tools/oauth-apps/${encodeURIComponent(app.id)}`
      : `?tab=oauth-apps&new=oauth-app&preset=${provider}`
    : `/integrations/${def.id}`;

  return (
    <IntegrationCard
      def={def}
      status={status.configured}
      connected={status.oauth === "authorized"}
      meta={meta}
      href={href}
      actionLabel={inUse ? "Manage" : "Connect"}
    />
  );
}

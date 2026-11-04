import { Link } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import type { IntegrationCategory } from "@/lib/integrations-catalog";
import { ScriptConnectionsPanel } from "@/pages/connections/page";
import { McpServersPanel } from "@/pages/mcp-servers/page";
import {
  AddIntegrationMenu,
  ConnectPhoneTitle,
  ConnectSearch,
  IntegrationCardGrid,
  integrationsIn,
  matchIntegrations,
} from "./connect-shell";

/** Every catalog category that is not a channel (`comm`) or an AI provider (`llm`). */
const TOOL_CATEGORIES: IntegrationCategory[] = [
  "issues",
  "crm",
  "observability",
  "email",
  "payments",
  "other",
];
const TOOLS = integrationsIn(TOOL_CATEGORIES);

const TABS = [
  { value: "tools", label: "Tools" },
  { value: "connections", label: "Script connections" },
  { value: "oauth-apps", label: "OAuth apps" },
  { value: "mcp", label: "MCP servers" },
] as const;
type ToolsTab = (typeof TABS)[number]["value"];

/** Params one tab sets that mean something else (or nothing) on another tab. */
const TAB_SCOPED_PARAMS = ["new", "search", "kind", "scope", "transport", "name", "url"];

function coerceTab(value: string): ToolsTab {
  return TABS.some((tab) => tab.value === value) ? (value as ToolsTab) : "tools";
}

/**
 * Connect › Tools: integration cards, script connections, OAuth apps and MCP
 * servers behind one tab row (`?tab=`). The tab row also holds the active
 * tab's search and actions, and ends with a link to Settings › Advanced.
 */
export default function ToolsPage() {
  const { searchParams, setParam } = useUrlSearchState();
  const tab = coerceTab(readStringParam(searchParams, "tab", "tools"));
  const search = readStringParam(searchParams, "search");

  const tabList = (
    <TabsList variant="line" className="w-full justify-start overflow-x-auto sm:w-fit">
      {TABS.map((entry) => (
        <TabsTrigger key={entry.value} value={entry.value} className="flex-none">
          {entry.label}
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
              <ConnectSearch placeholder="Search tools" className="flex-1 md:flex-none" />
              <AddIntegrationMenu label="Add tool" defs={TOOLS} />
              {advanced}
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <IntegrationCardGrid defs={matchIntegrations(TOOLS, search)} />
          </div>
        </>
      )}
    </Tabs>
  );
}

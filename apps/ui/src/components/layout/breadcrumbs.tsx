import { ChevronDown, ChevronRight, CornerDownRight, Home } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useAgent } from "@/api/hooks/use-agents";
import { useApprovalRequest } from "@/api/hooks/use-approval-requests";
import { useApp } from "@/api/hooks/use-apps";
import { useMcpServer } from "@/api/hooks/use-mcp-servers";
import { useMetricDefinition } from "@/api/hooks/use-metric-definitions";
import { usePage } from "@/api/hooks/use-pages";
import { useRepo } from "@/api/hooks/use-repos";
import { useScheduledTask } from "@/api/hooks/use-schedules";
import { useScriptConnection } from "@/api/hooks/use-script-connections";
import { useScriptRun } from "@/api/hooks/use-script-runs";
import { useScript } from "@/api/hooks/use-scripts";
import { useSession } from "@/api/hooks/use-sessions";
import { useSkill } from "@/api/hooks/use-skills";
import { useTask } from "@/api/hooks/use-tasks";
import { useUser } from "@/api/hooks/use-users";
import { useWorkflow } from "@/api/hooks/use-workflows";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrentUser } from "@/contexts/current-user-context";
import { INTEGRATIONS } from "@/lib/integrations-catalog";
import { cn, sessionDisplayTitle } from "@/lib/utils";

const routeLabels: Record<string, string> = {
  dashboard: "Dashboard",
  apps: "Apps",
  agents: "Agents",
  tasks: "Tasks",
  sessions: "Sessions",
  chat: "Chat",
  services: "Services",
  schedules: "Schedules",
  workflows: "Workflows",
  "workflow-runs": "Workflow Runs",
  scripts: "Scripts",
  "script-runs": "Script Runs",
  "approval-requests": "Approvals",
  skills: "Skills",
  "mcp-servers": "MCP Servers",
  usage: "Usage",
  budgets: "Budgets",
  memory: "Memory",
  settings: "Settings",
  config: "Config",
  configuration: "Configuration",
  connections: "Connections",
  "oauth-apps": "OAuth Apps",
  secrets: "Secrets",
  repos: "Repos",
  templates: "Templates",
  history: "History",
  debug: "Debug",
  integrations: "Integrations",
  keys: "API Keys",
  "api-keys": "API Keys",
  pages: "Pages",
  people: "People",
  unmapped: "Unmapped",
};

const INTEGRATION_NAME_BY_ID: Record<string, string> = Object.fromEntries(
  INTEGRATIONS.map((def) => [def.id, def.name]),
);

/** Routes that don't have their own list page — redirect breadcrumb to a parent. */
const routeRedirects: Record<string, string> = {
  "workflow-runs": "/workflows",
  "script-runs": "/scripts?tab=runs",
  "oauth-apps": "/connections?tab=oauth-apps",
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Pages use 32-char random-hex IDs (`lower(hex(randomblob(16)))`), not UUIDs.
const HEX32_REGEX = /^[0-9a-f]{32}$/i;

/** Fallback for segments without a routeLabels entry: kebab-case → Title Case
 * ("embed-test" → "Embed Test"). Keeps unknown routes readable without having
 * to register every new path here; routeLabels stays for names automatic
 * casing can't produce ("mcp-servers" → "MCP Servers", "keys" → "API Keys"). */
function humanizeSegment(segment: string): string {
  // Malformed percent escapes ("/%", "/apps/%ZZ") make decodeURIComponent
  // throw — and the header renders OUTSIDE the route error boundary, so an
  // uncaught URIError here would take down the whole shell. Show the raw
  // segment instead.
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  return decoded
    .split("-")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function formatSegment(segment: string, prevSegment?: string): string {
  if (routeLabels[segment]) return routeLabels[segment];
  if (prevSegment === "integrations" && INTEGRATION_NAME_BY_ID[segment]) {
    return INTEGRATION_NAME_BY_ID[segment];
  }
  if (UUID_REGEX.test(segment) || HEX32_REGEX.test(segment)) {
    return `${segment.slice(0, 8)}...`;
  }
  return humanizeSegment(segment);
}

/** True when a path segment looks like an entity id (UUID or 32-char hex). */
function isEntityId(segment: string | undefined): boolean {
  return !!segment && (UUID_REGEX.test(segment) || HEX32_REGEX.test(segment));
}

// Contextual names are NOT length-capped in JS (a 40-char cap ellipsized long
// ago before the header ran out of room — Taras). The trail takes the header's
// free space (flex-1 in AppHeader) and CSS `truncate` clips only when the
// space is actually exhausted; mobile always has the dropdown fallback.

export function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split("/").filter(Boolean);
  // Home shows the greeting in the breadcrumb slot (there is no trail to
  // draw and no in-page h1 anymore). Called before the early return so hook
  // order stays stable across routes.
  const { user } = useCurrentUser();

  // Detail routes (/<parent>/:id[/...]) get a contextual leaf name fetched
  // from the matching single-entity hook instead of the truncated raw id.
  // The id segment is always `segments[1]` under a known `segments[0]`
  // parent. We compute one id-or-empty value per entity type and call every
  // hook unconditionally (empty string → query disabled) so hook order stays
  // stable across renders (React rules of hooks).
  const parent = segments[0];
  const detailId =
    segments.length >= 2 && isEntityId(segments[1]) ? (segments[1] as string) : undefined;
  const idFor = (route: string): string => (parent === route && detailId ? detailId : "");

  // `usePage` / `useUser` / `useSession` accept `string | undefined`; the rest
  // accept `string` and disable themselves on a falsy id. Pass `""` uniformly.
  const pageId = parent === "pages" && detailId ? detailId : undefined;
  const { data: pageMeta } = usePage(pageId);

  const personId = parent === "people" && detailId ? detailId : undefined;
  const { data: personMeta } = useUser(personId);

  const sessionId = parent === "sessions" && detailId ? detailId : undefined;
  const { data: sessionMeta } = useSession(sessionId);

  const { data: appMeta } = useApp(idFor("apps") || undefined);
  const { data: agentMeta } = useAgent(idFor("agents"));
  const { data: taskMeta } = useTask(idFor("tasks"));
  const { data: workflowMeta } = useWorkflow(idFor("workflows"));
  const { data: scheduleMeta } = useScheduledTask(idFor("schedules"));
  const { data: scriptRunMeta } = useScriptRun(idFor("script-runs"));
  const { data: scriptMeta } = useScript(idFor("scripts"));
  const { data: skillMeta } = useSkill(idFor("skills"));
  const { data: mcpServerMeta } = useMcpServer(idFor("mcp-servers"));
  const { data: repoMeta } = useRepo(idFor("repos"));
  const { data: approvalMeta } = useApprovalRequest(idFor("approval-requests"));
  const { data: connectionMeta } = useScriptConnection(idFor("connections") || undefined);

  // `/usage/metrics/:id` — the one detail id at segment index 2. Resolved
  // here (like the index-1 entities above) because `PageHeader` drops string
  // titles: without this the dashboard's name would appear nowhere.
  const metricId =
    parent === "usage" && segments[1] === "metrics" && segments[2] ? segments[2] : undefined;
  const { data: metricMeta } = useMetricDefinition(metricId);

  if (segments.length === 0) {
    return (
      <span className="min-w-0 truncate text-sm font-medium text-foreground">
        {user?.name ? `Welcome back, ${user.name}` : "Welcome to Agent Swarm"}
      </span>
    );
  }

  // Resolve the contextual name for the detail-id segment, if any. Falls back
  // to `undefined` (→ truncated-id display) while the entity is still loading.
  const contextualName: string | undefined = detailId
    ? parent === "apps"
      ? appMeta?.app.name
      : parent === "pages"
        ? pageMeta?.title
        : parent === "people"
          ? personMeta?.name
          : parent === "sessions"
            ? sessionMeta && sessionDisplayTitle(sessionMeta.root)
            : parent === "agents"
              ? agentMeta?.name
              : parent === "tasks"
                ? taskMeta?.task
                : parent === "workflows"
                  ? workflowMeta?.name
                  : parent === "schedules"
                    ? scheduleMeta?.name
                    : parent === "scripts"
                      ? scriptMeta?.name
                      : parent === "script-runs"
                        ? scriptRunMeta?.run.scriptName
                        : parent === "skills"
                          ? skillMeta?.name
                          : parent === "mcp-servers"
                            ? mcpServerMeta?.name
                            : parent === "repos"
                              ? repoMeta?.name
                              : parent === "approval-requests"
                                ? approvalMeta?.title
                                : parent === "connections"
                                  ? connectionMeta?.slug
                                  : undefined
    : undefined;

  // `/apps/:id/p/<page>` — one app page. The literal `p` segment is not a
  // route, so it is dropped from the trail and the page segment renders the
  // page's declared title (falling back to its name).
  const appPageName =
    parent === "apps" && segments[2] === "p" && segments[3] ? segments[3] : undefined;
  const appPageTitle = appPageName
    ? (appMeta?.app.definition.pages?.[appPageName]?.title ?? appPageName)
    : undefined;

  const crumbs = segments
    .map((segment, index) => {
      const defaultPath = `/${segments.slice(0, index + 1).join("/")}`;
      const path = routeRedirects[segment] ?? defaultPath;
      let label = formatSegment(segment, segments[index - 1]);
      // Pretty-print the detail-id leaf with the resolved entity name. Only the
      // id segment at index 1 is replaced — other path segments keep their
      // routeLabels behavior.
      if (index === 1 && segment === detailId && contextualName) {
        label = contextualName.trim();
      }
      if (index === 3 && appPageTitle) {
        label = appPageTitle.trim();
      }
      if (index === 2 && metricId && segment === metricId && metricMeta?.title) {
        label = metricMeta.title.trim();
      }
      const isLast = index === segments.length - 1;

      return { path, label, isLast };
    })
    .filter((_, index) => !(appPageName && index === 2));

  const leaf = crumbs[crumbs.length - 1];

  return (
    <>
      {/* Mobile: the trail collapses into a dropdown. The trigger shows only
          the deepest level (truncated); the menu stacks every level
          top-to-bottom so the hierarchy is still readable on a narrow screen. */}
      <nav className="flex min-w-0 items-center md:hidden" aria-label="Breadcrumb">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm text-foreground font-medium transition-colors hover:bg-accent">
            <span className="truncate">{leaf.label}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-[min(20rem,calc(100vw-2rem))]">
            <DropdownMenuItem asChild>
              <Link to="/" className="flex items-center gap-2">
                <Home className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">Home</span>
              </Link>
            </DropdownMenuItem>
            {crumbs.map((crumb, index) => {
              const content = (
                <>
                  <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{crumb.label}</span>
                </>
              );
              return (
                <DropdownMenuItem
                  key={crumb.path}
                  asChild={!crumb.isLast}
                  // Indent one step per level so the depth reads at a glance.
                  style={{ paddingLeft: `${0.5 + (index + 1) * 0.75}rem` }}
                  // The leaf is the current page: shown for context, not
                  // navigable (Radix `disabled` would grey it out, so it's
                  // just a non-link row that closes the menu).
                  className={cn(crumb.isLast && "font-medium text-foreground")}
                >
                  {crumb.isLast ? (
                    <span className="flex items-center gap-2">{content}</span>
                  ) : (
                    <Link to={crumb.path} className="flex items-center gap-2">
                      {content}
                    </Link>
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>

      {/* Desktop: the full inline trail. */}
      <nav
        className="hidden md:flex items-center gap-1 text-sm text-muted-foreground min-w-0"
        aria-label="Breadcrumb"
      >
        <Link to="/" className="hover:text-foreground transition-colors shrink-0">
          Home
        </Link>
        {crumbs.map((crumb) => (
          <span key={crumb.path} className="flex items-center gap-1 min-w-0">
            <ChevronRight className="size-3 shrink-0" />
            {crumb.isLast ? (
              <span className="text-foreground font-medium truncate">{crumb.label}</span>
            ) : (
              <Link to={crumb.path} className="hover:text-foreground transition-colors truncate">
                {crumb.label}
              </Link>
            )}
          </span>
        ))}
      </nav>
    </>
  );
}

import { ChevronRight } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useAgent } from "@/api/hooks/use-agents";
import { useApprovalRequest } from "@/api/hooks/use-approval-requests";
import { useMcpServer } from "@/api/hooks/use-mcp-servers";
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
import { INTEGRATIONS } from "@/lib/integrations-catalog";

const routeLabels: Record<string, string> = {
  dashboard: "Dashboard",
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

function formatSegment(segment: string, prevSegment?: string): string {
  if (routeLabels[segment]) return routeLabels[segment];
  if (prevSegment === "integrations" && INTEGRATION_NAME_BY_ID[segment]) {
    return INTEGRATION_NAME_BY_ID[segment];
  }
  if (UUID_REGEX.test(segment) || HEX32_REGEX.test(segment)) {
    return `${segment.slice(0, 8)}...`;
  }
  return segment;
}

/** True when a path segment looks like an entity id (UUID or 32-char hex). */
function isEntityId(segment: string | undefined): boolean {
  return !!segment && (UUID_REGEX.test(segment) || HEX32_REGEX.test(segment));
}

/** Cap a contextual breadcrumb name at a safe length, appending an ellipsis. */
const CONTEXTUAL_NAME_MAX = 40;
function capContextualName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= CONTEXTUAL_NAME_MAX) return trimmed;
  return `${trimmed.slice(0, CONTEXTUAL_NAME_MAX)}…`;
}

export function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split("/").filter(Boolean);

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

  if (segments.length === 0) return null;

  // Resolve the contextual name for the detail-id segment, if any. Falls back
  // to `undefined` (→ truncated-id display) while the entity is still loading.
  const contextualName: string | undefined = detailId
    ? parent === "pages"
      ? pageMeta?.title
      : parent === "people"
        ? personMeta?.name
        : parent === "sessions"
          ? sessionMeta?.root.task
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

  const crumbs = segments.map((segment, index) => {
    const defaultPath = `/${segments.slice(0, index + 1).join("/")}`;
    const path = routeRedirects[segment] ?? defaultPath;
    let label = formatSegment(segment, segments[index - 1]);
    // Pretty-print the detail-id leaf with the resolved entity name. Only the
    // id segment at index 1 is replaced — other path segments keep their
    // routeLabels behavior.
    if (index === 1 && segment === detailId && contextualName) {
      label = capContextualName(contextualName);
    }
    const isLast = index === segments.length - 1;

    return { path, label, isLast };
  });

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground min-w-0">
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
  );
}

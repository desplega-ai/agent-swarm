import { ChevronRight } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { usePage } from "@/api/hooks/use-pages";
import { useUser } from "@/api/hooks/use-users";
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
  "approval-requests": "Approvals",
  skills: "Skills",
  "mcp-servers": "MCP Servers",
  usage: "Usage",
  budgets: "Budgets",
  memory: "Memory",
  config: "Config",
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

export function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split("/").filter(Boolean);

  // When we're on /pages/:id, fetch the page so the breadcrumb shows the
  // actual title instead of the truncated hex id. Hook runs unconditionally
  // (passes undefined when not applicable) to keep hook order stable.
  const pageId =
    segments[0] === "pages" && segments[1] && HEX32_REGEX.test(segments[1])
      ? segments[1]
      : undefined;
  const { data: pageMeta } = usePage(pageId);

  // Similarly for /people/:id — render the user's name as the leaf crumb
  // instead of the raw UUID/hex id.
  const personId =
    segments[0] === "people" &&
    segments[1] &&
    (UUID_REGEX.test(segments[1]) || HEX32_REGEX.test(segments[1]))
      ? segments[1]
      : undefined;
  const { data: personMeta } = useUser(personId);

  if (segments.length === 0) return null;

  const crumbs = segments.map((segment, index) => {
    const defaultPath = `/${segments.slice(0, index + 1).join("/")}`;
    const path = routeRedirects[segment] ?? defaultPath;
    let label = formatSegment(segment, segments[index - 1]);
    // Pretty-print the page-detail leaf with the actual title when we have it.
    if (segment === pageId && pageMeta?.title) label = pageMeta.title;
    if (segment === personId && personMeta?.name) label = personMeta.name;
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

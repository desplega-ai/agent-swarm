import { ChevronRight } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

const routeLabels: Record<string, string> = {
  agents: "Agents",
  tasks: "Tasks",
  chat: "Chat",
  services: "Services",
  schedules: "Schedules",
  workflows: "Workflows",
  "workflow-runs": "Workflow Runs",
  "approval-requests": "Approvals",
  skills: "Skills",
  "mcp-servers": "MCP Servers",
  usage: "Usage",
  config: "Config",
  repos: "Repos",
  templates: "Templates",
  history: "History",
  debug: "Debug",
};

/** Routes that don't have their own list page — redirect breadcrumb to a parent. */
const routeRedirects: Record<string, string> = {
  "workflow-runs": "/workflows",
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatSegment(segment: string): string {
  if (routeLabels[segment]) return routeLabels[segment];
  if (UUID_REGEX.test(segment)) return `${segment.slice(0, 8)}...`;
  return segment;
}

export function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split("/").filter(Boolean);

  if (segments.length === 0) return null;

  const crumbs = segments.map((segment, index) => {
    const defaultPath = `/${segments.slice(0, index + 1).join("/")}`;
    const path = routeRedirects[segment] ?? defaultPath;
    const label = formatSegment(segment);
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

import type { SeedManifest } from "../boot/manifest";

export interface Route {
  path: string;
  name: string;
  needs?: "agent" | "task" | "page";
  skip?: string;
  tag?: "@local";
}

export const routes: Route[] = [
  { path: "/", name: "home" },
  { path: "/agents", name: "agents" },
  { path: "/tasks", name: "tasks" },
  { path: "/sessions", name: "sessions" },
  {
    path: "/chat",
    name: "chat",
    skip: "not in the sidebar and calls /api/channels, which the API does not serve",
  },
  { path: "/services", name: "services" },
  { path: "/schedules", name: "schedules" },
  { path: "/workflows", name: "workflows" },
  { path: "/connections", name: "connections" },
  { path: "/scripts", name: "scripts" },
  { path: "/approval-requests", name: "approval-requests" },
  { path: "/usage", name: "usage" },
  { path: "/usage/budgets", name: "usage-budgets" },
  { path: "/usage/metrics", name: "usage-metrics" },
  { path: "/settings/connections", name: "settings-connections" },
  { path: "/settings/appearance", name: "settings-appearance" },
  { path: "/settings/secrets", name: "settings-secrets" },
  { path: "/settings/api-keys", name: "settings-api-keys" },
  { path: "/settings/integrations", name: "settings-integrations" },
  { path: "/settings/configuration", name: "settings-configuration" },
  { path: "/settings/repos", name: "settings-repos" },
  { path: "/settings/debug", name: "settings-debug" },
  { path: "/templates", name: "templates" },
  { path: "/mcp-servers", name: "mcp-servers" },
  { path: "/skills", name: "skills" },
  { path: "/people", name: "people" },
  { path: "/people/unmapped", name: "people-unmapped" },
  { path: "/memory", name: "memory" },
  { path: "/pages", name: "pages" },
  { path: "/apps", name: "apps" },
  { path: "/agents/:id", name: "agents-id", needs: "agent" },
  { path: "/tasks/:id", name: "tasks-id", needs: "task" },
  { path: "/sessions/:rootTaskId", name: "sessions-root-task-id", needs: "task" },
  { path: "/pages/:id", name: "pages-id", needs: "page" },
  { path: "/workflows/:id", name: "workflows-id", skip: "no seed entity yet" },
  { path: "/schedules/:id", name: "schedules-id", skip: "no seed entity yet" },
  { path: "/scripts/:id", name: "scripts-id", skip: "no seed entity yet" },
  { path: "/apps/:id", name: "apps-id", skip: "no seed entity yet" },
  { path: "/skills/:id", name: "skills-id", skip: "no seed entity yet" },
  { path: "/mcp-servers/:id", name: "mcp-servers-id", skip: "no seed entity yet" },
  { path: "/repos/:id", name: "repos-id", skip: "no seed entity yet" },
  { path: "/people/:id", name: "people-id", skip: "no seed entity yet" },
  { path: "/templates/:id", name: "templates-id", skip: "no seed entity yet" },
  {
    path: "/settings/integrations/:id",
    name: "settings-integrations-id",
    skip: "no seed entity yet",
  },
  {
    path: "/approval-requests/:id",
    name: "approval-requests-id",
    skip: "no seed entity yet",
  },
  { path: "/connections/:id", name: "connections-id", skip: "no seed entity yet" },
  {
    path: "/connections/oauth-apps/:id",
    name: "connections-oauth-apps-id",
    skip: "no seed entity yet",
  },
  { path: "/workflow-runs/:id", name: "workflow-runs-id", skip: "no seed entity yet" },
  { path: "/script-runs/:id", name: "script-runs-id", skip: "no seed entity yet" },
  { path: "/usage/metrics/:id", name: "usage-metrics-id", skip: "no seed entity yet" },
];

export function resolveRoute(route: Route, seed: SeedManifest): string {
  if (!route.needs) return route.path;
  const id =
    route.needs === "agent"
      ? seed.agents.workerA
      : route.needs === "task"
        ? seed.tasks.inProgress
        : seed.pages.public.id;
  return route.path.replace(/:[^/]+/, id);
}

import { lazy } from "react";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router-dom";
import { RootLayout } from "@/components/layout/root-layout";
import { SettingsLayout } from "@/pages/settings/settings-layout";
import { UsageLayout } from "@/pages/usage/usage-layout";
import { RouteRedirect } from "./route-redirect";

const DashboardPage = lazy(() => import("@/pages/dashboard/page"));
const HomePage = lazy(() => import("@/pages/home/page"));
const UnifiedHome = lazy(() => import("@/pages/home/unified-home"));
const AgentsPage = lazy(() => import("@/pages/agents/page"));
const AgentDetailPage = lazy(() => import("@/pages/agents/[id]/page"));
const TasksPage = lazy(() => import("@/pages/tasks/page"));
const TaskDetailPage = lazy(() => import("@/pages/tasks/[id]/page"));
const SessionsPage = lazy(() => import("@/pages/sessions/page"));
const SessionDetailPage = lazy(() => import("@/pages/sessions/[rootTaskId]/page"));
const ChatPage = lazy(() => import("@/pages/chat/page"));
const ServicesPage = lazy(() => import("@/pages/services/page"));
const SchedulesPage = lazy(() => import("@/pages/schedules/page"));
const ScheduleDetailPage = lazy(() => import("@/pages/schedules/[id]/page"));
const UsageContent = lazy(() =>
  import("@/pages/usage/usage-content").then((m) => ({ default: m.UsageContent })),
);
const BudgetsPage = lazy(() => import("@/pages/budgets/page"));
const ConnectionsPage = lazy(() => import("@/pages/settings/connections-page"));
const SecretsPage = lazy(() => import("@/pages/settings/secrets-page"));
const IntegrationsPage = lazy(() => import("@/pages/integrations/page"));
const IntegrationDetailPage = lazy(() => import("@/pages/integrations/[id]/page"));
const ReposPage = lazy(() => import("@/pages/repos/page"));
const RepoDetailPage = lazy(() => import("@/pages/repos/[id]/page"));
const WorkflowsPage = lazy(() => import("@/pages/workflows/page"));
const WorkflowDetailPage = lazy(() => import("@/pages/workflows/[id]/page"));
const WorkflowRunDetailPage = lazy(() => import("@/pages/workflow-runs/[id]/page"));
const ScriptConnectionsPage = lazy(() => import("@/pages/connections/page"));
const ScriptConnectionDetailPage = lazy(() => import("@/pages/connections/[id]/page"));
const OAuthAppDetailPage = lazy(() => import("@/pages/connections/oauth-apps/[provider]/page"));
const ScriptsPage = lazy(() => import("@/pages/scripts/page"));
const ScriptDetailPage = lazy(() => import("@/pages/scripts/[id]/page"));
const ScriptRunDetailPage = lazy(() => import("@/pages/script-runs/[id]/page"));
const TemplatesPage = lazy(() => import("@/pages/templates/page"));
const TemplateDetailPage = lazy(() => import("@/pages/templates/[id]/page"));
const TemplateVersionDetailPage = lazy(
  () => import("@/pages/templates/[id]/history/[version]/page"),
);
const ApprovalRequestsPage = lazy(() => import("@/pages/approval-requests/page"));
const ApprovalRequestDetailPage = lazy(() => import("@/pages/approval-requests/[id]/page"));
const McpServersPage = lazy(() => import("@/pages/mcp-servers/page"));
const McpServerDetailPage = lazy(() => import("@/pages/mcp-servers/[id]/page"));
const SkillsPage = lazy(() => import("@/pages/skills/page"));
const SkillDetailPage = lazy(() => import("@/pages/skills/[id]/page"));
const ApiKeysPage = lazy(() => import("@/pages/api-keys/page"));
const PeoplePage = lazy(() => import("@/pages/people/page"));
const PersonDetailPage = lazy(() => import("@/pages/people/[id]/page"));
const DebugPage = lazy(() => import("@/pages/debug/page"));
const MemoryPage = lazy(() => import("@/pages/memory/page"));
const MetricsPage = lazy(() => import("@/pages/metrics/page"));
const PageDetailPage = lazy(() => import("@/pages/pages/[id]/page"));
const PagesListingPage = lazy(() => import("@/pages/pages/page"));
const NotFoundPage = lazy(() => import("@/pages/not-found/page"));

/**
 * Backward-compat redirect table — every old top-level URL that moved during
 * the sidebar-trim IA rework maps to its new location, so no old link 404s.
 * Simple (non-param) redirects live here; the param-aware `/integrations/:id`
 * case is handled separately via `RouteRedirect` below.
 */
const REDIRECTS: Record<string, string> = {
  dashboard: "/",
  budgets: "/usage/budgets",
  config: "/settings/connections",
  keys: "/settings/api-keys",
  integrations: "/settings/integrations",
  repos: "/settings/repos",
  debug: "/settings/debug",
  metrics: "/usage/metrics",
  // The standalone script-runs list folded into the Scripts page's Runs tab.
  "script-runs": "/scripts?tab=runs",
};

const redirectRoutes: RouteObject[] = [
  ...Object.entries(REDIRECTS).map(([from, to]) => ({
    path: from,
    element: <Navigate to={to} replace />,
  })),
  {
    path: "integrations/:id",
    element: <RouteRedirect to={({ id }) => `/settings/integrations/${id}`} />,
  },
];

export const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    children: [
      { index: true, element: <UnifiedHome /> },
      { path: "old-home", element: <HomePage /> },
      { path: "old-dashboard", element: <DashboardPage /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "agents/:id", element: <AgentDetailPage /> },
      { path: "tasks", element: <TasksPage /> },
      { path: "tasks/:id", element: <TaskDetailPage /> },
      { path: "sessions", element: <SessionsPage /> },
      { path: "sessions/:rootTaskId", element: <SessionDetailPage /> },
      { path: "chat", element: <ChatPage /> },
      { path: "chat/:channelId", element: <ChatPage /> },
      { path: "services", element: <ServicesPage /> },
      { path: "schedules", element: <SchedulesPage /> },
      { path: "schedules/:id", element: <ScheduleDetailPage /> },
      { path: "workflows", element: <WorkflowsPage /> },
      { path: "workflows/:id", element: <WorkflowDetailPage /> },
      { path: "workflow-runs/:id", element: <WorkflowRunDetailPage /> },
      { path: "connections", element: <ScriptConnectionsPage /> },
      { path: "connections/oauth-apps/:provider", element: <OAuthAppDetailPage /> },
      { path: "connections/:id", element: <ScriptConnectionDetailPage /> },
      { path: "scripts", element: <ScriptsPage /> },
      { path: "scripts/:id", element: <ScriptDetailPage /> },
      { path: "script-runs/:id", element: <ScriptRunDetailPage /> },
      { path: "approval-requests", element: <ApprovalRequestsPage /> },
      { path: "approval-requests/:id", element: <ApprovalRequestDetailPage /> },
      {
        path: "usage",
        element: <UsageLayout />,
        children: [
          { index: true, element: <UsageContent /> },
          { path: "budgets", element: <BudgetsPage /> },
          { path: "metrics", element: <MetricsPage /> },
          { path: "metrics/:id", element: <MetricsPage /> },
        ],
      },
      {
        path: "settings",
        element: <SettingsLayout />,
        children: [
          { index: true, element: <Navigate to="/settings/connections" replace /> },
          { path: "config", element: <Navigate to="/settings/connections" replace /> },
          { path: "connections", element: <ConnectionsPage /> },
          { path: "secrets", element: <SecretsPage /> },
          { path: "api-keys", element: <ApiKeysPage /> },
          { path: "integrations", element: <IntegrationsPage /> },
          { path: "integrations/:id", element: <IntegrationDetailPage /> },
          { path: "repos", element: <ReposPage /> },
          { path: "debug", element: <DebugPage /> },
        ],
      },
      { path: "templates", element: <TemplatesPage /> },
      { path: "templates/:id", element: <TemplateDetailPage /> },
      { path: "templates/:id/history/:version", element: <TemplateVersionDetailPage /> },
      { path: "mcp-servers", element: <McpServersPage /> },
      { path: "mcp-servers/:id", element: <McpServerDetailPage /> },
      { path: "skills", element: <SkillsPage /> },
      { path: "skills/:id", element: <SkillDetailPage /> },
      { path: "repos/:id", element: <RepoDetailPage /> },
      { path: "people", element: <PeoplePage /> },
      { path: "people/unmapped", element: <PeoplePage /> },
      { path: "people/:id", element: <PersonDetailPage /> },
      { path: "memory", element: <MemoryPage /> },
      { path: "pages", element: <PagesListingPage /> },
      { path: "pages/:id", element: <PageDetailPage /> },
      ...redirectRoutes,
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

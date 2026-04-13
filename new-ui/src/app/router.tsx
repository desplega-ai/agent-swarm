import { lazy } from "react";
import { createBrowserRouter } from "react-router-dom";
import { RootLayout } from "@/components/layout/root-layout";

const DashboardPage = lazy(() => import("@/pages/dashboard/page"));
const AgentsPage = lazy(() => import("@/pages/agents/page"));
const AgentDetailPage = lazy(() => import("@/pages/agents/[id]/page"));
const TasksPage = lazy(() => import("@/pages/tasks/page"));
const TaskDetailPage = lazy(() => import("@/pages/tasks/[id]/page"));
const ChatPage = lazy(() => import("@/pages/chat/page"));
const ServicesPage = lazy(() => import("@/pages/services/page"));
const SchedulesPage = lazy(() => import("@/pages/schedules/page"));
const ScheduleDetailPage = lazy(() => import("@/pages/schedules/[id]/page"));
const UsagePage = lazy(() => import("@/pages/usage/page"));
const ConfigPage = lazy(() => import("@/pages/config/page"));
const ReposPage = lazy(() => import("@/pages/repos/page"));
const RepoDetailPage = lazy(() => import("@/pages/repos/[id]/page"));
const WorkflowsPage = lazy(() => import("@/pages/workflows/page"));
const WorkflowDetailPage = lazy(() => import("@/pages/workflows/[id]/page"));
const WorkflowRunDetailPage = lazy(() => import("@/pages/workflow-runs/[id]/page"));
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
const DebugPage = lazy(() => import("@/pages/debug/page"));
const NotFoundPage = lazy(() => import("@/pages/not-found/page"));

export const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "agents/:id", element: <AgentDetailPage /> },
      { path: "tasks", element: <TasksPage /> },
      { path: "tasks/:id", element: <TaskDetailPage /> },
      { path: "chat", element: <ChatPage /> },
      { path: "chat/:channelId", element: <ChatPage /> },
      { path: "services", element: <ServicesPage /> },
      { path: "schedules", element: <SchedulesPage /> },
      { path: "schedules/:id", element: <ScheduleDetailPage /> },
      { path: "workflows", element: <WorkflowsPage /> },
      { path: "workflows/:id", element: <WorkflowDetailPage /> },
      { path: "workflow-runs/:id", element: <WorkflowRunDetailPage /> },
      { path: "approval-requests", element: <ApprovalRequestsPage /> },
      { path: "approval-requests/:id", element: <ApprovalRequestDetailPage /> },
      { path: "usage", element: <UsagePage /> },
      { path: "config", element: <ConfigPage /> },
      { path: "templates", element: <TemplatesPage /> },
      { path: "templates/:id", element: <TemplateDetailPage /> },
      { path: "templates/:id/history/:version", element: <TemplateVersionDetailPage /> },
      { path: "mcp-servers", element: <McpServersPage /> },
      { path: "mcp-servers/:id", element: <McpServerDetailPage /> },
      { path: "skills", element: <SkillsPage /> },
      { path: "skills/:id", element: <SkillDetailPage /> },
      { path: "repos", element: <ReposPage /> },
      { path: "repos/:id", element: <RepoDetailPage /> },
      { path: "keys", element: <ApiKeysPage /> },
      { path: "debug", element: <DebugPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

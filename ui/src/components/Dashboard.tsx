import { useState, useEffect, useCallback } from "react";
import Box from "@mui/joy/Box";
import Tabs from "@mui/joy/Tabs";
import TabList from "@mui/joy/TabList";
import Tab from "@mui/joy/Tab";
import TabPanel from "@mui/joy/TabPanel";
import { useColorScheme } from "@mui/joy/styles";
import Header from "./Header";
import StatsBar from "./StatsBar";
import AgentsPanel from "./AgentsPanel";
import TasksPanel from "./TasksPanel";
import ActivityFeed from "./ActivityFeed";
import AgentDetailPanel from "./AgentDetailPanel";
import TaskDetailPanel from "./TaskDetailPanel";
import ChatPanel from "./ChatPanel";
import type { TaskStatus } from "../types/api";

interface DashboardProps {
  onSettingsClick: () => void;
}

function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    tab: params.get("tab") as "agents" | "tasks" | "chat" | null,
    agent: params.get("agent"),
    task: params.get("task"),
    channel: params.get("channel"),
    thread: params.get("thread"),
    agentStatus: params.get("agentStatus") as "all" | "busy" | "idle" | "offline" | null,
    taskStatus: params.get("taskStatus") as TaskStatus | "all" | null,
    expand: params.get("expand") === "true",
  };
}

function updateUrl(params: {
  tab?: string;
  agent?: string | null;
  task?: string | null;
  channel?: string | null;
  thread?: string | null;
  agentStatus?: string | null;
  taskStatus?: string | null;
  expand?: boolean;
}) {
  const url = new URL(window.location.href);

  if (params.tab) {
    url.searchParams.set("tab", params.tab);
  }

  if (params.agent) {
    url.searchParams.set("agent", params.agent);
    url.searchParams.delete("task");
  } else if (params.agent === null) {
    url.searchParams.delete("agent");
    url.searchParams.delete("expand");
  }

  if (params.task) {
    url.searchParams.set("task", params.task);
    url.searchParams.delete("agent");
  } else if (params.task === null) {
    url.searchParams.delete("task");
    url.searchParams.delete("expand");
  }

  if (params.channel) {
    url.searchParams.set("channel", params.channel);
  } else if (params.channel === null) {
    url.searchParams.delete("channel");
    url.searchParams.delete("thread");
  }

  if (params.thread) {
    url.searchParams.set("thread", params.thread);
  } else if (params.thread === null) {
    url.searchParams.delete("thread");
  }

  if (params.agentStatus && params.agentStatus !== "all") {
    url.searchParams.set("agentStatus", params.agentStatus);
  } else if (params.agentStatus === "all" || params.agentStatus === null) {
    url.searchParams.delete("agentStatus");
  }

  if (params.taskStatus && params.taskStatus !== "all") {
    url.searchParams.set("taskStatus", params.taskStatus);
  } else if (params.taskStatus === "all" || params.taskStatus === null) {
    url.searchParams.delete("taskStatus");
  }

  if (params.expand === true) {
    url.searchParams.set("expand", "true");
  } else if (params.expand === false) {
    url.searchParams.delete("expand");
  }

  window.history.replaceState({}, "", url.toString());
}

export default function Dashboard({ onSettingsClick }: DashboardProps) {
  const [activeTab, setActiveTab] = useState<"agents" | "tasks" | "chat">("agents");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [preFilterAgentId, setPreFilterAgentId] = useState<string | undefined>(undefined);
  const [agentStatusFilter, setAgentStatusFilter] = useState<"all" | "busy" | "idle" | "offline">("all");
  const [taskStatusFilter, setTaskStatusFilter] = useState<TaskStatus | "all">("all");
  const [expandDetail, setExpandDetail] = useState(false);

  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    hoverBg: isDark ? "rgba(245, 166, 35, 0.08)" : "rgba(212, 136, 6, 0.08)",
  };

  // Read URL params on mount
  useEffect(() => {
    const params = getUrlParams();
    if (params.tab === "tasks") {
      setActiveTab("tasks");
      if (params.task) {
        setSelectedTaskId(params.task);
      }
      if (params.taskStatus) {
        setTaskStatusFilter(params.taskStatus);
      }
    } else if (params.tab === "chat") {
      setActiveTab("chat");
      if (params.channel) {
        setSelectedChannelId(params.channel);
      }
      if (params.thread) {
        setSelectedThreadId(params.thread);
      }
    } else {
      setActiveTab("agents");
      if (params.agent) {
        setSelectedAgentId(params.agent);
      }
      if (params.agentStatus) {
        setAgentStatusFilter(params.agentStatus);
      }
    }
    if (params.expand) {
      setExpandDetail(true);
    }
  }, []);

  // Update URL when agent selection changes
  const handleSelectAgent = useCallback((agentId: string | null) => {
    setSelectedAgentId(agentId);
    // Reset expand when selecting a new agent or deselecting
    setExpandDetail(false);
    updateUrl({ tab: "agents", agent: agentId, expand: false });
  }, []);

  // Update URL when task selection changes
  const handleSelectTask = useCallback((taskId: string | null) => {
    setSelectedTaskId(taskId);
    // Reset expand when selecting a new task or deselecting
    setExpandDetail(false);
    updateUrl({ tab: "tasks", task: taskId, expand: false });
  }, []);

  // Toggle expand state
  const handleToggleExpand = useCallback(() => {
    setExpandDetail((prev) => {
      const newValue = !prev;
      updateUrl({ expand: newValue });
      return newValue;
    });
  }, []);

  const handleGoToTasks = () => {
    if (selectedAgentId) {
      setPreFilterAgentId(selectedAgentId);
    }
    setSelectedAgentId(null);
    setExpandDetail(false);
    setActiveTab("tasks");
    updateUrl({ tab: "tasks", agent: null, expand: false });
  };

  const handleTabChange = (_: unknown, value: string | number | null) => {
    const tab = value as "agents" | "tasks" | "chat";
    setActiveTab(tab);
    // Clear selections, filters, and expand when switching tabs
    setExpandDetail(false);
    if (tab === "agents") {
      setSelectedTaskId(null);
      setPreFilterAgentId(undefined);
      setTaskStatusFilter("all");
      updateUrl({ tab: "agents", task: null, taskStatus: null, expand: false });
    } else if (tab === "tasks") {
      setSelectedAgentId(null);
      setAgentStatusFilter("all");
      updateUrl({ tab: "tasks", agent: null, agentStatus: null, expand: false });
    } else {
      // chat tab
      setSelectedAgentId(null);
      setSelectedTaskId(null);
      setPreFilterAgentId(undefined);
      setAgentStatusFilter("all");
      setTaskStatusFilter("all");
      updateUrl({ tab: "chat", agent: null, task: null, agentStatus: null, taskStatus: null, expand: false });
    }
  };

  // Navigation handlers for ActivityFeed
  const handleNavigateToAgent = useCallback((agentId: string) => {
    setActiveTab("agents");
    setSelectedAgentId(agentId);
    setSelectedTaskId(null);
    setPreFilterAgentId(undefined);
    setExpandDetail(false);
    updateUrl({ tab: "agents", agent: agentId, expand: false });
  }, []);

  const handleNavigateToTask = useCallback((taskId: string) => {
    setActiveTab("tasks");
    setSelectedTaskId(taskId);
    setSelectedAgentId(null);
    setExpandDetail(false);
    updateUrl({ tab: "tasks", task: taskId, expand: false });
  }, []);

  const handleNavigateToChat = useCallback((channelId: string, messageId?: string) => {
    setActiveTab("chat");
    setSelectedChannelId(channelId);
    setSelectedThreadId(messageId || null);
    setSelectedAgentId(null);
    setSelectedTaskId(null);
    setExpandDetail(false);
    updateUrl({ tab: "chat", channel: channelId, thread: messageId || null, agent: null, task: null, expand: false });
  }, []);

  // Chat handlers
  const handleSelectChannel = useCallback((channelId: string | null) => {
    setSelectedChannelId(channelId);
    setSelectedThreadId(null);
    updateUrl({ channel: channelId, thread: null });
  }, []);

  const handleSelectThread = useCallback((threadId: string | null) => {
    setSelectedThreadId(threadId);
    updateUrl({ thread: threadId });
  }, []);

  // Filter change handlers with URL updates
  const handleAgentStatusFilterChange = useCallback((status: "all" | "busy" | "idle" | "offline") => {
    setAgentStatusFilter(status);
    updateUrl({ agentStatus: status });
  }, []);

  const handleTaskStatusFilterChange = useCallback((status: TaskStatus | "all") => {
    setTaskStatusFilter(status);
    updateUrl({ taskStatus: status });
  }, []);

  // StatsBar handlers
  const handleFilterAgents = useCallback((status: "all" | "busy" | "idle") => {
    setAgentStatusFilter(status);
    setActiveTab("agents");
    updateUrl({ tab: "agents", agentStatus: status });
  }, []);

  const handleNavigateToTasksWithFilter = useCallback((status?: TaskStatus) => {
    setActiveTab("tasks");
    setTaskStatusFilter(status || "all");
    setSelectedAgentId(null);
    setPreFilterAgentId(undefined);
    updateUrl({ tab: "tasks", agent: null, taskStatus: status || "all" });
  }, []);

  return (
    <Box
      className="honeycomb-bg"
      sx={{
        height: "100vh",
        bgcolor: "background.body",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Header onSettingsClick={onSettingsClick} />

      {/* Tabs */}
      <Box sx={{ px: 3, pt: 2, pb: 3, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <Tabs
          value={activeTab}
          onChange={handleTabChange}
          sx={{
            bgcolor: "transparent",
            "--Tabs-gap": "0px",
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <TabList
            sx={{
              gap: 0.5,
              bgcolor: "transparent",
              borderBottom: "1px solid",
              borderColor: "neutral.outlinedBorder",
              "& .MuiTab-root": {
                fontFamily: "code",
                fontSize: "0.8rem",
                letterSpacing: "0.03em",
                fontWeight: 600,
                color: "text.tertiary",
                bgcolor: "transparent",
                border: "1px solid transparent",
                borderBottom: "none",
                borderRadius: "6px 6px 0 0",
                px: 3,
                py: 1,
                transition: "all 0.2s ease",
                "&:hover": {
                  color: "text.secondary",
                  bgcolor: colors.hoverBg,
                },
                "&.Mui-selected": {
                  color: colors.amber,
                  bgcolor: "background.surface",
                  borderColor: "neutral.outlinedBorder",
                  borderBottomColor: "background.surface",
                  marginBottom: "-1px",
                },
              },
            }}
          >
            <Tab value="agents">AGENTS</Tab>
            <Tab value="tasks">TASKS</Tab>
            <Tab value="chat">CHAT</Tab>
          </TabList>

          {/* Agents Tab */}
          <TabPanel
            value="agents"
            sx={{
              p: 0,
              pt: 2,
              flex: 1,
              minHeight: 0,
              "&[hidden]": {
                display: "none",
              },
            }}
          >
            <Box
              sx={{
                height: "100%",
                display: "flex",
                gap: 3,
              }}
            >
              {/* Main Content - hidden when expanded */}
              {!(selectedAgentId && expandDetail) && (
                <Box sx={{ flex: 1, display: "flex", gap: 3, minWidth: 0 }}>
                  {/* Agents Panel */}
                  <Box sx={{ flex: 2, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                    <StatsBar
                      onFilterAgents={handleFilterAgents}
                      onNavigateToTasks={handleNavigateToTasksWithFilter}
                    />
                    <AgentsPanel
                      selectedAgentId={selectedAgentId}
                      onSelectAgent={handleSelectAgent}
                      statusFilter={agentStatusFilter}
                      onStatusFilterChange={handleAgentStatusFilterChange}
                    />
                  </Box>

                  {/* Activity Feed */}
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <ActivityFeed
                      onNavigateToAgent={handleNavigateToAgent}
                      onNavigateToTask={handleNavigateToTask}
                      onNavigateToChat={handleNavigateToChat}
                    />
                  </Box>
                </Box>
              )}

              {/* Agent Detail Panel */}
              {selectedAgentId && (
                <AgentDetailPanel
                  agentId={selectedAgentId}
                  onClose={() => handleSelectAgent(null)}
                  onGoToTasks={handleGoToTasks}
                  expanded={expandDetail}
                  onToggleExpand={handleToggleExpand}
                />
              )}
            </Box>
          </TabPanel>

          {/* Tasks Tab */}
          <TabPanel
            value="tasks"
            sx={{
              p: 0,
              pt: 2,
              flex: 1,
              minHeight: 0,
              "&[hidden]": {
                display: "none",
              },
            }}
          >
            <Box
              sx={{
                height: "100%",
                display: "flex",
                gap: 3,
              }}
            >
              {/* Tasks Panel - hidden when expanded */}
              {!(selectedTaskId && expandDetail) && (
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <TasksPanel
                    selectedTaskId={selectedTaskId}
                    onSelectTask={handleSelectTask}
                    preFilterAgentId={preFilterAgentId}
                    statusFilter={taskStatusFilter}
                    onStatusFilterChange={handleTaskStatusFilterChange}
                  />
                </Box>
              )}

              {/* Task Detail Panel */}
              {selectedTaskId && (
                <TaskDetailPanel
                  taskId={selectedTaskId}
                  onClose={() => handleSelectTask(null)}
                  expanded={expandDetail}
                  onToggleExpand={handleToggleExpand}
                />
              )}
            </Box>
          </TabPanel>

          {/* Chat Tab */}
          <TabPanel
            value="chat"
            sx={{
              p: 0,
              pt: 2,
              flex: 1,
              minHeight: 0,
              "&[hidden]": {
                display: "none",
              },
            }}
          >
            <ChatPanel
              selectedChannelId={selectedChannelId}
              selectedThreadId={selectedThreadId}
              onSelectChannel={handleSelectChannel}
              onSelectThread={handleSelectThread}
              onNavigateToAgent={handleNavigateToAgent}
            />
          </TabPanel>
        </Tabs>
      </Box>
    </Box>
  );
}

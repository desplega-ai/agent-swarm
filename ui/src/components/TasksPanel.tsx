import { useState, useMemo } from "react";
import Box from "@mui/joy/Box";
import Card from "@mui/joy/Card";
import Typography from "@mui/joy/Typography";
import Table from "@mui/joy/Table";
import Select from "@mui/joy/Select";
import Option from "@mui/joy/Option";
import Input from "@mui/joy/Input";
import Chip from "@mui/joy/Chip";
import { useColorScheme } from "@mui/joy/styles";
import { useTasks, useAgents } from "../hooks/queries";
import StatusBadge from "./StatusBadge";
import type { TaskStatus, AgentTask } from "../types/api";

interface TasksPanelProps {
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  preFilterAgentId?: string;
  statusFilter?: TaskStatus | "all";
  onStatusFilterChange?: (status: TaskStatus | "all") => void;
}

function getElapsedTime(task: AgentTask): string {
  const start = new Date(task.createdAt).getTime();
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
  const elapsed = end - start;

  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatSmartTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);

  // Less than 6 hours: relative time
  if (diffHours < 6) {
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    return `${diffHours}h ago`;
  }

  // Same day: time only
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Before today: full date
  return date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function TasksPanel({
  selectedTaskId,
  onSelectTask,
  preFilterAgentId,
  statusFilter: controlledStatusFilter,
  onStatusFilterChange,
}: TasksPanelProps) {
  const [internalStatusFilter, setInternalStatusFilter] = useState<TaskStatus | "all">("all");
  const [agentFilter, setAgentFilter] = useState<string | "all">(preFilterAgentId || "all");
  const [searchQuery, setSearchQuery] = useState("");

  // Use controlled or internal state
  const statusFilter = controlledStatusFilter ?? internalStatusFilter;
  const setStatusFilter = onStatusFilterChange ?? setInternalStatusFilter;

  const { mode } = useColorScheme();
  const isDark = mode === "dark";
  const { data: agents } = useAgents();

  const colors = {
    gold: isDark ? "#D4A574" : "#8B6914",
    goldGlow: isDark ? "0 0 8px rgba(212, 165, 116, 0.5)" : "0 0 6px rgba(139, 105, 20, 0.3)",
    amber: isDark ? "#F5A623" : "#D48806",
    amberGlow: isDark ? "0 0 10px rgba(245, 166, 35, 0.2)" : "0 0 8px rgba(212, 136, 6, 0.15)",
    hoverBg: isDark ? "rgba(245, 166, 35, 0.03)" : "rgba(212, 136, 6, 0.03)",
    hoverBorder: isDark ? "#4A3A2F" : "#D1C5B4",
  };

  // Build filters for API call
  const filters = useMemo(() => {
    const f: { status?: string; agentId?: string; search?: string } = {};
    if (statusFilter !== "all") f.status = statusFilter;
    if (agentFilter !== "all") f.agentId = agentFilter;
    if (searchQuery.trim()) f.search = searchQuery.trim();
    return Object.keys(f).length > 0 ? f : undefined;
  }, [statusFilter, agentFilter, searchQuery]);

  const { data: tasks, isLoading } = useTasks(filters);

  // Create agent lookup
  const agentMap = useMemo(() => {
    const map = new Map<string, string>();
    agents?.forEach((a) => map.set(a.id, a.name));
    return map;
  }, [agents]);

  return (
    <Card
      variant="outlined"
      className="card-hover"
      sx={{
        p: 0,
        overflow: "hidden",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.surface",
        borderColor: "neutral.outlinedBorder",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 2,
          py: 1.5,
          borderBottom: "1px solid",
          borderColor: "neutral.outlinedBorder",
          bgcolor: "background.level1",
          flexWrap: "wrap",
          gap: 1.5,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {/* Hex accent */}
          <Box
            sx={{
              width: 8,
              height: 10,
              clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
              bgcolor: colors.gold,
              boxShadow: colors.goldGlow,
            }}
          />
          <Typography
            level="title-md"
            sx={{
              fontFamily: "display",
              fontWeight: 600,
              color: colors.gold,
              letterSpacing: "0.03em",
            }}
          >
            TASKS
          </Typography>
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.7rem",
              color: "text.tertiary",
            }}
          >
            ({tasks?.length || 0})
          </Typography>
        </Box>

        {/* Filters */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          {/* Search */}
          <Input
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            size="sm"
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              minWidth: 180,
              bgcolor: "background.surface",
              borderColor: "neutral.outlinedBorder",
              color: "text.primary",
              "&:hover": {
                borderColor: colors.hoverBorder,
              },
              "&:focus-within": {
                borderColor: colors.amber,
                boxShadow: colors.amberGlow,
              },
            }}
          />

          {/* Agent Filter */}
          <Select
            value={agentFilter}
            onChange={(_, value) => setAgentFilter(value as string)}
            size="sm"
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              minWidth: 130,
              bgcolor: "background.surface",
              borderColor: "neutral.outlinedBorder",
              color: "text.secondary",
              "&:hover": {
                borderColor: colors.amber,
              },
              "& .MuiSelect-indicator": {
                color: "text.tertiary",
              },
            }}
          >
            <Option value="all">ALL AGENTS</Option>
            {agents?.map((agent) => (
              <Option key={agent.id} value={agent.id}>
                {agent.name}
              </Option>
            ))}
          </Select>

          {/* Status Filter */}
          <Select
            value={statusFilter}
            onChange={(_, value) => setStatusFilter(value as TaskStatus | "all")}
            size="sm"
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              minWidth: 120,
              bgcolor: "background.surface",
              borderColor: "neutral.outlinedBorder",
              color: "text.secondary",
              "&:hover": {
                borderColor: colors.amber,
              },
              "& .MuiSelect-indicator": {
                color: "text.tertiary",
              },
            }}
          >
            <Option value="all">ALL STATUS</Option>
            <Option value="unassigned">UNASSIGNED</Option>
            <Option value="offered">OFFERED</Option>
            <Option value="pending">PENDING</Option>
            <Option value="in_progress">IN PROGRESS</Option>
            <Option value="completed">COMPLETED</Option>
            <Option value="failed">FAILED</Option>
          </Select>
        </Box>
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: "auto" }}>
        {isLoading ? (
          <Box sx={{ p: 3, textAlign: "center" }}>
            <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
              Loading tasks...
            </Typography>
          </Box>
        ) : !tasks || tasks.length === 0 ? (
          <Box sx={{ p: 3, textAlign: "center" }}>
            <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
              No tasks found
            </Typography>
          </Box>
        ) : (
          <Table
            size="sm"
            sx={{
              "--TableCell-paddingY": "10px",
              "--TableCell-paddingX": "12px",
              "--TableCell-borderColor": "var(--joy-palette-neutral-outlinedBorder)",
              tableLayout: "fixed",
              width: "100%",
              "& thead th": {
                bgcolor: "background.surface",
                fontFamily: "code",
                fontSize: "0.7rem",
                letterSpacing: "0.05em",
                color: "text.tertiary",
                borderBottom: "1px solid",
                borderColor: "neutral.outlinedBorder",
                position: "sticky",
                top: 0,
                zIndex: 1,
              },
              "& tbody tr": {
                transition: "background-color 0.2s ease",
                cursor: "pointer",
              },
              "& tbody tr:hover": {
                bgcolor: colors.hoverBg,
              },
            }}
          >
            <thead>
              <tr>
                <th style={{ width: "30%" }}>TASK</th>
                <th style={{ width: "10%" }}>AGENT</th>
                <th style={{ width: "8%" }}>TYPE</th>
                <th style={{ width: "12%" }}>TAGS</th>
                <th style={{ width: "10%" }}>STATUS</th>
                <th style={{ width: "12%" }}>PROGRESS</th>
                <th style={{ width: "8%" }}>ELAPSED</th>
                <th style={{ width: "10%" }}>UPDATED</th>
              </tr>
            </thead>
            <tbody>
              {tasks.slice(0, 50).map((task) => (
                <tr
                  key={task.id}
                  onClick={() => onSelectTask(selectedTaskId === task.id ? null : task.id)}
                >
                  <td>
                    <Typography
                      sx={{
                        fontFamily: "code",
                        fontSize: "0.8rem",
                        color: "text.primary",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {task.task}
                    </Typography>
                  </td>
                  <td>
                    <Typography
                      sx={{
                        fontFamily: "code",
                        fontSize: "0.75rem",
                        color: task.agentId ? colors.amber : "text.tertiary",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {task.agentId ? (agentMap.get(task.agentId) || task.agentId.slice(0, 8)) : "—"}
                    </Typography>
                  </td>
                  <td>
                    <Typography
                      sx={{
                        fontFamily: "code",
                        fontSize: "0.7rem",
                        color: task.taskType ? "text.secondary" : "text.tertiary",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {task.taskType || "—"}
                    </Typography>
                  </td>
                  <td>
                    {task.tags && task.tags.length > 0 ? (
                      <Box sx={{ display: "flex", gap: 0.5, flexWrap: "nowrap", overflow: "hidden" }}>
                        {task.tags.slice(0, 2).map((tag) => (
                          <Chip
                            key={tag}
                            size="sm"
                            variant="soft"
                            sx={{
                              fontFamily: "code",
                              fontSize: "0.6rem",
                              bgcolor: isDark ? "rgba(212, 165, 116, 0.1)" : "rgba(139, 105, 20, 0.08)",
                              color: colors.gold,
                              border: `1px solid ${isDark ? "rgba(212, 165, 116, 0.3)" : "rgba(139, 105, 20, 0.25)"}`,
                            }}
                          >
                            {tag}
                          </Chip>
                        ))}
                        {task.tags.length > 2 && (
                          <Typography sx={{ fontFamily: "code", fontSize: "0.6rem", color: "text.tertiary" }}>
                            +{task.tags.length - 2}
                          </Typography>
                        )}
                      </Box>
                    ) : (
                      <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
                        —
                      </Typography>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={task.status} />
                  </td>
                  <td>
                    <Typography
                      sx={{
                        fontFamily: "code",
                        fontSize: "0.7rem",
                        color: "text.tertiary",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {task.progress || "—"}
                    </Typography>
                  </td>
                  <td>
                    <Typography
                      sx={{
                        fontFamily: "code",
                        fontSize: "0.7rem",
                        color: task.status === "in_progress" ? colors.amber : "text.tertiary",
                      }}
                    >
                      {getElapsedTime(task)}
                    </Typography>
                  </td>
                  <td>
                    <Typography
                      sx={{
                        fontFamily: "code",
                        fontSize: "0.7rem",
                        color: "text.tertiary",
                      }}
                    >
                      {formatSmartTime(task.lastUpdatedAt)}
                    </Typography>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Box>

      {/* Footer */}
      {tasks && tasks.length > 50 && (
        <Box
          sx={{
            p: 1.5,
            textAlign: "center",
            borderTop: "1px solid",
            borderColor: "neutral.outlinedBorder",
            bgcolor: "background.level1",
          }}
        >
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.7rem",
              color: "text.tertiary",
            }}
          >
            Showing 50 of {tasks.length} tasks
          </Typography>
        </Box>
      )}
    </Card>
  );
}

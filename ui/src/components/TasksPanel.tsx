import Box from "@mui/joy/Box";
import Card from "@mui/joy/Card";
import Chip from "@mui/joy/Chip";
import Input from "@mui/joy/Input";
import Option from "@mui/joy/Option";
import Select from "@mui/joy/Select";
import { useColorScheme } from "@mui/joy/styles";
import Table from "@mui/joy/Table";
import Typography from "@mui/joy/Typography";
import { useMemo, useState } from "react";
import { useAgents, useTasks } from "../hooks/queries";
import type { AgentTask, TaskStatus } from "../types/api";
import StatusBadge from "./StatusBadge";

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
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Mobile card component
interface TaskCardProps {
  task: AgentTask;
  selected: boolean;
  onClick: () => void;
  agent?: import("../types/api").Agent;
  isDark: boolean;
}

function TaskCard({ task, selected, onClick, agent, isDark }: TaskCardProps) {
  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
    selectedBorder: isDark ? "#D4A574" : "#8B6914",
    goldSoftBg: isDark ? "rgba(212, 165, 116, 0.1)" : "rgba(139, 105, 20, 0.08)",
    goldBorder: isDark ? "rgba(212, 165, 116, 0.3)" : "rgba(139, 105, 20, 0.25)",
  };

  return (
    <Box
      onClick={onClick}
      sx={{
        p: 2,
        mb: 1,
        borderRadius: "8px",
        border: "1px solid",
        borderColor: selected ? colors.selectedBorder : "neutral.outlinedBorder",
        bgcolor: selected ? colors.goldSoftBg : "background.surface",
        cursor: "pointer",
        transition: "all 0.2s ease",
        "&:active": {
          bgcolor: colors.goldSoftBg,
        },
      }}
    >
      <Typography
        sx={{
          fontFamily: "code",
          fontSize: "0.85rem",
          fontWeight: 600,
          color: "text.primary",
          mb: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {task.task}
      </Typography>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 0.5 }}>
        <StatusBadge status={task.status} />
        <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
          {getElapsedTime(task)}
        </Typography>
      </Box>
      {task.agentId && (
        <Box sx={{ display: "flex", gap: 0.5, alignItems: "center", mt: 0.5 }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: colors.amber }}>
            Agent: {agent?.name || task.agentId.slice(0, 8)}
          </Typography>
        </Box>
      )}
      {task.tags && task.tags.length > 0 && (
        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 1 }}>
          {task.tags.slice(0, 3).map((tag) => (
            <Chip
              key={tag}
              size="sm"
              variant="soft"
              sx={{
                fontFamily: "code",
                fontSize: "0.55rem",
                bgcolor: colors.goldSoftBg,
                color: colors.gold,
                border: `1px solid ${colors.goldBorder}`,
              }}
            >
              {tag}
            </Chip>
          ))}
        </Box>
      )}
    </Box>
  );
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

  const { data: tasksData, isLoading } = useTasks(filters);
  const tasks = tasksData?.tasks;
  const totalCount = tasksData?.total ?? 0;

  // Create agent lookup
  const agentMap = useMemo(() => {
    const map = new Map();
    agents?.forEach((a) => map.set(a.id, a));
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
          flexDirection: { xs: "column", sm: "row" },
          alignItems: { xs: "stretch", sm: "center" },
          justifyContent: "space-between",
          px: { xs: 1.5, md: 2 },
          py: 1.5,
          borderBottom: "1px solid",
          borderColor: "neutral.outlinedBorder",
          bgcolor: "background.level1",
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
              fontSize: { xs: "0.9rem", md: "1rem" },
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
            ({totalCount})
          </Typography>
        </Box>

        {/* Filters */}
        <Box
          sx={{
            display: "flex",
            flexDirection: { xs: "column", sm: "row" },
            alignItems: { xs: "stretch", sm: "center" },
            gap: 1,
          }}
        >
          {/* Search */}
          <Input
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            size="sm"
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              minWidth: { xs: "100%", sm: 180 },
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

          {/* Agent Filter - hidden on mobile to save space */}
          <Select
            value={agentFilter}
            onChange={(_, value) => setAgentFilter(value as string)}
            size="sm"
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              minWidth: { xs: "100%", sm: 130 },
              display: { xs: "none", sm: "flex" },
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
              minWidth: { xs: "100%", sm: 120 },
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
            <Option value="paused">PAUSED</Option>
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
          <>
            {/* Desktop Table */}
            <Box sx={{ display: { xs: "none", md: "block" } }}>
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
                        {task.agentId ? (
                          <Typography
                            sx={{
                              fontFamily: "code",
                              fontSize: "0.75rem",
                              color: colors.amber,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {agentMap.get(task.agentId)?.name || task.agentId.slice(0, 8)}
                          </Typography>
                        ) : (
                          <Typography
                            sx={{
                              fontFamily: "code",
                              fontSize: "0.75rem",
                              color: "text.tertiary",
                            }}
                          >
                            —
                          </Typography>
                        )}
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
                          <Box
                            sx={{
                              display: "flex",
                              gap: 0.5,
                              flexWrap: "nowrap",
                              overflow: "hidden",
                            }}
                          >
                            {task.tags.slice(0, 2).map((tag) => (
                              <Chip
                                key={tag}
                                size="sm"
                                variant="soft"
                                sx={{
                                  fontFamily: "code",
                                  fontSize: "0.6rem",
                                  bgcolor: isDark
                                    ? "rgba(212, 165, 116, 0.1)"
                                    : "rgba(139, 105, 20, 0.08)",
                                  color: colors.gold,
                                  border: `1px solid ${isDark ? "rgba(212, 165, 116, 0.3)" : "rgba(139, 105, 20, 0.25)"}`,
                                }}
                              >
                                {tag}
                              </Chip>
                            ))}
                            {task.tags.length > 2 && (
                              <Typography
                                sx={{
                                  fontFamily: "code",
                                  fontSize: "0.6rem",
                                  color: "text.tertiary",
                                }}
                              >
                                +{task.tags.length - 2}
                              </Typography>
                            )}
                          </Box>
                        ) : (
                          <Typography
                            sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}
                          >
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
            </Box>

            {/* Mobile Cards */}
            <Box sx={{ display: { xs: "block", md: "none" }, p: 1.5 }}>
              {tasks.slice(0, 50).map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  selected={selectedTaskId === task.id}
                  onClick={() => onSelectTask(selectedTaskId === task.id ? null : task.id)}
                  agent={task.agentId ? agentMap.get(task.agentId) : undefined}
                  isDark={isDark}
                />
              ))}
            </Box>
          </>
        )}
      </Box>

      {/* Footer */}
      {tasks && totalCount > tasks.length && (
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
            Showing {Math.min(50, tasks.length)} of {totalCount} tasks
          </Typography>
        </Box>
      )}
    </Card>
  );
}

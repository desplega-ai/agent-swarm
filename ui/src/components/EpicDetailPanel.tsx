import { useState } from "react";
import Box from "@mui/joy/Box";
import Typography from "@mui/joy/Typography";
import IconButton from "@mui/joy/IconButton";
import Tooltip from "@mui/joy/Tooltip";
import Tabs from "@mui/joy/Tabs";
import TabList from "@mui/joy/TabList";
import Tab from "@mui/joy/Tab";
import TabPanel from "@mui/joy/TabPanel";
import Chip from "@mui/joy/Chip";
import LinearProgress from "@mui/joy/LinearProgress";
import { useColorScheme } from "@mui/joy/styles";
import { useEpic, useAgents } from "../hooks/queries";
import type { EpicStatus, AgentTask, AgentTaskStatus } from "../types/api";

interface EpicDetailPanelProps {
  epicId: string;
  onClose: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

function formatSmartTime(dateStr: string | undefined): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);

  if (diffHours < 6) {
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    return `${diffHours}h ago`;
  }

  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  return date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function getStatusColor(status: EpicStatus, isDark: boolean) {
  switch (status) {
    case "draft":
      return isDark ? "#9E9E9E" : "#757575";
    case "active":
      return isDark ? "#4CAF50" : "#2E7D32";
    case "paused":
      return isDark ? "#FF9800" : "#F57C00";
    case "completed":
      return isDark ? "#2196F3" : "#1976D2";
    case "cancelled":
      return isDark ? "#EF5350" : "#D32F2F";
    default:
      return isDark ? "#9E9E9E" : "#757575";
  }
}

function getStatusBgColor(status: EpicStatus, isDark: boolean) {
  switch (status) {
    case "draft":
      return isDark ? "rgba(158, 158, 158, 0.15)" : "rgba(117, 117, 117, 0.1)";
    case "active":
      return isDark ? "rgba(76, 175, 80, 0.15)" : "rgba(46, 125, 50, 0.1)";
    case "paused":
      return isDark ? "rgba(255, 152, 0, 0.15)" : "rgba(245, 124, 0, 0.1)";
    case "completed":
      return isDark ? "rgba(33, 150, 243, 0.15)" : "rgba(25, 118, 210, 0.1)";
    case "cancelled":
      return isDark ? "rgba(239, 83, 80, 0.15)" : "rgba(211, 47, 47, 0.1)";
    default:
      return isDark ? "rgba(158, 158, 158, 0.15)" : "rgba(117, 117, 117, 0.1)";
  }
}

function getTaskStatusColor(status: AgentTaskStatus, isDark: boolean) {
  switch (status) {
    case "pending":
    case "unassigned":
    case "offered":
      return isDark ? "#9E9E9E" : "#757575";
    case "in_progress":
    case "reviewing":
      return isDark ? "#FF9800" : "#F57C00";
    case "completed":
      return isDark ? "#4CAF50" : "#2E7D32";
    case "failed":
    case "cancelled":
      return isDark ? "#EF5350" : "#D32F2F";
    case "paused":
      return isDark ? "#2196F3" : "#1976D2";
    default:
      return isDark ? "#9E9E9E" : "#757575";
  }
}

// Kanban column component
interface KanbanColumnProps {
  title: string;
  tasks: AgentTask[];
  agentMap: Map<string, { name: string }>;
  isDark: boolean;
  colors: Record<string, string>;
}

function KanbanColumn({ title, tasks, agentMap, isDark, colors }: KanbanColumnProps) {
  return (
    <Box
      sx={{
        flex: 1,
        minWidth: 200,
        maxWidth: 300,
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.level1",
        borderRadius: 1,
        border: "1px solid",
        borderColor: "neutral.outlinedBorder",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          px: 1.5,
          py: 1,
          borderBottom: "1px solid",
          borderColor: "neutral.outlinedBorder",
          bgcolor: "background.surface",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.7rem",
              fontWeight: 600,
              color: "text.tertiary",
              letterSpacing: "0.05em",
            }}
          >
            {title}
          </Typography>
          <Chip
            size="sm"
            sx={{
              fontFamily: "code",
              fontSize: "0.6rem",
              minHeight: "auto",
              height: 16,
              bgcolor: colors.goldSoftBg,
              color: colors.gold,
            }}
          >
            {tasks.length}
          </Chip>
        </Box>
      </Box>
      <Box sx={{ flex: 1, overflow: "auto", p: 1 }}>
        {tasks.length === 0 ? (
          <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary", textAlign: "center", py: 2 }}>
            No tasks
          </Typography>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {tasks.map((task) => (
              <Box
                key={task.id}
                sx={{
                  p: 1.5,
                  bgcolor: "background.surface",
                  borderRadius: 1,
                  border: "1px solid",
                  borderColor: "neutral.outlinedBorder",
                }}
              >
                <Typography
                  sx={{
                    fontFamily: "code",
                    fontSize: "0.75rem",
                    color: "text.primary",
                    mb: 0.5,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {task.task}
                </Typography>
                <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  {task.agentId ? (
                    <Typography sx={{ fontFamily: "code", fontSize: "0.65rem", color: colors.amber }}>
                      {agentMap.get(task.agentId)?.name || task.agentId.slice(0, 8)}
                    </Typography>
                  ) : (
                    <Typography sx={{ fontFamily: "code", fontSize: "0.65rem", color: "text.tertiary" }}>
                      Unassigned
                    </Typography>
                  )}
                  <Chip
                    size="sm"
                    sx={{
                      fontFamily: "code",
                      fontSize: "0.55rem",
                      minHeight: "auto",
                      height: 14,
                      bgcolor: isDark ? "rgba(100, 100, 100, 0.15)" : "rgba(150, 150, 150, 0.12)",
                      color: getTaskStatusColor(task.status, isDark),
                      textTransform: "uppercase",
                    }}
                  >
                    {task.status.replace("_", " ")}
                  </Chip>
                </Box>
                <Typography sx={{ fontFamily: "code", fontSize: "0.6rem", color: "text.tertiary", mt: 0.5 }}>
                  {formatSmartTime(task.createdAt)}
                </Typography>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

export default function EpicDetailPanel({
  epicId,
  onClose,
  expanded = false,
  onToggleExpand,
}: EpicDetailPanelProps) {
  const { data: epic, isLoading } = useEpic(epicId);
  const { data: agents } = useAgents();
  const { mode } = useColorScheme();
  const isDark = mode === "dark";
  const [activeTab, setActiveTab] = useState<"details" | "tasks">("details");

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
    goldGlow: isDark ? "0 0 8px rgba(212, 165, 116, 0.5)" : "0 0 6px rgba(139, 105, 20, 0.3)",
    goldSoftBg: isDark ? "rgba(212, 165, 116, 0.1)" : "rgba(139, 105, 20, 0.08)",
    goldBorder: isDark ? "rgba(212, 165, 116, 0.3)" : "rgba(139, 105, 20, 0.25)",
    closeBtn: isDark ? "#8B7355" : "#5C4A3D",
    closeBtnHover: isDark ? "#FFF8E7" : "#1A130E",
    hoverBg: isDark ? "rgba(245, 166, 35, 0.05)" : "rgba(212, 136, 6, 0.05)",
  };

  // Create agent lookup
  const agentMap = new Map<string, { name: string }>();
  agents?.forEach((a) => agentMap.set(a.id, { name: a.name }));

  const leadAgentName = epic?.leadAgentId ? agentMap.get(epic.leadAgentId)?.name || epic.leadAgentId.slice(0, 8) : null;

  // Group tasks by status for kanban view
  const tasks = epic?.tasks || [];
  const pendingTasks = tasks.filter((t) => ["pending", "unassigned", "offered"].includes(t.status));
  const inProgressTasks = tasks.filter((t) => ["in_progress", "reviewing", "paused"].includes(t.status));
  const completedTasks = tasks.filter((t) => t.status === "completed");
  const failedTasks = tasks.filter((t) => ["failed", "cancelled"].includes(t.status));

  if (isLoading || !epic) {
    return (
      <Box
        sx={{
          position: { xs: "fixed", md: "relative" },
          inset: { xs: 0, md: "auto" },
          zIndex: { xs: 1300, md: "auto" },
          width: { xs: "100%", md: expanded ? "100%" : 500 },
          height: "100%",
          bgcolor: "background.surface",
          border: { xs: "none", md: "1px solid" },
          borderColor: "neutral.outlinedBorder",
          borderRadius: { xs: 0, md: "12px" },
          p: { xs: 2, md: 3 },
          overflow: "auto",
        }}
      >
        <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
          {isLoading ? "Loading epic..." : "Epic not found"}
        </Typography>
      </Box>
    );
  }

  const progress = epic.progress ?? 0;

  // Left side: Epic details
  const DetailsSection = () => (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, p: { xs: 1.5, md: 2 } }}>
      {/* Status */}
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
          Status
        </Typography>
        <Chip
          size="sm"
          variant="soft"
          sx={{
            fontFamily: "code",
            fontSize: "0.65rem",
            bgcolor: getStatusBgColor(epic.status, isDark),
            color: getStatusColor(epic.status, isDark),
            textTransform: "uppercase",
          }}
        >
          {epic.status}
        </Chip>
      </Box>

      {/* Goal */}
      <Box>
        <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary", mb: 0.5 }}>
          Goal
        </Typography>
        <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: "text.primary", lineHeight: 1.5 }}>
          {epic.goal}
        </Typography>
      </Box>

      {/* Description */}
      {epic.description && (
        <Box>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary", mb: 0.5 }}>
            Description
          </Typography>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary", lineHeight: 1.5 }}>
            {epic.description}
          </Typography>
        </Box>
      )}

      {/* Progress */}
      <Box>
        <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Progress
          </Typography>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: colors.amber }}>
            {progress}%
          </Typography>
        </Box>
        <LinearProgress
          determinate
          value={progress}
          sx={{
            height: 8,
            borderRadius: 4,
            bgcolor: isDark ? "rgba(212, 165, 116, 0.2)" : "rgba(139, 105, 20, 0.15)",
            "& .MuiLinearProgress-bar": {
              bgcolor: colors.amber,
              borderRadius: 4,
            },
          }}
        />
        {epic.taskStats && (
          <Box sx={{ display: "flex", gap: 2, mt: 0.5 }}>
            <Typography sx={{ fontFamily: "code", fontSize: "0.65rem", color: "text.tertiary" }}>
              {epic.taskStats.completed}/{epic.taskStats.total} tasks
            </Typography>
            {epic.taskStats.inProgress > 0 && (
              <Typography sx={{ fontFamily: "code", fontSize: "0.65rem", color: colors.amber }}>
                {epic.taskStats.inProgress} in progress
              </Typography>
            )}
          </Box>
        )}
      </Box>

      {/* Priority */}
      {epic.priority !== 50 && (
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Priority
          </Typography>
          <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: epic.priority > 50 ? colors.amber : "text.secondary" }}>
            {epic.priority}
          </Typography>
        </Box>
      )}

      {/* Lead Agent */}
      {leadAgentName && (
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Lead
          </Typography>
          <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: colors.amber }}>
            {leadAgentName}
          </Typography>
        </Box>
      )}

      {/* Tags */}
      {epic.tags && epic.tags.length > 0 && (
        <Box>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary", mb: 0.5 }}>
            Tags
          </Typography>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
            {epic.tags.map((tag) => (
              <Chip
                key={tag}
                size="sm"
                variant="soft"
                sx={{
                  fontFamily: "code",
                  fontSize: "0.65rem",
                  bgcolor: colors.goldSoftBg,
                  color: colors.gold,
                  border: `1px solid ${colors.goldBorder}`,
                }}
              >
                {tag}
              </Chip>
            ))}
          </Box>
        </Box>
      )}

      {/* Dates */}
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
          Created
        </Typography>
        <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary" }}>
          {new Date(epic.createdAt).toLocaleDateString()}
        </Typography>
      </Box>

      {epic.startedAt && (
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Started
          </Typography>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary" }}>
            {new Date(epic.startedAt).toLocaleDateString()}
          </Typography>
        </Box>
      )}

      {epic.completedAt && (
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Completed
          </Typography>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary" }}>
            {new Date(epic.completedAt).toLocaleDateString()}
          </Typography>
        </Box>
      )}

      {/* GitHub info */}
      {epic.githubRepo && (
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Repository
          </Typography>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: colors.amber }}>
            {epic.githubRepo}
          </Typography>
        </Box>
      )}
    </Box>
  );

  // Right side: Details tab content (PRD and Plan)
  const DetailsTabContent = () => (
    <Box sx={{ p: 2, overflow: "auto", flex: 1 }}>
      {epic.prd ? (
        <Box sx={{ mb: 3 }}>
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.7rem",
              color: "text.tertiary",
              letterSpacing: "0.05em",
              mb: 1,
            }}
          >
            PRD (PRODUCT REQUIREMENTS)
          </Typography>
          <Box
            sx={{
              p: 2,
              bgcolor: "background.level1",
              borderRadius: 1,
              border: "1px solid",
              borderColor: "neutral.outlinedBorder",
            }}
          >
            <Typography
              sx={{
                fontFamily: "code",
                fontSize: "0.75rem",
                color: "text.primary",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {epic.prd}
            </Typography>
          </Box>
        </Box>
      ) : null}

      {epic.plan ? (
        <Box>
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.7rem",
              color: "text.tertiary",
              letterSpacing: "0.05em",
              mb: 1,
            }}
          >
            IMPLEMENTATION PLAN
          </Typography>
          <Box
            sx={{
              p: 2,
              bgcolor: "background.level1",
              borderRadius: 1,
              border: "1px solid",
              borderColor: "neutral.outlinedBorder",
            }}
          >
            <Typography
              sx={{
                fontFamily: "code",
                fontSize: "0.75rem",
                color: "text.primary",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {epic.plan}
            </Typography>
          </Box>
        </Box>
      ) : null}

      {!epic.prd && !epic.plan && (
        <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary", textAlign: "center", py: 4 }}>
          No PRD or plan content available
        </Typography>
      )}
    </Box>
  );

  // Right side: Tasks tab content (Kanban view)
  const TasksTabContent = () => (
    <Box sx={{ p: 2, overflow: "auto", flex: 1 }}>
      {tasks.length === 0 ? (
        <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary", textAlign: "center", py: 4 }}>
          No tasks associated with this epic
        </Typography>
      ) : (
        <Box
          sx={{
            display: "flex",
            gap: 2,
            overflowX: "auto",
            pb: 1,
          }}
        >
          <KanbanColumn
            title="PENDING"
            tasks={pendingTasks}
            agentMap={agentMap}
            isDark={isDark}
            colors={colors}
          />
          <KanbanColumn
            title="IN PROGRESS"
            tasks={inProgressTasks}
            agentMap={agentMap}
            isDark={isDark}
            colors={colors}
          />
          <KanbanColumn
            title="COMPLETED"
            tasks={completedTasks}
            agentMap={agentMap}
            isDark={isDark}
            colors={colors}
          />
          {failedTasks.length > 0 && (
            <KanbanColumn
              title="FAILED"
              tasks={failedTasks}
              agentMap={agentMap}
              isDark={isDark}
              colors={colors}
            />
          )}
        </Box>
      )}
    </Box>
  );

  return (
    <Box
      sx={{
        position: { xs: "fixed", md: "relative" },
        inset: { xs: 0, md: "auto" },
        zIndex: { xs: 1300, md: "auto" },
        width: { xs: "100%", md: expanded ? "100%" : 700 },
        height: { xs: "100%", md: "100%" },
        bgcolor: "background.surface",
        border: { xs: "none", md: "1px solid" },
        borderColor: "neutral.outlinedBorder",
        borderRadius: { xs: 0, md: "12px" },
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          px: { xs: 1.5, md: 2 },
          py: 1.5,
          borderBottom: "1px solid",
          borderColor: "neutral.outlinedBorder",
          bgcolor: "background.level1",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderRadius: { xs: 0, md: "12px 12px 0 0" },
          flexShrink: 0,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
          {/* Mobile back button */}
          <IconButton
            size="sm"
            variant="plain"
            onClick={onClose}
            sx={{
              display: { xs: "flex", md: "none" },
              color: colors.closeBtn,
              minWidth: 44,
              minHeight: 44,
              "&:hover": { color: colors.closeBtnHover, bgcolor: colors.hoverBg },
            }}
          >
            ←
          </IconButton>
          <Box
            sx={{
              width: 8,
              height: 10,
              clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
              bgcolor: colors.gold,
              boxShadow: colors.goldGlow,
              display: { xs: "none", md: "block" },
              flexShrink: 0,
            }}
          />
          <Typography
            sx={{
              fontFamily: "display",
              fontWeight: 600,
              color: colors.gold,
              letterSpacing: "0.03em",
              fontSize: { xs: "0.9rem", md: "1rem" },
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {epic.name}
          </Typography>
        </Box>
        {/* Desktop buttons */}
        <Box sx={{ display: { xs: "none", md: "flex" }, alignItems: "center", gap: 0.5 }}>
          {onToggleExpand && (
            <Tooltip title={expanded ? "Collapse panel" : "Expand to full width"} placement="bottom">
              <IconButton
                size="sm"
                variant="plain"
                onClick={onToggleExpand}
                sx={{
                  color: colors.closeBtn,
                  "&:hover": { color: colors.closeBtnHover, bgcolor: colors.hoverBg },
                }}
              >
                {expanded ? "⊟" : "⊞"}
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Close panel" placement="bottom">
            <IconButton
              size="sm"
              variant="plain"
              onClick={onClose}
              sx={{
                color: colors.closeBtn,
                "&:hover": { color: colors.closeBtnHover, bgcolor: colors.hoverBg },
              }}
            >
              ✕
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Content: Control center layout */}
      <Box
        sx={{
          flex: 1,
          overflow: "hidden",
          display: "flex",
          flexDirection: { xs: "column", md: "row" },
        }}
      >
        {/* Left side: Epic details */}
        <Box
          sx={{
            width: { xs: "100%", md: 280, lg: 320 },
            flexShrink: 0,
            borderRight: { xs: "none", md: "1px solid" },
            borderBottom: { xs: "1px solid", md: "none" },
            borderColor: "neutral.outlinedBorder",
            overflow: "auto",
            maxHeight: { xs: "40vh", md: "none" },
          }}
        >
          <DetailsSection />
        </Box>

        {/* Right side: Tabbed content */}
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <Tabs
            value={activeTab}
            onChange={(_, value) => setActiveTab(value as "details" | "tasks")}
            sx={{ display: "flex", flexDirection: "column", height: "100%" }}
          >
            <TabList
              sx={{
                gap: 0.5,
                bgcolor: "background.level1",
                borderBottom: "1px solid",
                borderColor: "neutral.outlinedBorder",
                px: 1,
                pt: 0.5,
                flexShrink: 0,
                minHeight: 32,
                "& .MuiTab-root": {
                  fontFamily: "code",
                  fontSize: "0.75rem",
                  letterSpacing: "0.03em",
                  fontWeight: 600,
                  color: "text.tertiary",
                  bgcolor: "transparent",
                  border: "1px solid transparent",
                  borderBottom: "none",
                  borderRadius: "6px 6px 0 0",
                  minHeight: "auto",
                  transition: "all 0.2s ease",
                  "&:hover": {
                    color: "text.secondary",
                    bgcolor: colors.hoverBg,
                  },
                  "&.Mui-selected": {
                    color: colors.gold,
                    bgcolor: "background.surface",
                    borderColor: "neutral.outlinedBorder",
                    borderBottomColor: "background.surface",
                  },
                },
              }}
            >
              <Tab value="details">DETAILS</Tab>
              <Tab value="tasks">
                TASKS
                {tasks.length > 0 && (
                  <Chip
                    size="sm"
                    sx={{
                      ml: 0.5,
                      fontFamily: "code",
                      fontSize: "0.55rem",
                      minHeight: "auto",
                      height: 14,
                      bgcolor: colors.goldSoftBg,
                      color: colors.gold,
                    }}
                  >
                    {tasks.length}
                  </Chip>
                )}
              </Tab>
            </TabList>
            <TabPanel value="details" sx={{ p: 0, flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <DetailsTabContent />
            </TabPanel>
            <TabPanel value="tasks" sx={{ p: 0, flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <TasksTabContent />
            </TabPanel>
          </Tabs>
        </Box>
      </Box>
    </Box>
  );
}

import Box from "@mui/joy/Box";
import Card from "@mui/joy/Card";
import Chip from "@mui/joy/Chip";
import Divider from "@mui/joy/Divider";
import IconButton from "@mui/joy/IconButton";
import LinearProgress from "@mui/joy/LinearProgress";
import { useColorScheme } from "@mui/joy/styles";
import Tab from "@mui/joy/Tab";
import TabList from "@mui/joy/TabList";
import TabPanel from "@mui/joy/TabPanel";
import Tabs from "@mui/joy/Tabs";
import Typography from "@mui/joy/Typography";
import { useMemo } from "react";
import { useAgents, useEpic } from "../hooks/queries";
import type { AgentTask, EpicWithTasks } from "../types/api";
import StatusBadge from "./StatusBadge";

interface EpicDetailPageProps {
  epicId: string;
  onClose: () => void;
  onNavigateToTask?: (taskId: string) => void;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Kanban-like task column
interface TaskColumnProps {
  title: string;
  tasks: AgentTask[];
  color: string;
  bgColor: string;
  onTaskClick?: (taskId: string) => void;
}

function TaskColumn({ title, tasks, color, bgColor, onTaskClick }: TaskColumnProps) {
  return (
    <Box
      sx={{
        flex: 1,
        minWidth: 200,
        maxWidth: 300,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          mb: 1,
          px: 1,
        }}
      >
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            bgcolor: color,
          }}
        />
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
            height: "16px",
            bgcolor: bgColor,
            color: color,
          }}
        >
          {tasks.length}
        </Chip>
      </Box>
      <Box
        sx={{
          flex: 1,
          bgcolor: bgColor,
          borderRadius: "8px",
          p: 1,
          display: "flex",
          flexDirection: "column",
          gap: 1,
          minHeight: 100,
          maxHeight: 400,
          overflow: "auto",
        }}
      >
        {tasks.length === 0 ? (
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.7rem",
              color: "text.tertiary",
              textAlign: "center",
              py: 2,
            }}
          >
            No tasks
          </Typography>
        ) : (
          tasks.map((task) => (
            <Box
              key={task.id}
              onClick={() => onTaskClick?.(task.id)}
              sx={{
                p: 1.5,
                bgcolor: "background.surface",
                borderRadius: "6px",
                border: "1px solid",
                borderColor: "neutral.outlinedBorder",
                cursor: onTaskClick ? "pointer" : "default",
                transition: "all 0.2s ease",
                "&:hover": onTaskClick
                  ? {
                      borderColor: color,
                      transform: "translateY(-1px)",
                    }
                  : {},
              }}
            >
              <Typography
                sx={{
                  fontFamily: "code",
                  fontSize: "0.75rem",
                  color: "text.primary",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {task.task}
              </Typography>
              {task.taskType && (
                <Typography
                  sx={{
                    fontFamily: "code",
                    fontSize: "0.6rem",
                    color: "text.tertiary",
                    mt: 0.5,
                  }}
                >
                  {task.taskType}
                </Typography>
              )}
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

// Markdown-like content viewer (simple)
function ContentViewer({ content, label }: { content?: string; label: string }) {
  if (!content) {
    return (
      <Box sx={{ p: 2, textAlign: "center" }}>
        <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: "text.tertiary" }}>
          No {label} defined
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        p: 2,
        bgcolor: "background.level1",
        borderRadius: "8px",
        maxHeight: 400,
        overflow: "auto",
      }}
    >
      <Typography
        component="pre"
        sx={{
          fontFamily: "code",
          fontSize: "0.8rem",
          color: "text.primary",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          m: 0,
        }}
      >
        {content}
      </Typography>
    </Box>
  );
}

export default function EpicDetailPage({ epicId, onClose, onNavigateToTask }: EpicDetailPageProps) {
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const { data: epic, isLoading } = useEpic(epicId);
  const { data: agents } = useAgents();

  const colors = {
    gold: isDark ? "#D4A574" : "#8B6914",
    goldGlow: isDark ? "0 0 8px rgba(212, 165, 116, 0.5)" : "0 0 6px rgba(139, 105, 20, 0.3)",
    goldSoftBg: isDark ? "rgba(212, 165, 116, 0.08)" : "rgba(139, 105, 20, 0.06)",
    amber: isDark ? "#F5A623" : "#D48806",
    green: isDark ? "#4CAF50" : "#2E7D32",
    greenBg: isDark ? "rgba(76, 175, 80, 0.1)" : "rgba(46, 125, 50, 0.08)",
    blue: isDark ? "#2196F3" : "#1976D2",
    blueBg: isDark ? "rgba(33, 150, 243, 0.1)" : "rgba(25, 118, 210, 0.08)",
    orange: isDark ? "#FF9800" : "#E65100",
    orangeBg: isDark ? "rgba(255, 152, 0, 0.1)" : "rgba(230, 81, 0, 0.08)",
    red: isDark ? "#f44336" : "#d32f2f",
    redBg: isDark ? "rgba(244, 67, 54, 0.1)" : "rgba(211, 47, 47, 0.08)",
    gray: isDark ? "#9e9e9e" : "#757575",
    grayBg: isDark ? "rgba(158, 158, 158, 0.1)" : "rgba(117, 117, 117, 0.08)",
  };

  const agentMap = useMemo(() => {
    const map = new Map();
    agents?.forEach((a) => map.set(a.id, a));
    return map;
  }, [agents]);

  // Group tasks by status for kanban view
  const tasksByStatus = useMemo(() => {
    if (!epic?.tasks) return { pending: [], inProgress: [], completed: [], failed: [], other: [] };

    const pending: AgentTask[] = [];
    const inProgress: AgentTask[] = [];
    const completed: AgentTask[] = [];
    const failed: AgentTask[] = [];
    const other: AgentTask[] = [];

    for (const task of epic.tasks) {
      switch (task.status) {
        case "pending":
        case "unassigned":
        case "offered":
          pending.push(task);
          break;
        case "in_progress":
        case "paused":
          inProgress.push(task);
          break;
        case "completed":
          completed.push(task);
          break;
        case "failed":
        case "cancelled":
          failed.push(task);
          break;
        default:
          other.push(task);
      }
    }

    return { pending, inProgress, completed, failed, other };
  }, [epic?.tasks]);

  if (isLoading) {
    return (
      <Box sx={{ p: 4, textAlign: "center" }}>
        <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>Loading epic...</Typography>
      </Box>
    );
  }

  if (!epic) {
    return (
      <Box sx={{ p: 4, textAlign: "center" }}>
        <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>Epic not found</Typography>
      </Box>
    );
  }

  const epicWithProgress = epic as EpicWithTasks;
  const progress = epicWithProgress.progress ?? 0;
  const taskStats = epicWithProgress.taskStats;

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
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
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <IconButton
            variant="plain"
            size="sm"
            onClick={onClose}
            sx={{
              fontFamily: "code",
              color: "text.tertiary",
              "&:hover": { color: colors.amber },
            }}
          >
            ← Back
          </IconButton>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Box
              sx={{
                width: 10,
                height: 12,
                clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
                bgcolor: colors.gold,
                boxShadow: colors.goldGlow,
              }}
            />
            <Typography
              level="title-lg"
              sx={{
                fontFamily: "display",
                fontWeight: 600,
                color: colors.gold,
                letterSpacing: "0.02em",
              }}
            >
              {epic.name}
            </Typography>
          </Box>
          <StatusBadge status={epic.status} />
        </Box>

        {/* Progress indicator */}
        {taskStats && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 150 }}>
              <LinearProgress
                determinate
                value={progress}
                sx={{
                  flex: 1,
                  height: 6,
                  borderRadius: 3,
                  bgcolor: "neutral.softBg",
                  "& .MuiLinearProgress-bar": {
                    bgcolor: progress === 100 ? colors.green : colors.amber,
                    borderRadius: 3,
                  },
                }}
              />
              <Typography
                sx={{
                  fontFamily: "code",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  color: progress === 100 ? colors.green : colors.amber,
                  minWidth: "3em",
                }}
              >
                {progress}%
              </Typography>
            </Box>
            <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
              {taskStats.completed}/{taskStats.total} tasks
            </Typography>
          </Box>
        )}
      </Box>

      {/* Main Content - Control Center Layout */}
      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: { xs: "column", lg: "row" },
          gap: 2,
          p: 2,
          overflow: "hidden",
        }}
      >
        {/* Left Side - Epic Details */}
        <Card
          variant="outlined"
          sx={{
            flex: { xs: "none", lg: 1 },
            minWidth: { lg: 300 },
            maxWidth: { lg: 400 },
            overflow: "auto",
            p: 2,
          }}
        >
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              fontWeight: 600,
              color: colors.gold,
              letterSpacing: "0.05em",
              mb: 2,
            }}
          >
            EPIC DETAILS
          </Typography>

          {/* Goal */}
          <Box sx={{ mb: 2 }}>
            <Typography
              sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary", mb: 0.5 }}
            >
              GOAL
            </Typography>
            <Typography sx={{ fontFamily: "code", fontSize: "0.85rem", color: "text.primary" }}>
              {epic.goal}
            </Typography>
          </Box>

          {epic.description && (
            <Box sx={{ mb: 2 }}>
              <Typography
                sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary", mb: 0.5 }}
              >
                DESCRIPTION
              </Typography>
              <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: "text.secondary" }}>
                {epic.description}
              </Typography>
            </Box>
          )}

          <Divider sx={{ my: 2 }} />

          {/* Metadata */}
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            <Box sx={{ display: "flex", justifyContent: "space-between" }}>
              <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
                Priority
              </Typography>
              <Typography
                sx={{
                  fontFamily: "code",
                  fontSize: "0.75rem",
                  color: colors.amber,
                  fontWeight: 600,
                }}
              >
                {epic.priority}
              </Typography>
            </Box>

            {epic.leadAgentId && (
              <Box sx={{ display: "flex", justifyContent: "space-between" }}>
                <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
                  Lead Agent
                </Typography>
                <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: colors.amber }}>
                  {agentMap.get(epic.leadAgentId)?.name || epic.leadAgentId.slice(0, 8)}
                </Typography>
              </Box>
            )}

            {epic.createdByAgentId && (
              <Box sx={{ display: "flex", justifyContent: "space-between" }}>
                <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
                  Created By
                </Typography>
                <Typography
                  sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary" }}
                >
                  {agentMap.get(epic.createdByAgentId)?.name || epic.createdByAgentId.slice(0, 8)}
                </Typography>
              </Box>
            )}

            <Box sx={{ display: "flex", justifyContent: "space-between" }}>
              <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
                Created
              </Typography>
              <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.secondary" }}>
                {formatDate(epic.createdAt)}
              </Typography>
            </Box>

            {epic.startedAt && (
              <Box sx={{ display: "flex", justifyContent: "space-between" }}>
                <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
                  Started
                </Typography>
                <Typography
                  sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.secondary" }}
                >
                  {formatDate(epic.startedAt)}
                </Typography>
              </Box>
            )}

            {epic.completedAt && (
              <Box sx={{ display: "flex", justifyContent: "space-between" }}>
                <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
                  Completed
                </Typography>
                <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: colors.green }}>
                  {formatDate(epic.completedAt)}
                </Typography>
              </Box>
            )}
          </Box>

          {/* Tags */}
          {epic.tags && epic.tags.length > 0 && (
            <>
              <Divider sx={{ my: 2 }} />
              <Box>
                <Typography
                  sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary", mb: 1 }}
                >
                  TAGS
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
                      }}
                    >
                      {tag}
                    </Chip>
                  ))}
                </Box>
              </Box>
            </>
          )}

          {/* External Links */}
          {(epic.githubRepo || epic.researchDocPath || epic.planDocPath) && (
            <>
              <Divider sx={{ my: 2 }} />
              <Box>
                <Typography
                  sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary", mb: 1 }}
                >
                  LINKS
                </Typography>
                <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
                  {epic.githubRepo && (
                    <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: colors.blue }}>
                      GitHub: {epic.githubRepo}
                    </Typography>
                  )}
                  {epic.researchDocPath && (
                    <Typography
                      sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.secondary" }}
                    >
                      Research: {epic.researchDocPath}
                    </Typography>
                  )}
                  {epic.planDocPath && (
                    <Typography
                      sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.secondary" }}
                    >
                      Plan: {epic.planDocPath}
                    </Typography>
                  )}
                </Box>
              </Box>
            </>
          )}
        </Card>

        {/* Right Side - Tabbed Content */}
        <Card
          variant="outlined"
          sx={{
            flex: { xs: 1, lg: 2 },
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Tabs
            defaultValue="tasks"
            sx={{ height: "100%", display: "flex", flexDirection: "column" }}
          >
            <TabList
              sx={{
                px: 2,
                pt: 1,
                gap: 1,
                bgcolor: "background.level1",
                borderBottom: "1px solid",
                borderColor: "neutral.outlinedBorder",
                "& .MuiTab-root": {
                  fontFamily: "code",
                  fontSize: "0.75rem",
                  letterSpacing: "0.03em",
                  fontWeight: 600,
                  color: "text.tertiary",
                  "&.Mui-selected": {
                    color: colors.gold,
                  },
                },
              }}
            >
              <Tab value="tasks">TASKS</Tab>
              <Tab value="details">DETAILS</Tab>
            </TabList>

            {/* Tasks Tab - Kanban View */}
            <TabPanel
              value="tasks"
              sx={{
                flex: 1,
                p: 2,
                overflow: "auto",
              }}
            >
              <Box
                sx={{
                  display: "flex",
                  gap: 2,
                  minHeight: "100%",
                  overflow: "auto",
                  pb: 2,
                }}
              >
                <TaskColumn
                  title="PENDING"
                  tasks={tasksByStatus.pending}
                  color={colors.orange}
                  bgColor={colors.orangeBg}
                  onTaskClick={onNavigateToTask}
                />
                <TaskColumn
                  title="IN PROGRESS"
                  tasks={tasksByStatus.inProgress}
                  color={colors.blue}
                  bgColor={colors.blueBg}
                  onTaskClick={onNavigateToTask}
                />
                <TaskColumn
                  title="COMPLETED"
                  tasks={tasksByStatus.completed}
                  color={colors.green}
                  bgColor={colors.greenBg}
                  onTaskClick={onNavigateToTask}
                />
                <TaskColumn
                  title="FAILED"
                  tasks={tasksByStatus.failed}
                  color={colors.red}
                  bgColor={colors.redBg}
                  onTaskClick={onNavigateToTask}
                />
              </Box>
            </TabPanel>

            {/* Details Tab - PRD and Plan */}
            <TabPanel
              value="details"
              sx={{
                flex: 1,
                p: 2,
                overflow: "auto",
              }}
            >
              <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {/* PRD Section */}
                <Box>
                  <Typography
                    sx={{
                      fontFamily: "code",
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      color: colors.gold,
                      letterSpacing: "0.05em",
                      mb: 1,
                    }}
                  >
                    PRODUCT REQUIREMENTS (PRD)
                  </Typography>
                  <ContentViewer content={epic.prd} label="PRD" />
                </Box>

                {/* Plan Section */}
                <Box>
                  <Typography
                    sx={{
                      fontFamily: "code",
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      color: colors.gold,
                      letterSpacing: "0.05em",
                      mb: 1,
                    }}
                  >
                    IMPLEMENTATION PLAN
                  </Typography>
                  <ContentViewer content={epic.plan} label="plan" />
                </Box>
              </Box>
            </TabPanel>
          </Tabs>
        </Card>
      </Box>
    </Box>
  );
}

import { useState, useCallback } from "react";
import Box from "@mui/joy/Box";
import Typography from "@mui/joy/Typography";
import IconButton from "@mui/joy/IconButton";
import Divider from "@mui/joy/Divider";
import Tooltip from "@mui/joy/Tooltip";
import Tabs from "@mui/joy/Tabs";
import TabList from "@mui/joy/TabList";
import Tab from "@mui/joy/Tab";
import TabPanel from "@mui/joy/TabPanel";
import Chip from "@mui/joy/Chip";
import { useColorScheme } from "@mui/joy/styles";
import { useTask, useAgents } from "../hooks/queries";
import { formatRelativeTime } from "../lib/utils";
import StatusBadge from "./StatusBadge";

interface TaskDetailPanelProps {
  taskId: string;
  onClose: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

export default function TaskDetailPanel({
  taskId,
  onClose,
  expanded = false,
  onToggleExpand,
}: TaskDetailPanelProps) {
  const { data: task, isLoading: taskLoading } = useTask(taskId);
  const { data: agents } = useAgents();
  const { mode } = useColorScheme();
  const isDark = mode === "dark";
  const [outputTab, setOutputTab] = useState<"output" | "error">("output");
  const [copiedField, setCopiedField] = useState<"output" | "error" | null>(null);

  const handleCopy = useCallback(async (content: string, field: "output" | "error") => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, []);

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
    rust: isDark ? "#A85454" : "#B54242",
    blue: "#3B82F6",
    purple: isDark ? "#9370DB" : "#6B5B95",
    warmGray: isDark ? "#C9B896" : "#8B7355",
    tertiary: isDark ? "#8B7355" : "#6B5344",
    closeBtn: isDark ? "#8B7355" : "#5C4A3D",
    closeBtnHover: isDark ? "#FFF8E7" : "#1A130E",
    goldGlow: isDark ? "0 0 8px rgba(212, 165, 116, 0.5)" : "0 0 6px rgba(139, 105, 20, 0.3)",
    goldSoftBg: isDark ? "rgba(212, 165, 116, 0.1)" : "rgba(139, 105, 20, 0.08)",
    goldBorder: isDark ? "rgba(212, 165, 116, 0.3)" : "rgba(139, 105, 20, 0.25)",
    hoverBg: isDark ? "rgba(245, 166, 35, 0.05)" : "rgba(212, 136, 6, 0.05)",
  };

  const getSourceColor = (source: string) => {
    switch (source) {
      case "mcp": return colors.amber;
      case "slack": return colors.purple;
      case "api": return colors.blue;
      default: return colors.tertiary;
    }
  };

  const agentName = agents?.find((a) => a.id === task?.agentId)?.name || task?.agentId?.slice(0, 8);

  const getElapsedTime = () => {
    if (!task) return "—";
    const start = new Date(task.createdAt).getTime();
    const end = task.finishedAt
      ? new Date(task.finishedAt).getTime()
      : Date.now();
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
  };

  const panelWidth = expanded ? "100%" : 450;

  const loadingContent = (
    <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
      Loading task...
    </Typography>
  );

  const notFoundContent = (
    <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
      Task not found
    </Typography>
  );

  if (taskLoading || !task) {
    return (
      <Box
        sx={{
          width: panelWidth,
          height: "100%",
          bgcolor: "background.surface",
          border: "1px solid",
          borderColor: "neutral.outlinedBorder",
          borderRadius: "12px",
          p: 3,
          overflow: "auto",
        }}
      >
        {taskLoading ? loadingContent : notFoundContent}
      </Box>
    );
  }

  const progressLogs = task.logs?.filter((log) => log.eventType === "task_progress") || [];
  const hasOutput = !!task.output;
  const hasError = !!task.failureReason;
  const hasBothOutputAndError = hasOutput && hasError;

  // Details section - task info
  const DetailsSection = ({ showProgress = true }: { showProgress?: boolean }) => (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", ...(showProgress ? {} : { height: "100%" }) }}>
      {/* Info fields first */}
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, flexShrink: 0, mb: 2 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Status
          </Typography>
          <StatusBadge status={task.status} />
        </Box>

        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Agent
          </Typography>
          <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: task.agentId ? colors.amber : "text.tertiary" }}>
            {task.agentId ? agentName : "Unassigned"}
          </Typography>
        </Box>

        {task.source && (
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
              Source
            </Typography>
            <Chip
              size="sm"
              variant="soft"
              sx={{
                fontFamily: "code",
                fontSize: "0.65rem",
                color: getSourceColor(task.source),
                bgcolor: isDark ? "rgba(100, 100, 100, 0.15)" : "rgba(150, 150, 150, 0.12)",
                textTransform: "uppercase",
              }}
            >
              {task.source}
            </Chip>
          </Box>
        )}

        {task.taskType && (
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
              Type
            </Typography>
            <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: "text.secondary" }}>
              {task.taskType}
            </Typography>
          </Box>
        )}

        {task.tags && task.tags.length > 0 && (
          <Box>
            <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary", mb: 0.5 }}>
              Tags
            </Typography>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
              {task.tags.map((tag) => (
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

        {task.priority !== undefined && task.priority !== 50 && (
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
              Priority
            </Typography>
            <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: task.priority > 50 ? colors.amber : "text.secondary" }}>
              {task.priority}
            </Typography>
          </Box>
        )}

        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Elapsed Time
          </Typography>
          <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: "text.secondary" }}>
            {getElapsedTime()}
          </Typography>
        </Box>

        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Created
          </Typography>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary" }}>
            {new Date(task.createdAt).toLocaleString()}
          </Typography>
        </Box>

        {task.finishedAt && (
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
              Finished
            </Typography>
            <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary" }}>
              {new Date(task.finishedAt).toLocaleString()}
            </Typography>
          </Box>
        )}
      </Box>

      {/* Task description */}
      <Box
        sx={{
          p: 1.5,
          mb: 2,
          bgcolor: "background.level1",
          borderRadius: 1,
          border: "1px solid",
          borderColor: "neutral.outlinedBorder",
          flexShrink: 0,
        }}
      >
        <Typography
          sx={{
            fontFamily: "code",
            fontSize: "0.8rem",
            color: "text.primary",
            lineHeight: 1.5,
            wordBreak: "break-word",
          }}
        >
          {task.task}
        </Typography>
      </Box>

      {/* Progress Logs - only in collapsed mode */}
      {showProgress && progressLogs.length > 0 && (
        <>
          <Divider sx={{ my: 2, bgcolor: "neutral.outlinedBorder", flexShrink: 0 }} />
          <Box sx={{ display: "flex", flexDirection: "column" }}>
            <Typography
              sx={{
                fontFamily: "code",
                fontSize: "0.7rem",
                color: "text.tertiary",
                letterSpacing: "0.05em",
                mb: 1,
                flexShrink: 0,
              }}
            >
              PROGRESS ({progressLogs.length})
            </Typography>
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                gap: 1,
              }}
            >
              {progressLogs.map((log) => (
                <Box
                  key={log.id}
                  sx={{
                    bgcolor: "background.level1",
                    p: 1.5,
                    borderRadius: 1,
                    border: "1px solid",
                    borderColor: "neutral.outlinedBorder",
                    flexShrink: 0,
                  }}
                >
                  <Typography
                    sx={{
                      fontFamily: "code",
                      fontSize: "0.75rem",
                      color: "text.secondary",
                      mb: 0.5,
                    }}
                  >
                    {log.newValue || "Progress update"}
                  </Typography>
                  <Typography
                    sx={{
                      fontFamily: "code",
                      fontSize: "0.6rem",
                      color: "text.tertiary",
                    }}
                  >
                    {formatRelativeTime(log.createdAt)}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        </>
      )}
    </Box>
  );

  // Progress section for expanded view
  const ProgressSection = () => (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", height: "100%" }}>
      <Typography
        sx={{
          fontFamily: "code",
          fontSize: "0.7rem",
          color: "text.tertiary",
          letterSpacing: "0.05em",
          mb: 1,
          flexShrink: 0,
        }}
      >
        PROGRESS ({progressLogs.length})
      </Typography>
      {progressLogs.length === 0 ? (
        <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
          No progress updates
        </Typography>
      ) : (
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            flex: 1,
            overflow: "auto",
          }}
        >
          {progressLogs.map((log) => (
            <Box
              key={log.id}
              sx={{
                bgcolor: "background.level1",
                p: 1.5,
                borderRadius: 1,
                border: "1px solid",
                borderColor: "neutral.outlinedBorder",
                flexShrink: 0,
              }}
            >
              <Typography
                sx={{
                  fontFamily: "code",
                  fontSize: "0.75rem",
                  color: "text.secondary",
                  mb: 0.5,
                }}
              >
                {log.newValue || "Progress update"}
              </Typography>
              <Typography
                sx={{
                  fontFamily: "code",
                  fontSize: "0.6rem",
                  color: "text.tertiary",
                }}
              >
                {formatRelativeTime(log.createdAt)}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );

  // Copy button component
  const CopyButton = ({ content, field }: { content: string; field: "output" | "error" }) => (
    <Tooltip title={copiedField === field ? "Copied!" : "Copy to clipboard"} placement="left">
      <IconButton
        size="sm"
        variant="plain"
        onClick={() => handleCopy(content, field)}
        sx={{
          color: copiedField === field ? colors.amber : colors.closeBtn,
          "&:hover": { color: colors.closeBtnHover, bgcolor: colors.hoverBg },
        }}
      >
        {copiedField === field ? "✓" : "⧉"}
      </IconButton>
    </Tooltip>
  );

  // Output content
  const OutputContent = () => (
    <Box sx={{ flex: 1, overflow: "auto", p: 2, position: "relative" }}>
      {hasOutput ? (
        <>
          <Box sx={{ position: "absolute", top: 8, right: 8, zIndex: 1 }}>
            <CopyButton content={task.output!} field="output" />
          </Box>
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              color: colors.gold,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              pr: 4,
            }}
          >
            {task.output}
          </Typography>
        </>
      ) : (
        <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
          No output yet
        </Typography>
      )}
    </Box>
  );

  // Error content
  const ErrorContent = () => (
    <Box sx={{ flex: 1, overflow: "auto", p: 2, position: "relative" }}>
      <Box sx={{ position: "absolute", top: 8, right: 8, zIndex: 1 }}>
        <CopyButton content={task.failureReason!} field="error" />
      </Box>
      <Typography
        sx={{
          fontFamily: "code",
          fontSize: "0.75rem",
          color: colors.rust,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          pr: 4,
        }}
      >
        {task.failureReason}
      </Typography>
    </Box>
  );

  // Get tab list styles with dynamic selected color
  const getTabListStyles = (selectedColor: string, hasBorderTop = false) => ({
    gap: 0.5,
    bgcolor: "background.level1",
    borderBottom: "1px solid",
    borderColor: "neutral.outlinedBorder",
    borderTop: hasBorderTop ? "1px solid" : "none",
    px: 2,
    pt: 1,
    flexShrink: 0,
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
      px: 2,
      py: 0.75,
      minHeight: "auto",
      transition: "all 0.2s ease",
      "&:hover": {
        color: "text.secondary",
        bgcolor: colors.hoverBg,
      },
      "&.Mui-selected": {
        color: selectedColor,
        bgcolor: "background.surface",
        borderColor: "neutral.outlinedBorder",
        borderBottomColor: "background.surface",
        marginBottom: "-1px",
      },
    },
  });

  // Output/Error section for expanded view (with tabs if both present)
  const OutputSection = () => {
    if (hasBothOutputAndError) {
      return (
        <Tabs
          value={outputTab}
          onChange={(_, value) => setOutputTab(value as "output" | "error")}
          sx={{ display: "flex", flexDirection: "column", height: "100%" }}
        >
          <TabList sx={getTabListStyles(outputTab === "error" ? colors.rust : colors.gold)}>
            <Tab value="output">OUTPUT</Tab>
            <Tab value="error">ERROR</Tab>
          </TabList>
          <TabPanel value="output" sx={{ p: 0, flex: 1, overflow: "hidden" }}>
            <OutputContent />
          </TabPanel>
          <TabPanel value="error" sx={{ p: 0, flex: 1, overflow: "hidden" }}>
            <ErrorContent />
          </TabPanel>
        </Tabs>
      );
    }

    if (hasError) {
      return (
        <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Box sx={{ px: 2, py: 1.5, bgcolor: "background.level1", flexShrink: 0 }}>
            <Typography
              sx={{
                fontFamily: "code",
                fontSize: "0.7rem",
                color: colors.rust,
                letterSpacing: "0.05em",
              }}
            >
              ERROR
            </Typography>
          </Box>
          <ErrorContent />
        </Box>
      );
    }

    return (
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <Box sx={{ px: 2, py: 1.5, bgcolor: "background.level1", flexShrink: 0 }}>
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.7rem",
              color: "text.tertiary",
              letterSpacing: "0.05em",
            }}
          >
            OUTPUT
          </Typography>
        </Box>
        <OutputContent />
      </Box>
    );
  };

  // Collapsed output section
  const CollapsedOutputSection = () => {
    if (hasOutput || hasError) {
      if (hasBothOutputAndError) {
        return (
          <Tabs
            value={outputTab}
            onChange={(_, value) => setOutputTab(value as "output" | "error")}
            sx={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}
          >
            <TabList sx={getTabListStyles(outputTab === "error" ? colors.rust : colors.gold, true)}>
              <Tab value="output">OUTPUT</Tab>
              <Tab value="error">ERROR</Tab>
            </TabList>
            <TabPanel value="output" sx={{ p: 0, flex: 1, overflow: "hidden" }}>
              <OutputContent />
            </TabPanel>
            <TabPanel value="error" sx={{ p: 0, flex: 1, overflow: "hidden" }}>
              <ErrorContent />
            </TabPanel>
          </Tabs>
        );
      }

      if (hasError) {
        return (
          <Box sx={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
            <Box sx={{ px: 2, py: 1.5, bgcolor: "background.level1", borderTop: "1px solid", borderColor: "neutral.outlinedBorder", flexShrink: 0 }}>
              <Typography
                sx={{
                  fontFamily: "code",
                  fontSize: "0.7rem",
                  color: colors.rust,
                  letterSpacing: "0.05em",
                }}
              >
                ERROR
              </Typography>
            </Box>
            <ErrorContent />
          </Box>
        );
      }

      return (
        <Box sx={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
          <Box sx={{ px: 2, py: 1.5, bgcolor: "background.level1", borderTop: "1px solid", borderColor: "neutral.outlinedBorder", flexShrink: 0 }}>
            <Typography
              sx={{
                fontFamily: "code",
                fontSize: "0.7rem",
                color: "text.tertiary",
                letterSpacing: "0.05em",
              }}
            >
              OUTPUT
            </Typography>
          </Box>
          <OutputContent />
        </Box>
      );
    }

    return null;
  };

  return (
    <Box
      sx={{
        width: panelWidth,
        height: "100%",
        bgcolor: "background.surface",
        border: "1px solid",
        borderColor: "neutral.outlinedBorder",
        borderRadius: "12px",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          px: 2,
          py: 1.5,
          borderBottom: "1px solid",
          borderColor: "neutral.outlinedBorder",
          bgcolor: "background.level1",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderRadius: "12px 12px 0 0",
          flexShrink: 0,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
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
            sx={{
              fontFamily: "display",
              fontWeight: 600,
              color: colors.gold,
              letterSpacing: "0.03em",
            }}
          >
            TASK DETAILS
          </Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
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

      {/* Content */}
      <Box
        sx={{
          flex: 1,
          overflow: "hidden",
          display: "flex",
          flexDirection: expanded ? "row" : "column",
        }}
      >
        {expanded ? (
          <>
            {/* Column 1: Details */}
            <Box
              sx={{
                width: 350,
                flexShrink: 0,
                borderRight: "1px solid",
                borderColor: "neutral.outlinedBorder",
                overflow: "auto",
              }}
            >
              <DetailsSection showProgress={false} />
            </Box>
            {/* Column 2: Progress */}
            <Box
              sx={{
                width: 350,
                flexShrink: 0,
                borderRight: "1px solid",
                borderColor: "neutral.outlinedBorder",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <ProgressSection />
            </Box>
            {/* Column 3: Output/Error */}
            <Box
              sx={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <OutputSection />
            </Box>
          </>
        ) : (
          <Box sx={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
            <DetailsSection showProgress={true} />
            <CollapsedOutputSection />
          </Box>
        )}
      </Box>
    </Box>
  );
}

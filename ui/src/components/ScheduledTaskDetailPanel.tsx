import Box from "@mui/joy/Box";
import Chip from "@mui/joy/Chip";
import Divider from "@mui/joy/Divider";
import IconButton from "@mui/joy/IconButton";
import { useColorScheme } from "@mui/joy/styles";
import Tooltip from "@mui/joy/Tooltip";
import Typography from "@mui/joy/Typography";
import { useAgents, useScheduledTasks } from "../hooks/queries";

interface ScheduledTaskDetailPanelProps {
  scheduleId: string;
  onClose: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

function formatInterval(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days} day${days > 1 ? "s" : ""} ${hours % 24} hour${hours % 24 !== 1 ? "s" : ""}`;
  } else if (hours > 0) {
    return `${hours} hour${hours > 1 ? "s" : ""} ${minutes % 60} minute${minutes % 60 !== 1 ? "s" : ""}`;
  } else if (minutes > 0) {
    return `${minutes} minute${minutes > 1 ? "s" : ""}`;
  }
  return `${seconds} second${seconds !== 1 ? "s" : ""}`;
}

function formatDateTime(dateStr: string | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleString();
}

function formatNextRun(dateStr: string | undefined): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);

  if (diffMs < 0) return "overdue";
  if (diffMins < 1) return "< 1 minute";
  if (diffMins < 60) return `in ${diffMins} minute${diffMins > 1 ? "s" : ""}`;
  if (diffHours < 24) return `in ${diffHours}h ${diffMins % 60}m`;

  return date.toLocaleString();
}

export default function ScheduledTaskDetailPanel({
  scheduleId,
  onClose,
  expanded = false,
  onToggleExpand,
}: ScheduledTaskDetailPanelProps) {
  const { data: schedules, isLoading } = useScheduledTasks();
  const { data: agents } = useAgents();
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const schedule = schedules?.find((s) => s.id === scheduleId);
  const targetAgent = schedule?.targetAgentId
    ? agents?.find((a) => a.id === schedule.targetAgentId)
    : undefined;
  const creatorAgent = schedule?.createdByAgentId
    ? agents?.find((a) => a.id === schedule.createdByAgentId)
    : undefined;

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
    green: isDark ? "#4CAF50" : "#2E7D32",
    red: isDark ? "#EF5350" : "#D32F2F",
    blue: "#3B82F6",
    tertiary: isDark ? "#8B7355" : "#6B5344",
    closeBtn: isDark ? "#8B7355" : "#5C4A3D",
    closeBtnHover: isDark ? "#FFF8E7" : "#1A130E",
    goldGlow: isDark ? "0 0 8px rgba(212, 165, 116, 0.5)" : "0 0 6px rgba(139, 105, 20, 0.3)",
    goldSoftBg: isDark ? "rgba(212, 165, 116, 0.1)" : "rgba(139, 105, 20, 0.08)",
    goldBorder: isDark ? "rgba(212, 165, 116, 0.3)" : "rgba(139, 105, 20, 0.25)",
    hoverBg: isDark ? "rgba(245, 166, 35, 0.05)" : "rgba(212, 136, 6, 0.05)",
  };

  const panelWidth = expanded ? "100%" : 450;

  const loadingContent = (
    <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>Loading schedule...</Typography>
  );

  const notFoundContent = (
    <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>Schedule not found</Typography>
  );

  if (isLoading || !schedule) {
    return (
      <Box
        sx={{
          position: { xs: "fixed", md: "relative" },
          inset: { xs: 0, md: "auto" },
          zIndex: { xs: 1300, md: "auto" },
          width: { xs: "100%", md: panelWidth },
          height: "100%",
          bgcolor: "background.surface",
          border: { xs: "none", md: "1px solid" },
          borderColor: "neutral.outlinedBorder",
          borderRadius: { xs: 0, md: "12px" },
          p: { xs: 2, md: 3 },
          overflow: "auto",
        }}
      >
        {isLoading ? loadingContent : notFoundContent}
      </Box>
    );
  }

  return (
    <Box
      sx={{
        position: { xs: "fixed", md: "relative" },
        inset: { xs: 0, md: "auto" },
        zIndex: { xs: 1300, md: "auto" },
        width: { xs: "100%", md: expanded ? "100%" : 450 },
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
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
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
            <span style={{ fontSize: "1.2rem" }}>&#8592;</span>
          </IconButton>
          <Box
            sx={{
              width: 8,
              height: 10,
              clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
              bgcolor: colors.gold,
              boxShadow: colors.goldGlow,
              display: { xs: "none", md: "block" },
            }}
          />
          <Typography
            sx={{
              fontFamily: "display",
              fontWeight: 600,
              color: colors.gold,
              letterSpacing: "0.03em",
              fontSize: { xs: "0.9rem", md: "1rem" },
            }}
          >
            SCHEDULE DETAILS
          </Typography>
        </Box>
        {/* Desktop buttons */}
        <Box sx={{ display: { xs: "none", md: "flex" }, alignItems: "center", gap: 0.5 }}>
          {onToggleExpand && (
            <Tooltip
              title={expanded ? "Collapse panel" : "Expand to full width"}
              placement="bottom"
            >
              <IconButton
                size="sm"
                variant="plain"
                onClick={onToggleExpand}
                sx={{
                  color: colors.closeBtn,
                  "&:hover": { color: colors.closeBtnHover, bgcolor: colors.hoverBg },
                }}
              >
                {expanded ? "\u229F" : "\u229E"}
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
              <span style={{ fontSize: "1rem" }}>&#10005;</span>
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Content */}
      <Box
        sx={{
          flex: 1,
          overflow: "auto",
          display: "flex",
          flexDirection: expanded ? { xs: "column", md: "row" } : "column",
        }}
      >
        {/* Main Details */}
        <Box
          sx={{
            p: { xs: 1.5, md: 2 },
            flex: expanded ? { xs: "none", md: 1 } : 1,
            borderRight: expanded ? { xs: "none", md: "1px solid" } : "none",
            borderBottom: expanded ? { xs: "1px solid", md: "none" } : "none",
            borderColor: "neutral.outlinedBorder",
            overflow: "auto",
          }}
        >
          {/* Schedule name and status */}
          <Box sx={{ mb: 2 }}>
            <Box
              sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 1 }}
            >
              <Typography
                sx={{
                  fontFamily: "code",
                  fontSize: "1.1rem",
                  fontWeight: 600,
                  color: "text.primary",
                }}
              >
                {schedule.name}
              </Typography>
              <Chip
                size="sm"
                variant="soft"
                sx={{
                  fontFamily: "code",
                  fontSize: "0.65rem",
                  bgcolor: schedule.enabled
                    ? isDark
                      ? "rgba(76, 175, 80, 0.15)"
                      : "rgba(46, 125, 50, 0.1)"
                    : isDark
                      ? "rgba(239, 83, 80, 0.15)"
                      : "rgba(211, 47, 47, 0.1)",
                  color: schedule.enabled ? colors.green : colors.red,
                }}
              >
                {schedule.enabled ? "ENABLED" : "DISABLED"}
              </Chip>
            </Box>
            {schedule.description && (
              <Typography
                sx={{
                  fontFamily: "code",
                  fontSize: "0.8rem",
                  color: "text.secondary",
                  lineHeight: 1.5,
                }}
              >
                {schedule.description}
              </Typography>
            )}
          </Box>

          <Divider sx={{ my: 2, bgcolor: "neutral.outlinedBorder" }} />

          {/* Info fields */}
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            {/* Schedule Type */}
            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
                Schedule
              </Typography>
              <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: colors.amber }}>
                {schedule.cronExpression
                  ? `Cron: ${schedule.cronExpression}`
                  : schedule.intervalMs
                    ? `Every ${formatInterval(schedule.intervalMs)}`
                    : "—"}
              </Typography>
            </Box>

            {/* Timezone */}
            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
                Timezone
              </Typography>
              <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: "text.secondary" }}>
                {schedule.timezone}
              </Typography>
            </Box>

            {/* Target Agent */}
            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
                Target
              </Typography>
              <Typography
                sx={{
                  fontFamily: "code",
                  fontSize: "0.8rem",
                  color: schedule.targetAgentId ? colors.amber : "text.secondary",
                }}
              >
                {targetAgent?.name ||
                  (schedule.targetAgentId ? schedule.targetAgentId.slice(0, 8) : "Task Pool")}
              </Typography>
            </Box>

            {/* Priority */}
            {schedule.priority !== 50 && (
              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Typography
                  sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}
                >
                  Priority
                </Typography>
                <Typography
                  sx={{
                    fontFamily: "code",
                    fontSize: "0.8rem",
                    color: schedule.priority > 50 ? colors.amber : "text.secondary",
                  }}
                >
                  {schedule.priority}
                </Typography>
              </Box>
            )}

            {/* Task Type */}
            {schedule.taskType && (
              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Typography
                  sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}
                >
                  Task Type
                </Typography>
                <Typography
                  sx={{ fontFamily: "code", fontSize: "0.8rem", color: "text.secondary" }}
                >
                  {schedule.taskType}
                </Typography>
              </Box>
            )}

            {/* Tags */}
            {schedule.tags && schedule.tags.length > 0 && (
              <Box>
                <Typography
                  sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary", mb: 0.5 }}
                >
                  Tags
                </Typography>
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                  {schedule.tags.map((tag) => (
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

            <Divider sx={{ my: 1, bgcolor: "neutral.outlinedBorder" }} />

            {/* Timing */}
            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
                Last Run
              </Typography>
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary" }}>
                {formatDateTime(schedule.lastRunAt)}
              </Typography>
            </Box>

            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
                Next Run
              </Typography>
              <Typography
                sx={{
                  fontFamily: "code",
                  fontSize: "0.75rem",
                  color: schedule.enabled ? colors.amber : "text.tertiary",
                }}
              >
                {schedule.enabled ? formatNextRun(schedule.nextRunAt) : "Disabled"}
              </Typography>
            </Box>

            <Divider sx={{ my: 1, bgcolor: "neutral.outlinedBorder" }} />

            {/* Created By */}
            {schedule.createdByAgentId && (
              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Typography
                  sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}
                >
                  Created By
                </Typography>
                <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: colors.amber }}>
                  {creatorAgent?.name || schedule.createdByAgentId.slice(0, 8)}
                </Typography>
              </Box>
            )}

            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
                Created
              </Typography>
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary" }}>
                {formatDateTime(schedule.createdAt)}
              </Typography>
            </Box>

            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
                Updated
              </Typography>
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary" }}>
                {formatDateTime(schedule.lastUpdatedAt)}
              </Typography>
            </Box>
          </Box>
        </Box>

        {/* Task Template */}
        <Box
          sx={{
            p: { xs: 1.5, md: 2 },
            flex: expanded ? { xs: "none", md: 1 } : "none",
            display: "flex",
            flexDirection: "column",
            overflow: "auto",
          }}
        >
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
            TASK TEMPLATE
          </Typography>
          <Box
            sx={{
              p: 1.5,
              bgcolor: "background.level1",
              borderRadius: 1,
              border: "1px solid",
              borderColor: "neutral.outlinedBorder",
              flex: expanded ? 1 : "none",
              overflow: "auto",
            }}
          >
            <Typography
              sx={{
                fontFamily: "code",
                fontSize: "0.8rem",
                color: "text.primary",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {schedule.taskTemplate}
            </Typography>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

import Box from "@mui/joy/Box";
import Button from "@mui/joy/Button";
import Chip from "@mui/joy/Chip";
import Divider from "@mui/joy/Divider";
import IconButton from "@mui/joy/IconButton";
import { useColorScheme } from "@mui/joy/styles";
import Tooltip from "@mui/joy/Tooltip";
import Typography from "@mui/joy/Typography";
import { useState } from "react";
import { useAgent, useAgentUsageSummary, useLogs, useSessionCosts } from "../hooks/queries";
import { formatCompactNumber, formatCurrency, formatRelativeTime } from "../lib/utils";
import type { AgentLog } from "../types/api";
import EditAgentProfileModal from "./EditAgentProfileModal";
import StatusBadge from "./StatusBadge";
import { CostTrendChart, ModelUsageChart, TokenDistributionChart } from "./UsageCharts";

interface AgentDetailPanelProps {
  agentId: string;
  onClose: () => void;
  onGoToTasks: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

export default function AgentDetailPanel({
  agentId,
  onClose,
  onGoToTasks,
  expanded = false,
  onToggleExpand,
}: AgentDetailPanelProps) {
  const { data: agent, isLoading: agentLoading } = useAgent(agentId);
  const { data: logs, isLoading: logsLoading } = useLogs(20, agentId);
  const { data: usage } = useAgentUsageSummary(agentId);
  const { data: agentCosts } = useSessionCosts({ agentId, limit: 500 });
  const { mode } = useColorScheme();
  const isDark = mode === "dark";
  const [editProfileOpen, setEditProfileOpen] = useState(false);

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
    dormant: isDark ? "#6B5344" : "#A89A7C",
    honey: isDark ? "#FFB84D" : "#B87300",
    blue: "#3B82F6",
    warmGray: isDark ? "#C9B896" : "#8B7355",
    tertiary: isDark ? "#8B7355" : "#6B5344",
    closeBtn: isDark ? "#8B7355" : "#5C4A3D",
    closeBtnHover: isDark ? "#FFF8E7" : "#1A130E",
    amberGlow: isDark ? "0 0 8px rgba(245, 166, 35, 0.5)" : "0 0 6px rgba(212, 136, 6, 0.3)",
    amberSoftBg: isDark ? "rgba(245, 166, 35, 0.1)" : "rgba(212, 136, 6, 0.08)",
    amberBorder: isDark ? "rgba(245, 166, 35, 0.3)" : "rgba(212, 136, 6, 0.25)",
    hoverBg: isDark ? "rgba(245, 166, 35, 0.05)" : "rgba(212, 136, 6, 0.05)",
  };

  const getEventColor = (eventType: string) => {
    switch (eventType) {
      case "agent_joined":
        return colors.amber;
      case "agent_left":
        return colors.dormant;
      case "agent_status_change":
        return colors.honey;
      case "task_created":
        return colors.blue;
      case "task_status_change":
        return colors.gold;
      case "task_progress":
        return colors.warmGray;
      default:
        return colors.tertiary;
    }
  };

  const formatEventText = (log: AgentLog) => {
    switch (log.eventType) {
      case "agent_joined":
        return "Joined the swarm";
      case "agent_left":
        return "Left the swarm";
      case "agent_status_change":
        return `Updated status to ${log.newValue}`;
      case "task_created":
        return "New task assigned";
      case "task_status_change":
        return `Task ${log.taskId?.slice(0, 8)}: updated status to ${log.newValue}`;
      case "task_progress":
        return `Progress: ${log.newValue}`;
      default:
        return log.eventType;
    }
  };

  const panelWidth = expanded ? "100%" : 400;

  const loadingContent = (
    <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>Loading agent...</Typography>
  );

  const notFoundContent = (
    <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>Agent not found</Typography>
  );

  if (agentLoading || !agent) {
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
        {agentLoading ? loadingContent : notFoundContent}
      </Box>
    );
  }

  const activeTasks =
    agent.tasks?.filter((t) => t.status === "pending" || t.status === "in_progress").length || 0;

  // Info section component
  const InfoSection = () => (
    <Box sx={{ p: { xs: 1.5, md: 2 } }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 2 }}>
        <Box
          sx={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            bgcolor:
              agent.status === "busy"
                ? colors.amber
                : agent.status === "idle"
                  ? colors.gold
                  : colors.dormant,
            boxShadow: agent.status === "busy" ? colors.amberGlow : "none",
          }}
        />
        <Typography
          sx={{
            fontFamily: "code",
            fontWeight: 600,
            fontSize: "1.1rem",
            color: agent.isLead ? colors.amber : "text.primary",
            whiteSpace: "nowrap",
          }}
        >
          {agent.name}
        </Typography>
        {agent.isLead && (
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.6rem",
              color: colors.amber,
              bgcolor: colors.amberSoftBg,
              px: 0.75,
              py: 0.25,
              borderRadius: 1,
              border: `1px solid ${colors.amberBorder}`,
            }}
          >
            LEAD
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Edit profile" placement="bottom">
          <IconButton
            size="sm"
            variant="plain"
            onClick={() => setEditProfileOpen(true)}
            sx={{
              fontFamily: "code",
              fontSize: "0.7rem",
              color: colors.closeBtn,
              "&:hover": { color: colors.amber, bgcolor: colors.hoverBg },
            }}
          >
            ✎
          </IconButton>
        </Tooltip>
      </Box>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Status
          </Typography>
          <StatusBadge status={agent.status} />
        </Box>

        {agent.role && (
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
              Role
            </Typography>
            <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: "text.secondary" }}>
              {agent.role}
            </Typography>
          </Box>
        )}

        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Active Tasks
          </Typography>
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.8rem",
              color: activeTasks > 0 ? colors.amber : "text.secondary",
            }}
          >
            {activeTasks}
          </Typography>
        </Box>

        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Total Tasks
          </Typography>
          <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: "text.secondary" }}>
            {agent.tasks?.length || 0}
          </Typography>
        </Box>

        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Last Update
          </Typography>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary" }}>
            {new Date(agent.lastUpdatedAt).toLocaleString()}
          </Typography>
        </Box>

        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Joined
          </Typography>
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary" }}>
            {new Date(agent.createdAt).toLocaleString()}
          </Typography>
        </Box>

        <Box>
          <Typography
            sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary", mb: 0.5 }}
          >
            Capabilities
          </Typography>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
            {agent.capabilities &&
              agent.capabilities?.map((cap) => (
                <Chip
                  key={cap}
                  size="sm"
                  variant="soft"
                  sx={{
                    fontFamily: "code",
                    fontSize: "0.65rem",
                    bgcolor: colors.amberSoftBg,
                    color: colors.gold,
                    border: `1px solid ${colors.amberBorder}`,
                  }}
                >
                  {cap}
                </Chip>
              ))}
            {!agent.capabilities ||
              (agent.capabilities.length === 0 && (
                <Typography
                  sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary" }}
                >
                  No capabilities listed
                </Typography>
              ))}
          </Box>
        </Box>

        {agent.description && (
          <Box>
            <Typography
              sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary", mb: 0.5 }}
            >
              Description
            </Typography>
            <Box
              sx={{
                bgcolor: "background.level1",
                borderRadius: 1,
                p: 1,
                border: "1px solid",
                borderColor: "neutral.outlinedBorder",
                maxHeight: 450,
                overflow: "auto",
                height: "auto",
                whiteSpace: "pre-wrap",
                wordWrap: "break-word",
              }}
            >
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.secondary" }}>
                {agent.description}
              </Typography>
            </Box>
          </Box>
        )}
      </Box>

      <Button
        variant="outlined"
        size="sm"
        onClick={onGoToTasks}
        sx={{
          mt: 2,
          width: "100%",
          fontFamily: "code",
          fontSize: "0.75rem",
          borderColor: "neutral.outlinedBorder",
          color: "text.secondary",
          "&:hover": {
            borderColor: colors.amber,
            color: colors.amber,
            bgcolor: colors.hoverBg,
          },
        }}
      >
        VIEW TASKS →
      </Button>
    </Box>
  );

  // Usage card helper component
  const UsageCard = ({
    title,
    cost,
    tokens,
    sessions,
    color,
  }: {
    title: string;
    cost: number;
    tokens: number;
    sessions: number;
    color: string;
  }) => (
    <Box
      sx={{
        bgcolor: "background.level1",
        border: "1px solid",
        borderColor: "neutral.outlinedBorder",
        borderRadius: 1,
        p: 1.5,
      }}
    >
      <Typography
        sx={{
          fontFamily: "code",
          fontSize: "0.6rem",
          color: "text.tertiary",
          letterSpacing: "0.05em",
          mb: 0.5,
        }}
      >
        {title}
      </Typography>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
        <Typography sx={{ fontFamily: "code", fontSize: "1rem", fontWeight: 600, color }}>
          {formatCurrency(cost)}
        </Typography>
        <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.secondary" }}>
          {formatCompactNumber(tokens)} tokens
        </Typography>
      </Box>
      <Typography sx={{ fontFamily: "code", fontSize: "0.6rem", color: "text.tertiary", mt: 0.5 }}>
        {sessions} session{sessions !== 1 ? "s" : ""}
      </Typography>
    </Box>
  );

  // Usage section component
  const UsageSection = () => (
    <Box sx={{ p: { xs: 1.5, md: 2 } }}>
      <Typography
        sx={{
          fontFamily: "code",
          fontSize: "0.7rem",
          color: "text.tertiary",
          letterSpacing: "0.05em",
          mb: 1.5,
        }}
      >
        USAGE BREAKDOWN
      </Typography>

      {!usage ? (
        <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
          Loading usage data...
        </Typography>
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {/* Daily */}
          <UsageCard
            title="TODAY"
            cost={usage.daily.totalCostUsd}
            tokens={usage.daily.totalTokens}
            sessions={usage.daily.sessionCount}
            color={colors.amber}
          />

          {/* Weekly */}
          <UsageCard
            title="THIS WEEK"
            cost={usage.weekly.totalCostUsd}
            tokens={usage.weekly.totalTokens}
            sessions={usage.weekly.sessionCount}
            color={colors.gold}
          />

          {/* Monthly */}
          <UsageCard
            title="THIS MONTH"
            cost={usage.monthly.totalCostUsd}
            tokens={usage.monthly.totalTokens}
            sessions={usage.monthly.sessionCount}
            color={colors.blue}
          />
        </Box>
      )}
    </Box>
  );

  // Charts section component (for expanded view)
  const ChartsSection = () => (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 3 }}>
      <Typography
        sx={{
          fontFamily: "code",
          fontSize: "0.7rem",
          color: "text.tertiary",
          letterSpacing: "0.05em",
        }}
      >
        USAGE ANALYTICS
      </Typography>

      {agentCosts && agentCosts.length > 0 ? (
        <>
          <CostTrendChart costs={agentCosts} timeRange="30d" />
          <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
            <Box sx={{ flex: 1, minWidth: 250 }}>
              <TokenDistributionChart costs={agentCosts} />
            </Box>
            <Box sx={{ flex: 1, minWidth: 250 }}>
              <ModelUsageChart costs={agentCosts} />
            </Box>
          </Box>
        </>
      ) : (
        <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
          No usage data available
        </Typography>
      )}
    </Box>
  );

  // Activity section component
  const ActivitySection = () => (
    <>
      <Box
        sx={{
          px: 2,
          py: 1.5,
          bgcolor: "background.level1",
          borderTop: expanded ? "none" : "1px solid",
          borderColor: "neutral.outlinedBorder",
        }}
      >
        <Typography
          sx={{
            fontFamily: "code",
            fontSize: "0.7rem",
            color: "text.tertiary",
            letterSpacing: "0.05em",
          }}
        >
          RECENT ACTIVITY
        </Typography>
      </Box>

      <Box sx={{ flex: 1, overflow: "auto", p: 2 }}>
        {logsLoading ? (
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            Loading activity...
          </Typography>
        ) : !logs || logs.length === 0 ? (
          <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
            No recent activity
          </Typography>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            {logs.map((log) => (
              <Box
                key={log.id}
                sx={{
                  display: "flex",
                  gap: 1.5,
                  alignItems: "flex-start",
                }}
              >
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    bgcolor: getEventColor(log.eventType),
                    flexShrink: 0,
                    mt: 0.5,
                  }}
                />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    sx={{
                      fontFamily: "code",
                      fontSize: "0.7rem",
                      color: "text.primary",
                      mb: 0.25,
                    }}
                  >
                    {formatEventText(log)}
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
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </>
  );

  return (
    <Box
      sx={{
        position: { xs: "fixed", md: "relative" },
        inset: { xs: 0, md: "auto" },
        zIndex: { xs: 1300, md: "auto" },
        width: { xs: "100%", md: expanded ? "100%" : 400 },
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
            ←
          </IconButton>
          <Box
            sx={{
              width: 8,
              height: 10,
              clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
              bgcolor: colors.amber,
              boxShadow: colors.amberGlow,
              display: { xs: "none", md: "block" },
            }}
          />
          <Typography
            sx={{
              fontFamily: "display",
              fontWeight: 600,
              color: colors.amber,
              letterSpacing: "0.03em",
              fontSize: { xs: "0.9rem", md: "1rem" },
            }}
          >
            AGENT DETAILS
          </Typography>
        </Box>
        {/* Desktop buttons - hidden on mobile */}
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

      {/* Content - horizontal in expanded, vertical otherwise */}
      <Box
        sx={{
          flex: 1,
          overflow: "auto",
          display: "flex",
          flexDirection: expanded ? "row" : "column",
        }}
      >
        {expanded ? (
          <>
            {/* Left side - Info */}
            <Box
              sx={{
                minWidth: 220,
                maxWidth: 350,
                flexShrink: 0,
                borderRight: "1px solid",
                borderColor: "neutral.outlinedBorder",
                overflow: "auto",
              }}
            >
              <InfoSection />
              <Divider sx={{ bgcolor: "neutral.outlinedBorder" }} />
              <UsageSection />
            </Box>
            {/* Middle - Charts */}
            <Box
              sx={{
                flex: 1,
                borderRight: "1px solid",
                borderColor: "neutral.outlinedBorder",
                overflow: "auto",
              }}
            >
              <ChartsSection />
            </Box>
            {/* Right side - Activity */}
            <Box
              sx={{
                minWidth: 280,
                maxWidth: 400,
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <ActivitySection />
            </Box>
          </>
        ) : (
          <>
            <InfoSection />
            <Divider sx={{ bgcolor: "neutral.outlinedBorder" }} />
            <UsageSection />
            <Divider sx={{ bgcolor: "neutral.outlinedBorder" }} />
            <ActivitySection />
          </>
        )}
      </Box>

      {/* Edit Profile Modal */}
      <EditAgentProfileModal
        open={editProfileOpen}
        onClose={() => setEditProfileOpen(false)}
        agent={agent}
      />
    </Box>
  );
}

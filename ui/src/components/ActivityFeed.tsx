import { useMemo } from "react";
import Box from "@mui/joy/Box";
import Card from "@mui/joy/Card";
import Typography from "@mui/joy/Typography";
import Link from "@mui/joy/Link";
import { useColorScheme } from "@mui/joy/styles";
import { useLogs, useAgents, useChannels } from "../hooks/queries";
import { formatSmartTime } from "../lib/utils";
import type { AgentLog } from "../types/api";

interface ActivityFeedProps {
  onNavigateToAgent?: (agentId: string) => void;
  onNavigateToTask?: (taskId: string) => void;
  onNavigateToChat?: (channelId: string, messageId?: string) => void;
}

export default function ActivityFeed({ onNavigateToAgent, onNavigateToTask, onNavigateToChat }: ActivityFeedProps) {
  const { data: logs, isLoading } = useLogs(30);
  const { data: agents } = useAgents();
  const { data: channels } = useChannels();
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  // Create agent name lookup
  const agentNames = useMemo(() => {
    const map = new Map<string, string>();
    agents?.forEach((agent) => map.set(agent.id, agent.name));
    return map;
  }, [agents]);

  // Create channel name lookup
  const channelNames = useMemo(() => {
    const map = new Map<string, string>();
    channels?.forEach((channel) => map.set(channel.id, channel.name));
    return map;
  }, [channels]);

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    dormant: isDark ? "#6B5344" : "#A89A7C",
    honey: isDark ? "#FFB84D" : "#B87300",
    blue: "#3B82F6",
    gold: isDark ? "#D4A574" : "#8B6914",
    warmGray: isDark ? "#C9B896" : "#8B7355",
    tertiary: isDark ? "#8B7355" : "#6B5344",
    hoverBg: isDark ? "rgba(245, 166, 35, 0.03)" : "rgba(212, 136, 6, 0.03)",
    purple: isDark ? "#A855F7" : "#7C3AED",
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
      case "channel_message":
        return colors.purple;
      default:
        return colors.tertiary;
    }
  };

  const getEventGlow = (eventType: string) => {
    const color = getEventColor(eventType);
    return isDark ? `0 0 8px ${color}66` : `0 0 4px ${color}44`;
  };

  const renderEventContent = (log: AgentLog) => {
    const agentName = log.agentId ? (agentNames.get(log.agentId) || log.agentId.slice(0, 8)) : null;

    const agentLink = log.agentId && onNavigateToAgent ? (
      <Link
        component="button"
        onClick={(e) => {
          e.stopPropagation();
          onNavigateToAgent(log.agentId!);
        }}
        sx={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontSize: "0.75rem",
          fontWeight: 600,
          color: colors.amber,
          textDecoration: "none",
          cursor: "pointer",
          "&:hover": {
            textDecoration: "underline",
            color: colors.honey,
          },
        }}
      >
        {agentName}
      </Link>
    ) : log.agentId ? (
      <span style={{ fontWeight: 600, color: colors.amber }}>{agentName}</span>
    ) : null;

    const taskLink = log.taskId && onNavigateToTask ? (
      <Link
        component="button"
        onClick={(e) => {
          e.stopPropagation();
          onNavigateToTask(log.taskId!);
        }}
        sx={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "0.7rem",
          color: colors.gold,
          textDecoration: "none",
          cursor: "pointer",
          bgcolor: isDark ? "rgba(212, 165, 116, 0.1)" : "rgba(139, 105, 20, 0.08)",
          px: 0.75,
          py: 0.25,
          borderRadius: "4px",
          "&:hover": {
            textDecoration: "underline",
            bgcolor: isDark ? "rgba(212, 165, 116, 0.15)" : "rgba(139, 105, 20, 0.12)",
          },
        }}
      >
        #{log.taskId.slice(0, 8)}
      </Link>
    ) : log.taskId ? (
      <span style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: "0.7rem",
        backgroundColor: isDark ? "rgba(212, 165, 116, 0.1)" : "rgba(139, 105, 20, 0.08)",
        padding: "2px 6px",
        borderRadius: "4px",
      }}>
        #{log.taskId.slice(0, 8)}
      </span>
    ) : null;

    // Format progress messages nicely
    const formatProgress = (value: string | null | undefined) => {
      if (!value) return null;
      // Truncate long progress messages
      const maxLen = 60;
      const truncated = value.length > maxLen ? value.slice(0, maxLen) + "..." : value;
      return (
        <Box
          component="span"
          sx={{
            display: "block",
            mt: 0.5,
            pl: 1.5,
            borderLeft: "2px solid",
            borderColor: colors.warmGray,
            fontStyle: "italic",
            color: "text.secondary",
            fontSize: "0.7rem",
          }}
        >
          {truncated}
        </Box>
      );
    };

    switch (log.eventType) {
      case "agent_joined":
        return <>{agentLink} joined the swarm</>;
      case "agent_left":
        return <>{agentLink} left the swarm</>;
      case "agent_status_change":
        return (
          <>
            {agentLink} is now{" "}
            <Box
              component="span"
              sx={{
                fontWeight: 600,
                color: log.newValue === "busy" ? colors.amber : log.newValue === "idle" ? colors.gold : colors.dormant,
              }}
            >
              {log.newValue}
            </Box>
          </>
        );
      case "task_created":
        return (
          <>
            New task {taskLink} created
            {log.newValue && formatProgress(log.newValue)}
          </>
        );
      case "task_status_change":
        return (
          <>
            Task {taskLink} →{" "}
            <Box
              component="span"
              sx={{
                fontWeight: 600,
                color: log.newValue === "completed" ? "#22C55E" : log.newValue === "failed" ? colors.dormant : colors.gold,
              }}
            >
              {log.newValue}
            </Box>
          </>
        );
      case "task_progress":
        return (
          <>
            {taskLink}
            {formatProgress(log.newValue)}
          </>
        );
      case "channel_message": {
        // Parse metadata to get channelId and messageId
        let channelId: string | undefined;
        let messageId: string | undefined;
        if (log.metadata) {
          try {
            const meta = JSON.parse(log.metadata);
            channelId = meta.channelId;
            messageId = meta.messageId;
          } catch {
            // ignore parse errors
          }
        }
        const channelName = channelId ? (channelNames.get(channelId) || "chat") : "chat";
        const senderName = log.agentId ? agentLink : (
          <span style={{ fontWeight: 600, color: colors.warmGray }}>Human</span>
        );

        const channelLink = onNavigateToChat && channelId ? (
          <Link
            component="button"
            onClick={(e) => {
              e.stopPropagation();
              onNavigateToChat(channelId!, messageId);
            }}
            sx={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontSize: "0.75rem",
              fontWeight: 600,
              color: colors.purple,
              textDecoration: "none",
              cursor: "pointer",
              "&:hover": {
                textDecoration: "underline",
              },
            }}
          >
            #{channelName}
          </Link>
        ) : (
          <span style={{ fontWeight: 600, color: colors.purple }}>#{channelName}</span>
        );

        return (
          <>
            {senderName} in {channelLink}
          </>
        );
      }
      default:
        return <>{log.eventType}</>;
    }
  };

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
          px: 2,
          py: 1.5,
          borderBottom: "1px solid",
          borderColor: "neutral.outlinedBorder",
          bgcolor: "background.level1",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 1,
        }}
      >
        {/* Hex accent */}
        <Box
          sx={{
            width: 8,
            height: 10,
            clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
            bgcolor: colors.blue,
            boxShadow: isDark ? "0 0 8px rgba(59, 130, 246, 0.5)" : "0 0 4px rgba(59, 130, 246, 0.3)",
          }}
        />
        <Typography
          level="title-md"
          sx={{
            fontFamily: "display",
            fontWeight: 600,
            color: colors.blue,
            letterSpacing: "0.03em",
          }}
        >
          ACTIVITY
        </Typography>
      </Box>

      {/* Timeline */}
      <Box sx={{ p: 2, flex: 1, overflowY: "auto" }}>
        {isLoading ? (
          <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
            Loading activity...
          </Typography>
        ) : !logs || logs.length === 0 ? (
          <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
            No recent activity
          </Typography>
        ) : (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              gap: 0,
              position: "relative",
              // Vertical timeline line
              "&::before": {
                content: '""',
                position: "absolute",
                left: 5,
                top: 12,
                bottom: 12,
                width: 2,
                bgcolor: "neutral.outlinedBorder",
                borderRadius: 1,
              },
            }}
          >
            {logs.map((log, index) => (
              <Box
                key={log.id}
                sx={{
                  display: "flex",
                  gap: 2,
                  py: 1.5,
                  pl: 0,
                  position: "relative",
                  transition: "background-color 0.2s ease",
                  "&:hover": {
                    bgcolor: colors.hoverBg,
                  },
                }}
              >
                {/* Timeline node */}
                <Box
                  sx={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    bgcolor: getEventColor(log.eventType),
                    boxShadow: getEventGlow(log.eventType),
                    flexShrink: 0,
                    position: "relative",
                    zIndex: 1,
                    border: "2px solid",
                    borderColor: "background.surface",
                    animation: index === 0 ? "pulse-amber 2s ease-in-out infinite" : undefined,
                  }}
                />

                {/* Content */}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    component="div"
                    sx={{
                      fontFamily: "code",
                      fontSize: "0.75rem",
                      color: "text.primary",
                      mb: 0.25,
                      lineHeight: 1.4,
                    }}
                  >
                    {renderEventContent(log)}
                  </Typography>
                  <Typography
                    sx={{
                      fontFamily: "code",
                      fontSize: "0.65rem",
                      color: "text.tertiary",
                    }}
                  >
                    {formatSmartTime(log.createdAt)}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Card>
  );
}

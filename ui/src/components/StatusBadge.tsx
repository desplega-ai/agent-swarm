import Chip from "@mui/joy/Chip";
import { useColorScheme } from "@mui/joy/styles";
import type { AgentStatus, TaskStatus } from "../types/api";

interface StatusBadgeProps {
  status: AgentStatus | TaskStatus;
  size?: "sm" | "md" | "lg";
}

interface StatusConfig {
  color: "success" | "warning" | "neutral" | "danger";
  label: string;
  bgColor: { dark: string; light: string };
  textColor: { dark: string; light: string };
  glowColor: { dark: string; light: string };
}

const statusConfig: Record<AgentStatus | TaskStatus, StatusConfig> = {
  // Agent statuses
  idle: {
    color: "success",
    label: "IDLE",
    bgColor: { dark: "rgba(212, 165, 116, 0.15)", light: "rgba(139, 105, 20, 0.12)" },
    textColor: { dark: "#D4A574", light: "#8B6914" },
    glowColor: { dark: "rgba(212, 165, 116, 0.4)", light: "rgba(139, 105, 20, 0.2)" },
  },
  busy: {
    color: "warning",
    label: "BUSY",
    bgColor: { dark: "rgba(245, 166, 35, 0.15)", light: "rgba(212, 136, 6, 0.12)" },
    textColor: { dark: "#F5A623", light: "#D48806" },
    glowColor: { dark: "rgba(245, 166, 35, 0.5)", light: "rgba(212, 136, 6, 0.25)" },
  },
  offline: {
    color: "neutral",
    label: "OFFLINE",
    bgColor: { dark: "rgba(107, 83, 68, 0.15)", light: "rgba(168, 154, 124, 0.15)" },
    textColor: { dark: "#6B5344", light: "#8B7355" },
    glowColor: { dark: "rgba(107, 83, 68, 0.3)", light: "rgba(168, 154, 124, 0.15)" },
  },
  // Task statuses
  unassigned: {
    color: "neutral",
    label: "UNASSIGNED",
    bgColor: { dark: "rgba(100, 100, 100, 0.15)", light: "rgba(150, 150, 150, 0.15)" },
    textColor: { dark: "#888888", light: "#666666" },
    glowColor: { dark: "rgba(100, 100, 100, 0.3)", light: "rgba(150, 150, 150, 0.15)" },
  },
  offered: {
    color: "warning",
    label: "OFFERED",
    bgColor: { dark: "rgba(147, 112, 219, 0.15)", light: "rgba(128, 90, 213, 0.12)" },
    textColor: { dark: "#9370DB", light: "#6B5B95" },
    glowColor: { dark: "rgba(147, 112, 219, 0.4)", light: "rgba(128, 90, 213, 0.2)" },
  },
  pending: {
    color: "neutral",
    label: "PENDING",
    bgColor: { dark: "rgba(107, 83, 68, 0.15)", light: "rgba(168, 154, 124, 0.15)" },
    textColor: { dark: "#8B7355", light: "#6B5344" },
    glowColor: { dark: "rgba(139, 115, 85, 0.3)", light: "rgba(168, 154, 124, 0.15)" },
  },
  in_progress: {
    color: "warning",
    label: "IN PROGRESS",
    bgColor: { dark: "rgba(245, 166, 35, 0.15)", light: "rgba(212, 136, 6, 0.12)" },
    textColor: { dark: "#F5A623", light: "#D48806" },
    glowColor: { dark: "rgba(245, 166, 35, 0.5)", light: "rgba(212, 136, 6, 0.25)" },
  },
  completed: {
    color: "success",
    label: "COMPLETED",
    bgColor: { dark: "rgba(212, 165, 116, 0.15)", light: "rgba(139, 105, 20, 0.12)" },
    textColor: { dark: "#D4A574", light: "#8B6914" },
    glowColor: { dark: "rgba(212, 165, 116, 0.4)", light: "rgba(139, 105, 20, 0.2)" },
  },
  failed: {
    color: "danger",
    label: "FAILED",
    bgColor: { dark: "rgba(168, 84, 84, 0.15)", light: "rgba(181, 66, 66, 0.12)" },
    textColor: { dark: "#A85454", light: "#B54242" },
    glowColor: { dark: "rgba(168, 84, 84, 0.4)", light: "rgba(181, 66, 66, 0.2)" },
  },
};

export default function StatusBadge({ status, size = "sm" }: StatusBadgeProps) {
  const { mode } = useColorScheme();
  const isDark = mode === "dark";
  const config = statusConfig[status];
  const isActive = status === "busy" || status === "in_progress" || status === "offered";

  const bgColor = isDark ? config.bgColor.dark : config.bgColor.light;
  const textColor = isDark ? config.textColor.dark : config.textColor.light;
  const glowColor = isDark ? config.glowColor.dark : config.glowColor.light;

  return (
    <Chip
      size={size}
      variant="soft"
      sx={{
        fontFamily: "code",
        fontWeight: 600,
        fontSize: size === "sm" ? "0.65rem" : "0.75rem",
        letterSpacing: "0.05em",
        bgcolor: bgColor,
        color: textColor,
        border: "1px solid",
        borderColor: isActive ? textColor : "transparent",
        boxShadow: isDark ? `0 0 10px ${glowColor}` : "none",
        animation: isActive ? "pulse-amber 2s ease-in-out infinite" : undefined,
        "@keyframes pulse-amber": {
          "0%, 100%": {
            boxShadow: `0 0 5px ${glowColor}`,
          },
          "50%": {
            boxShadow: `0 0 15px ${glowColor}, 0 0 25px ${glowColor}`,
          },
        },
      }}
    >
      {config.label}
    </Chip>
  );
}

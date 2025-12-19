import Box from "@mui/joy/Box";
import Typography from "@mui/joy/Typography";
import { useColorScheme } from "@mui/joy/styles";
import { useStats } from "../hooks/queries";

interface HexStatProps {
  label: string;
  value: number;
  color: string;
  glowColor: string;
  isActive?: boolean;
  isDark: boolean;
  onClick?: () => void;
}

function HexStat({ label, value, color, glowColor, isActive, isDark, onClick }: HexStatProps) {
  return (
    <Box
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") onClick(); } : undefined}
      sx={{
        position: "relative",
        width: 90,
        height: 100,
        transition: "all 0.3s ease",
        cursor: onClick ? "pointer" : "default",
        animation: isActive ? "breathe 3s ease-in-out infinite" : undefined,
        "@keyframes breathe": {
          "0%, 100%": { opacity: 0.9, transform: "scale(1)" },
          "50%": { opacity: 1, transform: "scale(1.02)" },
        },
        "&:hover": {
          filter: isDark ? `drop-shadow(0 0 15px ${glowColor})` : `drop-shadow(0 0 8px ${glowColor})`,
          transform: onClick ? "scale(1.05)" : undefined,
        },
        "&:hover .hex-bg": {
          bgcolor: isDark ? "#2F2419" : "#F5EDE4",
        },
        "& *": {
          cursor: onClick ? "pointer" : "inherit",
        },
      }}
    >
      {/* Border layer */}
      <Box
        sx={{
          position: "absolute",
          inset: 0,
          clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
          background: color,
        }}
      />
      {/* Background layer */}
      <Box
        className="hex-bg"
        sx={{
          position: "absolute",
          inset: 2,
          clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
          bgcolor: isDark ? "#1A130E" : "#FFFFFF",
          transition: "background-color 0.2s ease",
        }}
      />
      {/* Content layer */}
      <Box
        sx={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1,
        }}
      >
        <Typography
          sx={{
            fontFamily: "code",
            fontSize: "1.5rem",
            fontWeight: 700,
            color,
            textShadow: isDark ? `0 0 20px ${glowColor}` : "none",
            lineHeight: 1,
          }}
        >
          {value}
        </Typography>
        <Typography
          sx={{
            fontFamily: "body",
            fontSize: "0.55rem",
            color: "text.tertiary",
            letterSpacing: "0.08em",
            mt: 0.5,
            textAlign: "center",
            lineHeight: 1.1,
            px: 1,
          }}
        >
          {label}
        </Typography>
      </Box>
    </Box>
  );
}

interface StatsBarProps {
  onFilterAgents?: (status: "all" | "busy" | "idle") => void;
  onNavigateToTasks?: (status?: "pending" | "in_progress" | "completed" | "failed") => void;
}

export default function StatsBar({ onFilterAgents, onNavigateToTasks }: StatsBarProps) {
  const { data: stats } = useStats();
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  if (!stats) return null;

  const colors = {
    blue: "#3B82F6",
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
    tertiary: isDark ? "#8B7355" : "#6B5344",
    rust: isDark ? "#A85454" : "#B54242",
    blueGlow: isDark ? "rgba(59, 130, 246, 0.5)" : "rgba(59, 130, 246, 0.25)",
    amberGlow: isDark ? "rgba(245, 166, 35, 0.5)" : "rgba(212, 136, 6, 0.25)",
    goldGlow: isDark ? "rgba(212, 165, 116, 0.5)" : "rgba(139, 105, 20, 0.25)",
    tertiaryGlow: isDark ? "rgba(139, 115, 85, 0.4)" : "rgba(107, 83, 68, 0.2)",
    rustGlow: isDark ? "rgba(168, 84, 84, 0.5)" : "rgba(181, 66, 66, 0.25)",
  };

  // Honeycomb-style arrangement: two rows offset
  const topRow = [
    {
      label: "AGENTS",
      value: stats.agents.total,
      color: colors.blue,
      glowColor: colors.blueGlow,
      onClick: onFilterAgents ? () => onFilterAgents("all") : undefined,
    },
    {
      label: "BUSY",
      value: stats.agents.busy,
      color: colors.amber,
      glowColor: colors.amberGlow,
      isActive: stats.agents.busy > 0,
      onClick: onFilterAgents ? () => onFilterAgents("busy") : undefined,
    },
    {
      label: "IDLE",
      value: stats.agents.idle,
      color: colors.gold,
      glowColor: colors.goldGlow,
      onClick: onFilterAgents ? () => onFilterAgents("idle") : undefined,
    },
  ];

  const bottomRow = [
    {
      label: "PENDING",
      value: stats.tasks.pending,
      color: colors.tertiary,
      glowColor: colors.tertiaryGlow,
      onClick: onNavigateToTasks ? () => onNavigateToTasks("pending") : undefined,
    },
    {
      label: "RUNNING",
      value: stats.tasks.in_progress,
      color: colors.amber,
      glowColor: colors.amberGlow,
      isActive: stats.tasks.in_progress > 0,
      onClick: onNavigateToTasks ? () => onNavigateToTasks("in_progress") : undefined,
    },
    {
      label: "DONE",
      value: stats.tasks.completed,
      color: colors.gold,
      glowColor: colors.goldGlow,
      onClick: onNavigateToTasks ? () => onNavigateToTasks("completed") : undefined,
    },
    {
      label: "FAILED",
      value: stats.tasks.failed,
      color: colors.rust,
      glowColor: colors.rustGlow,
      onClick: onNavigateToTasks ? () => onNavigateToTasks("failed") : undefined,
    },
  ];

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        bgcolor: "background.surface",
        border: "1px solid",
        borderColor: "neutral.outlinedBorder",
        borderRadius: "8px",
        py: 1.5,
        gap: 0,
        flexShrink: 0,
      }}
    >
      {/* Top row - 3 hexagons */}
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          gap: 0.5,
        }}
      >
        {topRow.map((stat) => (
          <HexStat
            key={stat.label}
            label={stat.label}
            value={stat.value}
            color={stat.color}
            glowColor={stat.glowColor}
            isActive={stat.isActive}
            isDark={isDark}
            onClick={stat.onClick}
          />
        ))}
      </Box>

      {/* Bottom row - 4 hexagons, offset for honeycomb effect */}
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          gap: 0.5,
          mt: -2.5, // Overlap for honeycomb effect
        }}
      >
        {bottomRow.map((stat) => (
          <HexStat
            key={stat.label}
            label={stat.label}
            value={stat.value}
            color={stat.color}
            glowColor={stat.glowColor}
            isActive={stat.isActive}
            isDark={isDark}
            onClick={stat.onClick}
          />
        ))}
      </Box>
    </Box>
  );
}

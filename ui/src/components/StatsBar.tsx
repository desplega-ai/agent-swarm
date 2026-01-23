import Box from "@mui/joy/Box";
import { useColorScheme } from "@mui/joy/styles";
import Typography from "@mui/joy/Typography";
import { useMonthlyUsageStats, useStats } from "../hooks/queries";
import { formatCompactNumber, formatCurrency } from "../lib/utils";

interface HexStatProps {
  label: string;
  value: number | string;
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
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onClick();
            }
          : undefined
      }
      sx={{
        position: "relative",
        width: { xs: 65, sm: 75, md: 90 },
        height: { xs: 72, sm: 84, md: 100 },
        transition: "all 0.3s ease",
        cursor: onClick ? "pointer" : "default",
        animation: isActive ? "breathe 3s ease-in-out infinite" : undefined,
        flexShrink: 0,
        "@keyframes breathe": {
          "0%, 100%": { opacity: 0.9, transform: "scale(1)" },
          "50%": { opacity: 1, transform: "scale(1.02)" },
        },
        "&:hover": {
          filter: isDark
            ? `drop-shadow(0 0 15px ${glowColor})`
            : `drop-shadow(0 0 8px ${glowColor})`,
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
            fontSize: { xs: "1.1rem", sm: "1.25rem", md: "1.5rem" },
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
            fontSize: { xs: "0.45rem", sm: "0.5rem", md: "0.55rem" },
            color: "text.tertiary",
            letterSpacing: "0.08em",
            mt: 0.5,
            textAlign: "center",
            lineHeight: 1.1,
            px: 0.5,
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
  onNavigateToTasks?: (
    status?: "pending" | "in_progress" | "paused" | "completed" | "failed",
  ) => void;
}

export default function StatsBar({ onFilterAgents, onNavigateToTasks }: StatsBarProps) {
  const { data: stats } = useStats();
  const { data: usageStats } = useMonthlyUsageStats();
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  if (!stats) return null;

  const colors = {
    blue: "#3B82F6",
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
    tertiary: isDark ? "#8B7355" : "#6B5344",
    rust: isDark ? "#A85454" : "#B54242",
    green: "#22C55E",
    orange: isDark ? "#FF9800" : "#E67E22",
    blueGlow: isDark ? "rgba(59, 130, 246, 0.5)" : "rgba(59, 130, 246, 0.25)",
    amberGlow: isDark ? "rgba(245, 166, 35, 0.5)" : "rgba(212, 136, 6, 0.25)",
    goldGlow: isDark ? "rgba(212, 165, 116, 0.5)" : "rgba(139, 105, 20, 0.25)",
    tertiaryGlow: isDark ? "rgba(139, 115, 85, 0.4)" : "rgba(107, 83, 68, 0.2)",
    rustGlow: isDark ? "rgba(168, 84, 84, 0.5)" : "rgba(181, 66, 66, 0.25)",
    greenGlow: isDark ? "rgba(34, 197, 94, 0.5)" : "rgba(34, 197, 94, 0.25)",
    orangeGlow: isDark ? "rgba(255, 152, 0, 0.4)" : "rgba(230, 126, 34, 0.2)",
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
      label: "PAUSED",
      value: stats.tasks.paused,
      color: colors.orange,
      glowColor: colors.orangeGlow,
      onClick: onNavigateToTasks ? () => onNavigateToTasks("paused") : undefined,
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

  // Usage stats row (MTD = Month to Date)
  const usageRow = [
    {
      label: "MTD TOKENS",
      value: usageStats ? formatCompactNumber(usageStats.totalTokens) : "—",
      color: colors.green,
      glowColor: colors.greenGlow,
    },
    {
      label: "MTD COST",
      value: usageStats ? formatCurrency(usageStats.totalCostUsd) : "—",
      color: colors.amber,
      glowColor: colors.amberGlow,
    },
  ];

  return (
    <Box
      sx={{
        bgcolor: "background.surface",
        border: "1px solid",
        borderColor: "neutral.outlinedBorder",
        borderRadius: "8px",
        py: { xs: 1, md: 1.5 },
        flexShrink: 0,
        overflowX: { xs: "auto", md: "visible" },
        WebkitOverflowScrolling: "touch",
      }}
    >
      {/* Desktop: Two-row honeycomb layout */}
      <Box
        sx={{
          display: { xs: "none", md: "flex" },
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 0,
        }}
      >
        {/* Top row: Agents stats + Usage */}
        <Box sx={{ display: "flex", gap: 0.5 }}>
          {[...topRow, ...usageRow].map((stat) => (
            <HexStat
              key={stat.label}
              label={stat.label}
              value={stat.value}
              color={stat.color}
              glowColor={stat.glowColor}
              isActive={"isActive" in stat ? stat.isActive : undefined}
              isDark={isDark}
              onClick={"onClick" in stat ? stat.onClick : undefined}
            />
          ))}
        </Box>
        {/* Bottom row: Tasks stats (horizontally offset for honeycomb effect) */}
        <Box
          sx={{
            display: "flex",
            gap: 0.5,
            mt: { md: "-20px" }, // Overlap rows vertically to create honeycomb interlocking
            ml: { md: "88px" }, // Offset by ~half hex width for proper honeycomb tessellation
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

      {/* Mobile: Single row horizontal scroll */}
      <Box
        sx={{
          display: { xs: "flex", md: "none" },
          flexDirection: "row",
          alignItems: "center",
          gap: { xs: 0.5, sm: 1 },
          px: 1,
          minWidth: "max-content",
        }}
      >
        {[...topRow, ...bottomRow, ...usageRow].map((stat) => (
          <HexStat
            key={stat.label}
            label={stat.label}
            value={stat.value}
            color={stat.color}
            glowColor={stat.glowColor}
            isActive={"isActive" in stat ? stat.isActive : undefined}
            isDark={isDark}
            onClick={"onClick" in stat ? stat.onClick : undefined}
          />
        ))}
      </Box>
    </Box>
  );
}

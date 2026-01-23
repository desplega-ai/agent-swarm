import Box from "@mui/joy/Box";
import IconButton from "@mui/joy/IconButton";
import { useColorScheme } from "@mui/joy/styles";
import Typography from "@mui/joy/Typography";
import { useHealth } from "../hooks/queries";

interface HeaderProps {
  onSettingsClick: () => void;
}

export default function Header({ onSettingsClick }: HeaderProps) {
  const { data: health, isError, isLoading } = useHealth();
  const { mode, setMode } = useColorScheme();

  const toggleMode = () => {
    setMode(mode === "dark" ? "light" : "dark");
  };

  const connectionStatus = isLoading ? "connecting" : isError ? "error" : "connected";

  const isDark = mode === "dark";

  const statusColors = {
    connected: {
      bg: isDark ? "rgba(212, 165, 116, 0.15)" : "rgba(139, 105, 20, 0.12)",
      border: isDark ? "#D4A574" : "#8B6914",
      text: isDark ? "#D4A574" : "#8B6914",
    },
    connecting: {
      bg: isDark ? "rgba(245, 166, 35, 0.15)" : "rgba(212, 136, 6, 0.12)",
      border: isDark ? "#F5A623" : "#D48806",
      text: isDark ? "#F5A623" : "#D48806",
    },
    error: {
      bg: isDark ? "rgba(168, 84, 84, 0.15)" : "rgba(181, 66, 66, 0.12)",
      border: isDark ? "#A85454" : "#B54242",
      text: isDark ? "#A85454" : "#B54242",
    },
  };

  const colors = statusColors[connectionStatus];

  return (
    <Box
      component="header"
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        px: { xs: 1.5, sm: 2, md: 3 },
        py: { xs: 1.5, md: 2 },
        borderBottom: "1px solid",
        borderColor: "neutral.outlinedBorder",
        bgcolor: "background.surface",
      }}
    >
      {/* Title */}
      <Typography
        level="h3"
        sx={{
          fontFamily: "display",
          fontWeight: 700,
          fontSize: { xs: "1.1rem", sm: "1.25rem", md: "1.5rem" },
          background: isDark ? "#F5A623" : "#9A5F00",
          backgroundClip: "text",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          textShadow: isDark ? "0 0 30px rgba(245, 166, 35, 0.3)" : "none",
          letterSpacing: { xs: "0.1em", md: "0.15em" },
        }}
      >
        <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>
          AGENT SWARM
        </Box>
        <Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>
          SWARM
        </Box>
      </Typography>

      {/* Right side: version + theme toggle + settings */}
      <Box sx={{ display: "flex", alignItems: "center", gap: { xs: 0.75, md: 1.5 } }}>
        {/* Connection Status / Version */}
        <Box
          component="span"
          sx={{
            fontFamily: "code",
            fontSize: "0.65rem",
            bgcolor: colors.bg,
            border: "1px solid",
            borderColor: colors.border,
            color: colors.text,
            borderRadius: "6px",
            px: 1.5,
            py: 0.5,
            display: "inline-flex",
            alignItems: "center",
            boxShadow: isDark ? `0 0 10px ${colors.border}33` : "none",
            animation:
              connectionStatus === "connecting" ? "heartbeat 1.5s ease-in-out infinite" : undefined,
            "@keyframes heartbeat": {
              "0%, 100%": { transform: "scale(1)" },
              "14%": { transform: "scale(1.1)" },
              "28%": { transform: "scale(1)" },
              "42%": { transform: "scale(1.1)" },
              "70%": { transform: "scale(1)" },
            },
          }}
        >
          {connectionStatus === "connected" && health?.version
            ? `v${health.version}`
            : connectionStatus.toUpperCase()}
        </Box>

        {/* Theme Toggle */}
        <IconButton
          variant="outlined"
          onClick={toggleMode}
          sx={{
            minWidth: { xs: 44, md: "auto" },
            minHeight: { xs: 44, md: "auto" },
            borderColor: "neutral.outlinedBorder",
            color: "text.secondary",
            transition: "all 0.2s ease",
            "&:hover": {
              borderColor: "primary.500",
              color: "primary.500",
              bgcolor: "primary.softBg",
            },
          }}
        >
          <Box component="span" sx={{ fontSize: "1rem" }}>
            {mode === "dark" ? "☀️" : "🌙"}
          </Box>
        </IconButton>

        {/* Settings Button */}
        <IconButton
          variant="outlined"
          onClick={onSettingsClick}
          sx={{
            minWidth: { xs: 44, md: "auto" },
            minHeight: { xs: 44, md: "auto" },
            borderColor: "neutral.outlinedBorder",
            color: "text.secondary",
            transition: "all 0.2s ease",
            "&:hover": {
              borderColor: "primary.500",
              color: "primary.500",
              bgcolor: "primary.softBg",
            },
          }}
        >
          <Box component="span" sx={{ fontSize: "1.2rem" }}>
            &#x2699;
          </Box>
        </IconButton>
      </Box>
    </Box>
  );
}

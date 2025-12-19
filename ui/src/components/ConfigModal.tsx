import { useState, useEffect } from "react";
import Modal from "@mui/joy/Modal";
import ModalDialog from "@mui/joy/ModalDialog";
import Typography from "@mui/joy/Typography";
import Input from "@mui/joy/Input";
import Button from "@mui/joy/Button";
import FormControl from "@mui/joy/FormControl";
import FormLabel from "@mui/joy/FormLabel";
import Stack from "@mui/joy/Stack";
import Box from "@mui/joy/Box";
import Divider from "@mui/joy/Divider";
import { useColorScheme } from "@mui/joy/styles";
import { getConfig, saveConfig, resetConfig, getDefaultConfig } from "../lib/config";

interface ConfigModalProps {
  open: boolean;
  onClose: () => void;
  onSave: () => void;
  blocking?: boolean;
}

export default function ConfigModal({ open, onClose, onSave, blocking }: ConfigModalProps) {
  const [apiUrl, setApiUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    honey: isDark ? "#FFB84D" : "#B87300",
    rust: isDark ? "#A85454" : "#B54242",
    surface: isDark ? "#1A130E" : "#FFFFFF",
    level1: isDark ? "#251C15" : "#F5EDE4",
    border: isDark ? "#3A2D1F" : "#E5D9CA",
    borderHover: isDark ? "#4A3A2F" : "#D5C9BA",
    textPrimary: isDark ? "#FFF8E7" : "#1A130E",
    textSecondary: isDark ? "#C9B896" : "#5C4A3D",
    textTertiary: isDark ? "#8B7355" : "#6B5344",
    amberGlow: isDark ? "0 0 10px rgba(245, 166, 35, 0.5)" : "0 0 8px rgba(212, 136, 6, 0.4)",
    modalGlow: isDark
      ? "0 0 40px rgba(245, 166, 35, 0.1), 0 0 80px rgba(245, 166, 35, 0.05)"
      : "0 4px 20px rgba(0, 0, 0, 0.15), 0 0 40px rgba(212, 136, 6, 0.1)",
    focusGlow: isDark ? "0 0 10px rgba(245, 166, 35, 0.2)" : "0 0 8px rgba(212, 136, 6, 0.15)",
    hoverBg: isDark ? "rgba(255, 255, 255, 0.02)" : "rgba(0, 0, 0, 0.02)",
    rustHoverBg: isDark ? "rgba(168, 84, 84, 0.05)" : "rgba(181, 66, 66, 0.05)",
  };

  useEffect(() => {
    if (open) {
      const config = getConfig();
      setApiUrl(config.apiUrl);
      setApiKey(config.apiKey);
    }
  }, [open]);

  const handleSave = () => {
    saveConfig({ apiUrl, apiKey });
    onSave();
  };

  const handleReset = () => {
    const defaults = getDefaultConfig();
    setApiUrl(defaults.apiUrl);
    setApiKey(defaults.apiKey);
    resetConfig();
  };

  return (
    <Modal open={open} onClose={blocking ? undefined : onClose}>
      <ModalDialog
        sx={{
          bgcolor: colors.surface,
          border: "1px solid",
          borderColor: colors.border,
          borderRadius: "12px",
          boxShadow: colors.modalGlow,
          minWidth: 400,
        }}
      >
        {/* Header */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          {/* Hex accent */}
          <Box
            sx={{
              width: 12,
              height: 14,
              clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
              bgcolor: colors.amber,
              boxShadow: colors.amberGlow,
            }}
          />
          <Typography
            level="h4"
            sx={{
              fontFamily: "display",
              fontWeight: 600,
              color: colors.amber,
              textShadow: isDark ? "0 0 15px rgba(245, 166, 35, 0.4)" : "none",
            }}
          >
            CONFIGURATION
          </Typography>
        </Box>

        <Divider sx={{ my: 2, bgcolor: colors.border }} />

        <Stack spacing={2.5}>
          <FormControl>
            <FormLabel
              sx={{
                fontFamily: "code",
                color: colors.textSecondary,
                fontSize: "0.75rem",
                letterSpacing: "0.05em",
              }}
            >
              API URL
            </FormLabel>
            <Input
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://desplega.sh"
              sx={{
                fontFamily: "code",
                bgcolor: colors.level1,
                borderColor: colors.border,
                color: colors.textPrimary,
                "&:focus-within": {
                  borderColor: colors.amber,
                  boxShadow: colors.focusGlow,
                },
                "&:hover": {
                  borderColor: colors.borderHover,
                },
              }}
            />
          </FormControl>

          <FormControl>
            <FormLabel
              sx={{
                fontFamily: "code",
                color: colors.textSecondary,
                fontSize: "0.75rem",
                letterSpacing: "0.05em",
              }}
            >
              API KEY (optional)
            </FormLabel>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter API key if required"
              sx={{
                fontFamily: "code",
                bgcolor: colors.level1,
                borderColor: colors.border,
                color: colors.textPrimary,
                "&:focus-within": {
                  borderColor: colors.amber,
                  boxShadow: colors.focusGlow,
                },
                "&:hover": {
                  borderColor: colors.borderHover,
                },
              }}
            />
          </FormControl>
        </Stack>

        <Divider sx={{ my: 2, bgcolor: colors.border }} />

        <Box sx={{ display: "flex", gap: 1.5, justifyContent: "space-between" }}>
          <Button
            variant="outlined"
            onClick={handleReset}
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              borderColor: colors.border,
              color: colors.textTertiary,
              "&:hover": {
                borderColor: colors.rust,
                color: colors.rust,
                bgcolor: colors.rustHoverBg,
              },
            }}
          >
            RESET
          </Button>
          <Box sx={{ display: "flex", gap: 1.5 }}>
            {!blocking && (
              <Button
                variant="outlined"
                onClick={onClose}
                sx={{
                  fontFamily: "code",
                  fontSize: "0.75rem",
                  borderColor: colors.border,
                  color: colors.textSecondary,
                  "&:hover": {
                    borderColor: colors.borderHover,
                    bgcolor: colors.hoverBg,
                  },
                }}
              >
                CANCEL
              </Button>
            )}
            <Button
              onClick={handleSave}
              sx={{
                fontFamily: "code",
                fontSize: "0.75rem",
                bgcolor: colors.amber,
                color: isDark ? "#0D0906" : "#FFFFFF",
                fontWeight: 700,
                "&:hover": {
                  bgcolor: colors.honey,
                  boxShadow: isDark ? "0 0 20px rgba(245, 166, 35, 0.4)" : "0 0 15px rgba(212, 136, 6, 0.3)",
                },
              }}
            >
              CONNECT
            </Button>
          </Box>
        </Box>
      </ModalDialog>
    </Modal>
  );
}

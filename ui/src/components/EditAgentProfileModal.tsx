import Box from "@mui/joy/Box";
import Button from "@mui/joy/Button";
import Chip from "@mui/joy/Chip";
import ChipDelete from "@mui/joy/ChipDelete";
import CircularProgress from "@mui/joy/CircularProgress";
import Divider from "@mui/joy/Divider";
import FormControl from "@mui/joy/FormControl";
import FormHelperText from "@mui/joy/FormHelperText";
import FormLabel from "@mui/joy/FormLabel";
import Input from "@mui/joy/Input";
import Modal from "@mui/joy/Modal";
import ModalDialog from "@mui/joy/ModalDialog";
import Stack from "@mui/joy/Stack";
import { useColorScheme } from "@mui/joy/styles";
import Textarea from "@mui/joy/Textarea";
import Typography from "@mui/joy/Typography";
import { useEffect, useState } from "react";
import { useUpdateAgentProfile } from "../hooks/queries";
import type { Agent } from "../types/api";

interface EditAgentProfileModalProps {
  open: boolean;
  onClose: () => void;
  agent: Agent;
}

export default function EditAgentProfileModal({
  open,
  onClose,
  agent,
}: EditAgentProfileModalProps) {
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [newCapability, setNewCapability] = useState("");
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const updateProfile = useUpdateAgentProfile();

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
    amberSoftBg: isDark ? "rgba(245, 166, 35, 0.1)" : "rgba(212, 136, 6, 0.08)",
    amberBorder: isDark ? "rgba(245, 166, 35, 0.3)" : "rgba(212, 136, 6, 0.25)",
    gold: isDark ? "#D4A574" : "#8B6914",
  };

  useEffect(() => {
    if (open && agent) {
      setRole(agent.role || "");
      setDescription(agent.description || "");
      setCapabilities(agent.capabilities || []);
      setNewCapability("");
    }
  }, [open, agent]);

  const handleSave = async () => {
    try {
      await updateProfile.mutateAsync({
        id: agent.id,
        profile: {
          role: role || undefined,
          description: description || undefined,
          capabilities: capabilities.length > 0 ? capabilities : undefined,
        },
      });
      onClose();
    } catch {
      // Error is handled by mutation state
    }
  };

  const handleAddCapability = () => {
    const trimmed = newCapability.trim().toLowerCase();
    if (trimmed && !capabilities.includes(trimmed)) {
      setCapabilities([...capabilities, trimmed]);
      setNewCapability("");
    }
  };

  const handleRemoveCapability = (cap: string) => {
    setCapabilities(capabilities.filter((c) => c !== cap));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddCapability();
    }
  };

  const hasChanges =
    role !== (agent.role || "") ||
    description !== (agent.description || "") ||
    JSON.stringify(capabilities) !== JSON.stringify(agent.capabilities || []);

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog
        sx={{
          bgcolor: colors.surface,
          border: "1px solid",
          borderColor: colors.border,
          borderRadius: "12px",
          boxShadow: colors.modalGlow,
          minWidth: 450,
          maxWidth: 550,
        }}
      >
        {/* Header */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
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
            EDIT AGENT PROFILE
          </Typography>
        </Box>

        <Typography
          sx={{
            fontFamily: "code",
            fontSize: "0.75rem",
            color: colors.textTertiary,
            mt: 0.5,
          }}
        >
          {agent.name}
        </Typography>

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
              ROLE
            </FormLabel>
            <Input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g., frontend developer, code reviewer"
              slotProps={{ input: { maxLength: 100 } }}
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
            <FormHelperText
              sx={{ fontFamily: "code", fontSize: "0.65rem", color: colors.textTertiary }}
            >
              Max 100 characters
            </FormHelperText>
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
              DESCRIPTION
            </FormLabel>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of the agent's purpose or specialty"
              minRows={2}
              maxRows={4}
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
              CAPABILITIES
            </FormLabel>
            <Box sx={{ display: "flex", gap: 1 }}>
              <Input
                value={newCapability}
                onChange={(e) => setNewCapability(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Add capability..."
                sx={{
                  flex: 1,
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
              <Button
                variant="outlined"
                onClick={handleAddCapability}
                disabled={!newCapability.trim()}
                sx={{
                  fontFamily: "code",
                  fontSize: "0.75rem",
                  borderColor: colors.border,
                  color: colors.textSecondary,
                  "&:hover": {
                    borderColor: colors.amber,
                    color: colors.amber,
                    bgcolor: colors.hoverBg,
                  },
                  "&:disabled": {
                    borderColor: colors.border,
                    color: colors.textTertiary,
                  },
                }}
              >
                ADD
              </Button>
            </Box>
            {capabilities.length > 0 && (
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 1 }}>
                {capabilities.map((cap) => (
                  <Chip
                    key={cap}
                    size="sm"
                    variant="soft"
                    endDecorator={
                      <ChipDelete
                        onDelete={() => handleRemoveCapability(cap)}
                        sx={{
                          color: colors.textTertiary,
                          "&:hover": { color: colors.rust },
                        }}
                      />
                    }
                    sx={{
                      fontFamily: "code",
                      fontSize: "0.7rem",
                      bgcolor: colors.amberSoftBg,
                      color: colors.gold,
                      border: `1px solid ${colors.amberBorder}`,
                    }}
                  >
                    {cap}
                  </Chip>
                ))}
              </Box>
            )}
            <FormHelperText
              sx={{ fontFamily: "code", fontSize: "0.65rem", color: colors.textTertiary }}
            >
              Press Enter or click Add to add capabilities
            </FormHelperText>
          </FormControl>
        </Stack>

        {updateProfile.error && (
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              color: colors.rust,
              mt: 2,
            }}
          >
            {updateProfile.error.message}
          </Typography>
        )}

        <Divider sx={{ my: 2, bgcolor: colors.border }} />

        <Box sx={{ display: "flex", gap: 1.5, justifyContent: "flex-end" }}>
          <Button
            variant="outlined"
            onClick={onClose}
            disabled={updateProfile.isPending}
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
          <Button
            onClick={handleSave}
            disabled={!hasChanges || updateProfile.isPending}
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              bgcolor: colors.amber,
              color: isDark ? "#0D0906" : "#FFFFFF",
              fontWeight: 700,
              "&:hover": {
                bgcolor: colors.honey,
                boxShadow: isDark
                  ? "0 0 20px rgba(245, 166, 35, 0.4)"
                  : "0 0 15px rgba(212, 136, 6, 0.3)",
              },
              "&:disabled": {
                bgcolor: colors.textTertiary,
                color: colors.surface,
              },
            }}
          >
            {updateProfile.isPending ? (
              <CircularProgress size="sm" sx={{ color: "inherit" }} />
            ) : (
              "SAVE"
            )}
          </Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
}

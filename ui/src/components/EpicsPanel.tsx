import { useState, useMemo } from "react";
import Box from "@mui/joy/Box";
import Card from "@mui/joy/Card";
import Typography from "@mui/joy/Typography";
import Table from "@mui/joy/Table";
import Select from "@mui/joy/Select";
import Option from "@mui/joy/Option";
import Input from "@mui/joy/Input";
import Chip from "@mui/joy/Chip";
import LinearProgress from "@mui/joy/LinearProgress";
import { useColorScheme } from "@mui/joy/styles";
import { useEpics, useAgents } from "../hooks/queries";
import type { Epic, EpicStatus } from "../types/api";

interface EpicsPanelProps {
  selectedEpicId: string | null;
  onSelectEpic: (epicId: string | null) => void;
  statusFilter?: EpicStatus | "all";
  onStatusFilterChange?: (status: EpicStatus | "all") => void;
}

function formatSmartTime(dateStr: string | undefined): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);

  if (diffHours < 6) {
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    return `${diffHours}h ago`;
  }

  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function getStatusColor(status: EpicStatus, isDark: boolean) {
  switch (status) {
    case "draft":
      return isDark ? "#9E9E9E" : "#757575";
    case "active":
      return isDark ? "#4CAF50" : "#2E7D32";
    case "paused":
      return isDark ? "#FF9800" : "#F57C00";
    case "completed":
      return isDark ? "#2196F3" : "#1976D2";
    case "cancelled":
      return isDark ? "#EF5350" : "#D32F2F";
    default:
      return isDark ? "#9E9E9E" : "#757575";
  }
}

function getStatusBgColor(status: EpicStatus, isDark: boolean) {
  switch (status) {
    case "draft":
      return isDark ? "rgba(158, 158, 158, 0.15)" : "rgba(117, 117, 117, 0.1)";
    case "active":
      return isDark ? "rgba(76, 175, 80, 0.15)" : "rgba(46, 125, 50, 0.1)";
    case "paused":
      return isDark ? "rgba(255, 152, 0, 0.15)" : "rgba(245, 124, 0, 0.1)";
    case "completed":
      return isDark ? "rgba(33, 150, 243, 0.15)" : "rgba(25, 118, 210, 0.1)";
    case "cancelled":
      return isDark ? "rgba(239, 83, 80, 0.15)" : "rgba(211, 47, 47, 0.1)";
    default:
      return isDark ? "rgba(158, 158, 158, 0.15)" : "rgba(117, 117, 117, 0.1)";
  }
}

// Mobile card component
interface EpicCardProps {
  epic: Epic & { progress?: number };
  selected: boolean;
  onClick: () => void;
  agent?: import("../types/api").Agent;
  isDark: boolean;
}

function EpicCard({ epic, selected, onClick, agent, isDark }: EpicCardProps) {
  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
    selectedBorder: isDark ? "#D4A574" : "#8B6914",
    goldSoftBg: isDark ? "rgba(212, 165, 116, 0.1)" : "rgba(139, 105, 20, 0.08)",
    goldBorder: isDark ? "rgba(212, 165, 116, 0.3)" : "rgba(139, 105, 20, 0.25)",
  };

  return (
    <Box
      onClick={onClick}
      sx={{
        p: 2,
        mb: 1,
        borderRadius: "8px",
        border: "1px solid",
        borderColor: selected ? colors.selectedBorder : "neutral.outlinedBorder",
        bgcolor: selected ? colors.goldSoftBg : "background.surface",
        cursor: "pointer",
        transition: "all 0.2s ease",
        "&:active": {
          bgcolor: colors.goldSoftBg,
        },
      }}
    >
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", mb: 1 }}>
        <Typography
          sx={{
            fontFamily: "code",
            fontSize: "0.85rem",
            fontWeight: 600,
            color: "text.primary",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {epic.name}
        </Typography>
        <Chip
          size="sm"
          variant="soft"
          sx={{
            fontFamily: "code",
            fontSize: "0.6rem",
            bgcolor: getStatusBgColor(epic.status, isDark),
            color: getStatusColor(epic.status, isDark),
            ml: 1,
            textTransform: "uppercase",
          }}
        >
          {epic.status}
        </Chip>
      </Box>
      <Typography
        sx={{
          fontFamily: "code",
          fontSize: "0.75rem",
          color: "text.secondary",
          mb: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {epic.goal}
      </Typography>
      {epic.progress !== undefined && (
        <Box sx={{ mb: 1 }}>
          <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
            <Typography sx={{ fontFamily: "code", fontSize: "0.65rem", color: "text.tertiary" }}>
              Progress
            </Typography>
            <Typography sx={{ fontFamily: "code", fontSize: "0.65rem", color: colors.amber }}>
              {epic.progress}%
            </Typography>
          </Box>
          <LinearProgress
            determinate
            value={epic.progress}
            sx={{
              height: 4,
              bgcolor: isDark ? "rgba(212, 165, 116, 0.2)" : "rgba(139, 105, 20, 0.15)",
              "& .MuiLinearProgress-bar": {
                bgcolor: colors.amber,
              },
            }}
          />
        </Box>
      )}
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {epic.leadAgentId && (
          <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: colors.amber }}>
            Lead: {agent?.name || epic.leadAgentId.slice(0, 8)}
          </Typography>
        )}
        <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
          {formatSmartTime(epic.createdAt)}
        </Typography>
      </Box>
      {epic.tags && epic.tags.length > 0 && (
        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 1 }}>
          {epic.tags.slice(0, 3).map((tag) => (
            <Chip
              key={tag}
              size="sm"
              variant="soft"
              sx={{
                fontFamily: "code",
                fontSize: "0.55rem",
                bgcolor: colors.goldSoftBg,
                color: colors.gold,
                border: `1px solid ${colors.goldBorder}`,
              }}
            >
              {tag}
            </Chip>
          ))}
        </Box>
      )}
    </Box>
  );
}

export default function EpicsPanel({
  selectedEpicId,
  onSelectEpic,
  statusFilter: controlledStatusFilter,
  onStatusFilterChange,
}: EpicsPanelProps) {
  const [internalStatusFilter, setInternalStatusFilter] = useState<EpicStatus | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const statusFilter = controlledStatusFilter ?? internalStatusFilter;
  const setStatusFilter = onStatusFilterChange ?? setInternalStatusFilter;

  const { mode } = useColorScheme();
  const isDark = mode === "dark";
  const { data: agents } = useAgents();

  const colors = {
    gold: isDark ? "#D4A574" : "#8B6914",
    goldGlow: isDark ? "0 0 8px rgba(212, 165, 116, 0.5)" : "0 0 6px rgba(139, 105, 20, 0.3)",
    amber: isDark ? "#F5A623" : "#D48806",
    amberGlow: isDark ? "0 0 10px rgba(245, 166, 35, 0.2)" : "0 0 8px rgba(212, 136, 6, 0.15)",
    hoverBg: isDark ? "rgba(245, 166, 35, 0.03)" : "rgba(212, 136, 6, 0.03)",
    hoverBorder: isDark ? "#4A3A2F" : "#D1C5B4",
  };

  // Build filters for API call
  const filters = useMemo(() => {
    const f: { status?: string; search?: string } = {};
    if (statusFilter !== "all") f.status = statusFilter;
    if (searchQuery.trim()) f.search = searchQuery.trim();
    return Object.keys(f).length > 0 ? f : undefined;
  }, [statusFilter, searchQuery]);

  const { data: epicsData, isLoading } = useEpics(filters);
  const epics = epicsData?.epics ?? [];
  const totalCount = epicsData?.total ?? 0;

  // Create agent lookup
  const agentMap = useMemo(() => {
    const map = new Map();
    agents?.forEach((a) => map.set(a.id, a));
    return map;
  }, [agents]);

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
          display: "flex",
          flexDirection: { xs: "column", sm: "row" },
          alignItems: { xs: "stretch", sm: "center" },
          justifyContent: "space-between",
          px: { xs: 1.5, md: 2 },
          py: 1.5,
          borderBottom: "1px solid",
          borderColor: "neutral.outlinedBorder",
          bgcolor: "background.level1",
          gap: 1.5,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {/* Hex accent */}
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
            level="title-md"
            sx={{
              fontFamily: "display",
              fontWeight: 600,
              color: colors.gold,
              letterSpacing: "0.03em",
              fontSize: { xs: "0.9rem", md: "1rem" },
            }}
          >
            EPICS
          </Typography>
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.7rem",
              color: "text.tertiary",
            }}
          >
            ({totalCount})
          </Typography>
        </Box>

        {/* Filters */}
        <Box
          sx={{
            display: "flex",
            flexDirection: { xs: "column", sm: "row" },
            alignItems: { xs: "stretch", sm: "center" },
            gap: 1,
          }}
        >
          {/* Search */}
          <Input
            placeholder="Search epics..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            size="sm"
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              minWidth: { xs: "100%", sm: 180 },
              bgcolor: "background.surface",
              borderColor: "neutral.outlinedBorder",
              color: "text.primary",
              "&:hover": {
                borderColor: colors.hoverBorder,
              },
              "&:focus-within": {
                borderColor: colors.amber,
                boxShadow: colors.amberGlow,
              },
            }}
          />

          {/* Status Filter */}
          <Select
            value={statusFilter}
            onChange={(_, value) => {
              if (value) setStatusFilter(value as EpicStatus | "all");
            }}
            size="sm"
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              minWidth: { xs: "100%", sm: 120 },
              bgcolor: "background.surface",
              borderColor: "neutral.outlinedBorder",
              color: "text.secondary",
              "&:hover": {
                borderColor: colors.amber,
              },
              "& .MuiSelect-indicator": {
                color: "text.tertiary",
              },
            }}
          >
            <Option value="all">ALL</Option>
            <Option value="draft">DRAFT</Option>
            <Option value="active">ACTIVE</Option>
            <Option value="paused">PAUSED</Option>
            <Option value="completed">COMPLETED</Option>
            <Option value="cancelled">CANCELLED</Option>
          </Select>
        </Box>
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: "auto" }}>
        {isLoading ? (
          <Box sx={{ p: 3, textAlign: "center" }}>
            <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
              Loading epics...
            </Typography>
          </Box>
        ) : epics.length === 0 ? (
          <Box sx={{ p: 3, textAlign: "center" }}>
            <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
              No epics found
            </Typography>
          </Box>
        ) : (
          <>
            {/* Desktop Table */}
            <Box sx={{ display: { xs: "none", md: "block" } }}>
              <Table
                size="sm"
                sx={{
                  "--TableCell-paddingY": "10px",
                  "--TableCell-paddingX": "12px",
                  "--TableCell-borderColor": "var(--joy-palette-neutral-outlinedBorder)",
                  tableLayout: "fixed",
                  width: "100%",
                  "& thead th": {
                    bgcolor: "background.surface",
                    fontFamily: "code",
                    fontSize: "0.7rem",
                    letterSpacing: "0.05em",
                    color: "text.tertiary",
                    borderBottom: "1px solid",
                    borderColor: "neutral.outlinedBorder",
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                  },
                  "& tbody tr": {
                    transition: "background-color 0.2s ease",
                    cursor: "pointer",
                  },
                  "& tbody tr:hover": {
                    bgcolor: colors.hoverBg,
                  },
                }}
              >
                <thead>
                  <tr>
                    <th style={{ width: "18%" }}>NAME</th>
                    <th style={{ width: "28%" }}>GOAL</th>
                    <th style={{ width: "10%" }}>STATUS</th>
                    <th style={{ width: "12%" }}>PROGRESS</th>
                    <th style={{ width: "12%" }}>LEAD</th>
                    <th style={{ width: "10%" }}>CREATED</th>
                    <th style={{ width: "10%" }}>TAGS</th>
                  </tr>
                </thead>
                <tbody>
                  {epics.map((epic) => {
                    const epicWithProgress = epic as Epic & { progress?: number; taskStats?: { total: number; completed: number } };
                    const progress = epicWithProgress.progress ??
                      (epicWithProgress.taskStats?.total
                        ? Math.round((epicWithProgress.taskStats.completed / epicWithProgress.taskStats.total) * 100)
                        : 0);
                    return (
                      <tr
                        key={epic.id}
                        onClick={() => onSelectEpic(selectedEpicId === epic.id ? null : epic.id)}
                      >
                        <td>
                          <Typography
                            sx={{
                              fontFamily: "code",
                              fontSize: "0.8rem",
                              fontWeight: 600,
                              color: "text.primary",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {epic.name}
                          </Typography>
                        </td>
                        <td>
                          <Typography
                            sx={{
                              fontFamily: "code",
                              fontSize: "0.75rem",
                              color: "text.secondary",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {epic.goal}
                          </Typography>
                        </td>
                        <td>
                          <Chip
                            size="sm"
                            variant="soft"
                            sx={{
                              fontFamily: "code",
                              fontSize: "0.6rem",
                              bgcolor: getStatusBgColor(epic.status, isDark),
                              color: getStatusColor(epic.status, isDark),
                              textTransform: "uppercase",
                            }}
                          >
                            {epic.status}
                          </Chip>
                        </td>
                        <td>
                          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                            <LinearProgress
                              determinate
                              value={progress}
                              sx={{
                                flex: 1,
                                height: 6,
                                borderRadius: 3,
                                bgcolor: isDark ? "rgba(212, 165, 116, 0.2)" : "rgba(139, 105, 20, 0.15)",
                                "& .MuiLinearProgress-bar": {
                                  bgcolor: colors.amber,
                                  borderRadius: 3,
                                },
                              }}
                            />
                            <Typography
                              sx={{
                                fontFamily: "code",
                                fontSize: "0.7rem",
                                color: colors.amber,
                                minWidth: "32px",
                              }}
                            >
                              {progress}%
                            </Typography>
                          </Box>
                        </td>
                        <td>
                          {epic.leadAgentId ? (
                            <Typography
                              sx={{
                                fontFamily: "code",
                                fontSize: "0.75rem",
                                color: colors.amber,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {agentMap.get(epic.leadAgentId)?.name || epic.leadAgentId.slice(0, 8)}
                            </Typography>
                          ) : (
                            <Typography
                              sx={{
                                fontFamily: "code",
                                fontSize: "0.75rem",
                                color: "text.tertiary",
                              }}
                            >
                              —
                            </Typography>
                          )}
                        </td>
                        <td>
                          <Typography
                            sx={{
                              fontFamily: "code",
                              fontSize: "0.7rem",
                              color: "text.tertiary",
                            }}
                          >
                            {formatSmartTime(epic.createdAt)}
                          </Typography>
                        </td>
                        <td>
                          {epic.tags && epic.tags.length > 0 ? (
                            <Box sx={{ display: "flex", gap: 0.5, flexWrap: "nowrap", overflow: "hidden" }}>
                              {epic.tags.slice(0, 2).map((tag) => (
                                <Chip
                                  key={tag}
                                  size="sm"
                                  variant="soft"
                                  sx={{
                                    fontFamily: "code",
                                    fontSize: "0.6rem",
                                    bgcolor: isDark ? "rgba(212, 165, 116, 0.1)" : "rgba(139, 105, 20, 0.08)",
                                    color: colors.gold,
                                    border: `1px solid ${isDark ? "rgba(212, 165, 116, 0.3)" : "rgba(139, 105, 20, 0.25)"}`,
                                  }}
                                >
                                  {tag}
                                </Chip>
                              ))}
                              {epic.tags.length > 2 && (
                                <Typography sx={{ fontFamily: "code", fontSize: "0.6rem", color: "text.tertiary" }}>
                                  +{epic.tags.length - 2}
                                </Typography>
                              )}
                            </Box>
                          ) : (
                            <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
                              —
                            </Typography>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </Box>

            {/* Mobile Cards */}
            <Box sx={{ display: { xs: "block", md: "none" }, p: 1.5 }}>
              {epics.map((epic) => {
                const epicWithProgress = epic as Epic & { progress?: number };
                return (
                  <EpicCard
                    key={epic.id}
                    epic={epicWithProgress}
                    selected={selectedEpicId === epic.id}
                    onClick={() => onSelectEpic(selectedEpicId === epic.id ? null : epic.id)}
                    agent={epic.leadAgentId ? agentMap.get(epic.leadAgentId) : undefined}
                    isDark={isDark}
                  />
                );
              })}
            </Box>
          </>
        )}
      </Box>
    </Card>
  );
}

import Box from "@mui/joy/Box";
import Card from "@mui/joy/Card";
import Chip from "@mui/joy/Chip";
import Input from "@mui/joy/Input";
import LinearProgress from "@mui/joy/LinearProgress";
import Option from "@mui/joy/Option";
import Select from "@mui/joy/Select";
import { useColorScheme } from "@mui/joy/styles";
import Table from "@mui/joy/Table";
import Typography from "@mui/joy/Typography";
import { useMemo, useState } from "react";
import { useAgents, useEpics } from "../hooks/queries";
import type { Epic, EpicStatus } from "../types/api";
import StatusBadge from "./StatusBadge";

interface EpicsPanelProps {
  onSelectEpic: (epicId: string) => void;
  statusFilter?: EpicStatus | "all";
  onStatusFilterChange?: (status: EpicStatus | "all") => void;
}

function formatSmartTime(dateStr: string): string {
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

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Mobile card component
interface EpicCardProps {
  epic: Epic;
  onClick: () => void;
  leadAgentName?: string;
  isDark: boolean;
}

function EpicCard({ epic, onClick, leadAgentName, isDark }: EpicCardProps) {
  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
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
        borderColor: "neutral.outlinedBorder",
        bgcolor: "background.surface",
        cursor: "pointer",
        transition: "all 0.2s ease",
        "&:active": {
          bgcolor: colors.goldSoftBg,
        },
      }}
    >
      <Typography
        sx={{
          fontFamily: "code",
          fontSize: "0.85rem",
          fontWeight: 600,
          color: "text.primary",
          mb: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {epic.name}
      </Typography>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 0.5 }}>
        <StatusBadge status={epic.status} />
        <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
          P{epic.priority}
        </Typography>
      </Box>
      {epic.goal && (
        <Typography
          sx={{
            fontFamily: "code",
            fontSize: "0.7rem",
            color: "text.secondary",
            mt: 0.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {epic.goal}
        </Typography>
      )}
      {leadAgentName && (
        <Box sx={{ display: "flex", gap: 0.5, alignItems: "center", mt: 0.5 }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: colors.amber }}>
            Lead: {leadAgentName}
          </Typography>
        </Box>
      )}
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

  const filters = useMemo(() => {
    const f: { status?: string; search?: string } = {};
    if (statusFilter !== "all") f.status = statusFilter;
    if (searchQuery.trim()) f.search = searchQuery.trim();
    return Object.keys(f).length > 0 ? f : undefined;
  }, [statusFilter, searchQuery]);

  const { data: epicsData, isLoading } = useEpics(filters);
  const epics = epicsData?.epics;
  const totalCount = epicsData?.total ?? 0;

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

          <Select
            value={statusFilter}
            onChange={(_, value) => setStatusFilter(value as EpicStatus | "all")}
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
            <Option value="all">ALL STATUS</Option>
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
        ) : !epics || epics.length === 0 ? (
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
                    <th style={{ width: "25%" }}>NAME</th>
                    <th style={{ width: "25%" }}>GOAL</th>
                    <th style={{ width: "10%" }}>STATUS</th>
                    <th style={{ width: "10%" }}>PRIORITY</th>
                    <th style={{ width: "12%" }}>LEAD</th>
                    <th style={{ width: "10%" }}>TAGS</th>
                    <th style={{ width: "8%" }}>UPDATED</th>
                  </tr>
                </thead>
                <tbody>
                  {epics.slice(0, 50).map((epic) => (
                    <tr key={epic.id} onClick={() => onSelectEpic(epic.id)}>
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
                          {epic.goal || "—"}
                        </Typography>
                      </td>
                      <td>
                        <StatusBadge status={epic.status} />
                      </td>
                      <td>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                          <LinearProgress
                            determinate
                            value={epic.priority}
                            sx={{
                              flex: 1,
                              height: 4,
                              bgcolor: "neutral.softBg",
                              "& .MuiLinearProgress-bar": {
                                bgcolor: colors.amber,
                              },
                            }}
                          />
                          <Typography
                            sx={{
                              fontFamily: "code",
                              fontSize: "0.7rem",
                              color: "text.tertiary",
                              minWidth: "2em",
                            }}
                          >
                            {epic.priority}
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
                        {epic.tags && epic.tags.length > 0 ? (
                          <Box
                            sx={{
                              display: "flex",
                              gap: 0.5,
                              flexWrap: "nowrap",
                              overflow: "hidden",
                            }}
                          >
                            {epic.tags.slice(0, 2).map((tag) => (
                              <Chip
                                key={tag}
                                size="sm"
                                variant="soft"
                                sx={{
                                  fontFamily: "code",
                                  fontSize: "0.6rem",
                                  bgcolor: isDark
                                    ? "rgba(212, 165, 116, 0.1)"
                                    : "rgba(139, 105, 20, 0.08)",
                                  color: colors.gold,
                                  border: `1px solid ${isDark ? "rgba(212, 165, 116, 0.3)" : "rgba(139, 105, 20, 0.25)"}`,
                                }}
                              >
                                {tag}
                              </Chip>
                            ))}
                            {epic.tags.length > 2 && (
                              <Typography
                                sx={{
                                  fontFamily: "code",
                                  fontSize: "0.6rem",
                                  color: "text.tertiary",
                                }}
                              >
                                +{epic.tags.length - 2}
                              </Typography>
                            )}
                          </Box>
                        ) : (
                          <Typography
                            sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}
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
                          {formatSmartTime(epic.lastUpdatedAt)}
                        </Typography>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Box>

            {/* Mobile Cards */}
            <Box sx={{ display: { xs: "block", md: "none" }, p: 1.5 }}>
              {epics.slice(0, 50).map((epic) => (
                <EpicCard
                  key={epic.id}
                  epic={epic}
                  onClick={() => onSelectEpic(epic.id)}
                  leadAgentName={
                    epic.leadAgentId ? agentMap.get(epic.leadAgentId)?.name : undefined
                  }
                  isDark={isDark}
                />
              ))}
            </Box>
          </>
        )}
      </Box>

      {/* Footer */}
      {epics && totalCount > epics.length && (
        <Box
          sx={{
            p: 1.5,
            textAlign: "center",
            borderTop: "1px solid",
            borderColor: "neutral.outlinedBorder",
            bgcolor: "background.level1",
          }}
        >
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.7rem",
              color: "text.tertiary",
            }}
          >
            Showing {Math.min(50, epics.length)} of {totalCount} epics
          </Typography>
        </Box>
      )}
    </Card>
  );
}

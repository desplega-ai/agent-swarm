import { useState, useMemo } from "react";
import Box from "@mui/joy/Box";
import Card from "@mui/joy/Card";
import Typography from "@mui/joy/Typography";
import Table from "@mui/joy/Table";
import Select from "@mui/joy/Select";
import Option from "@mui/joy/Option";
import Input from "@mui/joy/Input";
import Chip from "@mui/joy/Chip";
import { useColorScheme } from "@mui/joy/styles";
import { useScheduledTasks, useAgents } from "../hooks/queries";
import type { ScheduledTask } from "../types/api";

interface ScheduledTasksPanelProps {
  selectedScheduleId: string | null;
  onSelectSchedule: (scheduleId: string | null) => void;
  enabledFilter?: boolean | "all";
  onEnabledFilterChange?: (enabled: boolean | "all") => void;
}

function formatInterval(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
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

  return date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatNextRun(dateStr: string | undefined): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);

  if (diffMs < 0) return "overdue";
  if (diffMins < 1) return "< 1m";
  if (diffMins < 60) return `in ${diffMins}m`;
  if (diffHours < 24) return `in ${diffHours}h ${diffMins % 60}m`;

  return date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Mobile card component
interface ScheduleCardProps {
  schedule: ScheduledTask;
  selected: boolean;
  onClick: () => void;
  agent?: import("../types/api").Agent;
  isDark: boolean;
}

function ScheduleCard({ schedule, selected, onClick, agent, isDark }: ScheduleCardProps) {
  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
    selectedBorder: isDark ? "#D4A574" : "#8B6914",
    goldSoftBg: isDark ? "rgba(212, 165, 116, 0.1)" : "rgba(139, 105, 20, 0.08)",
    goldBorder: isDark ? "rgba(212, 165, 116, 0.3)" : "rgba(139, 105, 20, 0.25)",
    green: isDark ? "#4CAF50" : "#2E7D32",
    red: isDark ? "#EF5350" : "#D32F2F",
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
          {schedule.name}
        </Typography>
        <Chip
          size="sm"
          variant="soft"
          sx={{
            fontFamily: "code",
            fontSize: "0.6rem",
            bgcolor: schedule.enabled
              ? isDark ? "rgba(76, 175, 80, 0.15)" : "rgba(46, 125, 50, 0.1)"
              : isDark ? "rgba(239, 83, 80, 0.15)" : "rgba(211, 47, 47, 0.1)",
            color: schedule.enabled ? colors.green : colors.red,
            ml: 1,
          }}
        >
          {schedule.enabled ? "ENABLED" : "DISABLED"}
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
        {schedule.taskTemplate}
      </Typography>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: colors.amber }}>
          {schedule.cronExpression || (schedule.intervalMs ? `every ${formatInterval(schedule.intervalMs)}` : "—")}
        </Typography>
        <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
          Next: {formatNextRun(schedule.nextRunAt)}
        </Typography>
      </Box>
      {schedule.targetAgentId && (
        <Box sx={{ display: "flex", gap: 0.5, alignItems: "center", mt: 0.5 }}>
          <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: colors.amber }}>
            Target: {agent?.name || schedule.targetAgentId.slice(0, 8)}
          </Typography>
        </Box>
      )}
      {schedule.tags && schedule.tags.length > 0 && (
        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 1 }}>
          {schedule.tags.slice(0, 3).map((tag) => (
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

export default function ScheduledTasksPanel({
  selectedScheduleId,
  onSelectSchedule,
  enabledFilter: controlledEnabledFilter,
  onEnabledFilterChange,
}: ScheduledTasksPanelProps) {
  const [internalEnabledFilter, setInternalEnabledFilter] = useState<boolean | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const enabledFilter = controlledEnabledFilter ?? internalEnabledFilter;
  const setEnabledFilter = onEnabledFilterChange ?? setInternalEnabledFilter;

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
    green: isDark ? "#4CAF50" : "#2E7D32",
    red: isDark ? "#EF5350" : "#D32F2F",
  };

  // Build filters for API call
  const filters = useMemo(() => {
    const f: { enabled?: boolean; name?: string } = {};
    if (enabledFilter !== "all") f.enabled = enabledFilter;
    if (searchQuery.trim()) f.name = searchQuery.trim();
    return Object.keys(f).length > 0 ? f : undefined;
  }, [enabledFilter, searchQuery]);

  const { data: schedules, isLoading } = useScheduledTasks(filters);
  const totalCount = schedules?.length ?? 0;

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
            SCHEDULED TASKS
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
            placeholder="Search schedules..."
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

          {/* Enabled Filter */}
          <Select
            value={String(enabledFilter)}
            onChange={(_, value) => {
              if (value === "all") setEnabledFilter("all");
              else if (value === "true") setEnabledFilter(true);
              else setEnabledFilter(false);
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
            <Option value="true">ENABLED</Option>
            <Option value="false">DISABLED</Option>
          </Select>
        </Box>
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: "auto" }}>
        {isLoading ? (
          <Box sx={{ p: 3, textAlign: "center" }}>
            <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
              Loading scheduled tasks...
            </Typography>
          </Box>
        ) : !schedules || schedules.length === 0 ? (
          <Box sx={{ p: 3, textAlign: "center" }}>
            <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
              No scheduled tasks found
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
                    <th style={{ width: "15%" }}>NAME</th>
                    <th style={{ width: "25%" }}>TASK TEMPLATE</th>
                    <th style={{ width: "12%" }}>SCHEDULE</th>
                    <th style={{ width: "10%" }}>TARGET</th>
                    <th style={{ width: "8%" }}>STATUS</th>
                    <th style={{ width: "10%" }}>LAST RUN</th>
                    <th style={{ width: "10%" }}>NEXT RUN</th>
                    <th style={{ width: "10%" }}>TAGS</th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((schedule) => (
                    <tr
                      key={schedule.id}
                      onClick={() => onSelectSchedule(selectedScheduleId === schedule.id ? null : schedule.id)}
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
                          {schedule.name}
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
                          {schedule.taskTemplate}
                        </Typography>
                      </td>
                      <td>
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
                          {schedule.cronExpression || (schedule.intervalMs ? `${formatInterval(schedule.intervalMs)}` : "—")}
                        </Typography>
                      </td>
                      <td>
                        {schedule.targetAgentId ? (
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
                            {agentMap.get(schedule.targetAgentId)?.name || schedule.targetAgentId.slice(0, 8)}
                          </Typography>
                        ) : (
                          <Typography
                            sx={{
                              fontFamily: "code",
                              fontSize: "0.75rem",
                              color: "text.tertiary",
                            }}
                          >
                            Pool
                          </Typography>
                        )}
                      </td>
                      <td>
                        <Chip
                          size="sm"
                          variant="soft"
                          sx={{
                            fontFamily: "code",
                            fontSize: "0.6rem",
                            bgcolor: schedule.enabled
                              ? isDark ? "rgba(76, 175, 80, 0.15)" : "rgba(46, 125, 50, 0.1)"
                              : isDark ? "rgba(239, 83, 80, 0.15)" : "rgba(211, 47, 47, 0.1)",
                            color: schedule.enabled ? colors.green : colors.red,
                          }}
                        >
                          {schedule.enabled ? "ON" : "OFF"}
                        </Chip>
                      </td>
                      <td>
                        <Typography
                          sx={{
                            fontFamily: "code",
                            fontSize: "0.7rem",
                            color: "text.tertiary",
                          }}
                        >
                          {formatSmartTime(schedule.lastRunAt)}
                        </Typography>
                      </td>
                      <td>
                        <Typography
                          sx={{
                            fontFamily: "code",
                            fontSize: "0.7rem",
                            color: schedule.enabled ? colors.amber : "text.tertiary",
                          }}
                        >
                          {schedule.enabled ? formatNextRun(schedule.nextRunAt) : "—"}
                        </Typography>
                      </td>
                      <td>
                        {schedule.tags && schedule.tags.length > 0 ? (
                          <Box sx={{ display: "flex", gap: 0.5, flexWrap: "nowrap", overflow: "hidden" }}>
                            {schedule.tags.slice(0, 2).map((tag) => (
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
                            {schedule.tags.length > 2 && (
                              <Typography sx={{ fontFamily: "code", fontSize: "0.6rem", color: "text.tertiary" }}>
                                +{schedule.tags.length - 2}
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
                  ))}
                </tbody>
              </Table>
            </Box>

            {/* Mobile Cards */}
            <Box sx={{ display: { xs: "block", md: "none" }, p: 1.5 }}>
              {schedules.map((schedule) => (
                <ScheduleCard
                  key={schedule.id}
                  schedule={schedule}
                  selected={selectedScheduleId === schedule.id}
                  onClick={() => onSelectSchedule(selectedScheduleId === schedule.id ? null : schedule.id)}
                  agent={schedule.targetAgentId ? agentMap.get(schedule.targetAgentId) : undefined}
                  isDark={isDark}
                />
              ))}
            </Box>
          </>
        )}
      </Box>
    </Card>
  );
}

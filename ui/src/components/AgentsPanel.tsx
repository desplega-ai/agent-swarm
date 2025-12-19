import { useState, useMemo } from "react";
import Box from "@mui/joy/Box";
import Card from "@mui/joy/Card";
import Typography from "@mui/joy/Typography";
import Table from "@mui/joy/Table";
import Input from "@mui/joy/Input";
import Select from "@mui/joy/Select";
import Option from "@mui/joy/Option";
import { useColorScheme } from "@mui/joy/styles";
import { useAgents } from "../hooks/queries";
import StatusBadge from "./StatusBadge";
import type { AgentWithTasks, AgentStatus } from "../types/api";

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

  return date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface AgentsRowProps {
  agent: AgentWithTasks;
  selected: boolean;
  onClick: () => void;
  isDark: boolean;
}

function AgentRow({ agent, selected, onClick, isDark }: AgentsRowProps) {
  const activeTasks = agent.tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress"
  ).length;

  const isActive = agent.status === "busy";

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
    dormant: isDark ? "#6B5344" : "#A89A7C",
    selectedBg: isDark ? "rgba(245, 166, 35, 0.08)" : "rgba(212, 136, 6, 0.08)",
    amberGlow: isDark ? "0 0 10px rgba(245, 166, 35, 0.6)" : "0 0 8px rgba(212, 136, 6, 0.4)",
    amberSoftBg: isDark ? "rgba(245, 166, 35, 0.1)" : "rgba(212, 136, 6, 0.1)",
    amberBorder: isDark ? "rgba(245, 166, 35, 0.3)" : "rgba(212, 136, 6, 0.3)",
    amberTextShadow: isDark ? "0 0 10px rgba(245, 166, 35, 0.5)" : "none",
  };

  return (
    <tr
      onClick={onClick}
      style={{
        cursor: "pointer",
        backgroundColor: selected ? colors.selectedBg : undefined,
      }}
      className="row-hover"
    >
      <td>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          {/* Agent status dot */}
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              bgcolor: isActive ? colors.amber : agent.status === "idle" ? colors.gold : colors.dormant,
              boxShadow: isActive ? colors.amberGlow : "none",
              animation: isActive ? "pulse-amber 2s ease-in-out infinite" : undefined,
            }}
          />
          <Typography
            sx={{
              fontFamily: "code",
              fontWeight: 600,
              color: agent.isLead ? colors.amber : "text.primary",
            }}
          >
            {agent.name}
          </Typography>
          {agent.isLead && (
            <Typography
              sx={{
                fontFamily: "code",
                fontSize: "0.6rem",
                color: colors.amber,
                textShadow: colors.amberTextShadow,
                bgcolor: colors.amberSoftBg,
                px: 0.75,
                py: 0.25,
                borderRadius: 1,
                border: `1px solid ${colors.amberBorder}`,
              }}
            >
              LEAD
            </Typography>
          )}
        </Box>
      </td>
      <td>
        <Typography
          sx={{
            fontFamily: "code",
            fontSize: "0.75rem",
            color: agent.role ? "text.secondary" : "text.tertiary",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 120,
          }}
        >
          {agent.role || "—"}
        </Typography>
      </td>
      <td>
        <StatusBadge status={agent.status} />
      </td>
      <td>
        <Typography
          sx={{
            fontFamily: "code",
            fontSize: "0.8rem",
            color: activeTasks > 0 ? colors.amber : "text.tertiary",
            whiteSpace: "nowrap",
          }}
        >
          {activeTasks}/{agent.tasks.length}
        </Typography>
      </td>
      <td>
        <Typography
          sx={{
            fontFamily: "code",
            fontSize: "0.7rem",
            color: "text.tertiary",
          }}
        >
          {formatSmartTime(agent.lastUpdatedAt)}
        </Typography>
      </td>
    </tr>
  );
}

interface AgentsPanelProps {
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  statusFilter?: AgentStatus | "all";
  onStatusFilterChange?: (status: AgentStatus | "all") => void;
}

export default function AgentsPanel({
  selectedAgentId,
  onSelectAgent,
  statusFilter: controlledStatusFilter,
  onStatusFilterChange,
}: AgentsPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [internalStatusFilter, setInternalStatusFilter] = useState<AgentStatus | "all">("all");

  // Use controlled or internal state
  const statusFilter = controlledStatusFilter ?? internalStatusFilter;
  const setStatusFilter = onStatusFilterChange ?? setInternalStatusFilter;

  const { data: agents, isLoading } = useAgents();
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    amberGlow: isDark ? "0 0 8px rgba(245, 166, 35, 0.5)" : "0 0 6px rgba(212, 136, 6, 0.3)",
    hoverBg: isDark ? "rgba(245, 166, 35, 0.05)" : "rgba(212, 136, 6, 0.05)",
    hoverBorder: isDark ? "#4A3A2F" : "#D1C5B4",
    amberInputGlow: isDark ? "0 0 10px rgba(245, 166, 35, 0.2)" : "0 0 8px rgba(212, 136, 6, 0.15)",
  };

  // Filter agents based on search and status
  const filteredAgents = useMemo(() => {
    if (!agents) return [];

    return agents.filter((agent) => {
      // Search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        if (!agent.name.toLowerCase().includes(query) &&
            !agent.id.toLowerCase().includes(query)) {
          return false;
        }
      }

      // Status filter
      if (statusFilter !== "all" && agent.status !== statusFilter) {
        return false;
      }

      return true;
    });
  }, [agents, searchQuery, statusFilter]);

  if (isLoading) {
    return (
      <Card
        variant="outlined"
        sx={{
          p: 2,
          height: "100%",
          bgcolor: "background.surface",
          borderColor: "neutral.outlinedBorder",
        }}
      >
        <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
          Loading agents...
        </Typography>
      </Card>
    );
  }

  if (!agents || agents.length === 0) {
    return (
      <Card
        variant="outlined"
        sx={{
          p: 2,
          height: "100%",
          bgcolor: "background.surface",
          borderColor: "neutral.outlinedBorder",
        }}
      >
        <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
          No agents in the swarm
        </Typography>
      </Card>
    );
  }

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
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
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
              bgcolor: colors.amber,
              boxShadow: colors.amberGlow,
            }}
          />
          <Typography
            level="title-md"
            sx={{
              fontFamily: "display",
              fontWeight: 600,
              color: colors.amber,
              letterSpacing: "0.03em",
            }}
          >
            AGENTS
          </Typography>
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.7rem",
              color: "text.tertiary",
            }}
          >
            ({filteredAgents.length}/{agents.length})
          </Typography>
        </Box>

        {/* Filters */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {/* Search */}
          <Input
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            size="sm"
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              minWidth: 140,
              bgcolor: "background.surface",
              borderColor: "neutral.outlinedBorder",
              color: "text.primary",
              "&:hover": {
                borderColor: colors.hoverBorder,
              },
              "&:focus-within": {
                borderColor: colors.amber,
                boxShadow: colors.amberInputGlow,
              },
            }}
          />

          {/* Status Filter */}
          <Select
            value={statusFilter}
            onChange={(_, value) => setStatusFilter(value as AgentStatus | "all")}
            size="sm"
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              minWidth: 100,
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
            <Option value="idle">IDLE</Option>
            <Option value="busy">BUSY</Option>
            <Option value="offline">OFFLINE</Option>
          </Select>
        </Box>
      </Box>

      {/* Table */}
      <Box sx={{ flex: 1, overflow: "auto" }}>
        {filteredAgents.length === 0 ? (
          <Box sx={{ p: 3, textAlign: "center" }}>
            <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
              No agents match your filters
            </Typography>
          </Box>
        ) : (
          <Table
            size="sm"
            sx={{
              "--TableCell-paddingY": "10px",
              "--TableCell-paddingX": "12px",
              "--TableCell-borderColor": "var(--joy-palette-neutral-outlinedBorder)",
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
              },
              "& tbody tr:hover": {
                bgcolor: colors.hoverBg,
              },
            }}
          >
            <thead>
              <tr>
                <th>NAME</th>
                <th style={{ width: "130px" }}>ROLE</th>
                <th style={{ width: "90px" }}>STATUS</th>
                <th style={{ width: "70px" }}>TASKS</th>
                <th style={{ width: "100px" }}>UPDATED</th>
              </tr>
            </thead>
            <tbody>
              {filteredAgents.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  selected={selectedAgentId === agent.id}
                  onClick={() => onSelectAgent(selectedAgentId === agent.id ? null : agent.id)}
                  isDark={isDark}
                />
              ))}
            </tbody>
          </Table>
        )}
      </Box>
    </Card>
  );
}

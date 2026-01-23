import Box from "@mui/joy/Box";
import Card from "@mui/joy/Card";
import Chip from "@mui/joy/Chip";
import Input from "@mui/joy/Input";
import Link from "@mui/joy/Link";
import Option from "@mui/joy/Option";
import Select from "@mui/joy/Select";
import { useColorScheme } from "@mui/joy/styles";
import Table from "@mui/joy/Table";
import Typography from "@mui/joy/Typography";
import { useMemo, useState } from "react";
import { useAgents, useServices } from "../hooks/queries";
import type { ServiceStatus } from "../types/api";

interface ServicesPanelProps {
  statusFilter?: ServiceStatus | "all";
  onStatusFilterChange?: (status: ServiceStatus | "all") => void;
}

function formatSmartTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);

  // Less than 6 hours: relative time
  if (diffHours < 6) {
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    return `${diffHours}h ago`;
  }

  // Same day: time only
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Before today: full date
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getStatusColor(
  status: ServiceStatus,
  isDark: boolean,
): { bg: string; text: string; border: string } {
  switch (status) {
    case "healthy":
      return {
        bg: isDark ? "rgba(34, 197, 94, 0.15)" : "rgba(34, 197, 94, 0.1)",
        text: isDark ? "#22c55e" : "#16a34a",
        border: isDark ? "rgba(34, 197, 94, 0.4)" : "rgba(34, 197, 94, 0.3)",
      };
    case "starting":
      return {
        bg: isDark ? "rgba(245, 166, 35, 0.15)" : "rgba(245, 166, 35, 0.1)",
        text: isDark ? "#F5A623" : "#D48806",
        border: isDark ? "rgba(245, 166, 35, 0.4)" : "rgba(245, 166, 35, 0.3)",
      };
    case "unhealthy":
      return {
        bg: isDark ? "rgba(239, 68, 68, 0.15)" : "rgba(239, 68, 68, 0.1)",
        text: isDark ? "#ef4444" : "#dc2626",
        border: isDark ? "rgba(239, 68, 68, 0.4)" : "rgba(239, 68, 68, 0.3)",
      };
    case "stopped":
      return {
        bg: isDark ? "rgba(107, 114, 128, 0.15)" : "rgba(107, 114, 128, 0.1)",
        text: isDark ? "#9ca3af" : "#6b7280",
        border: isDark ? "rgba(107, 114, 128, 0.4)" : "rgba(107, 114, 128, 0.3)",
      };
  }
}

// Mobile card component
interface ServiceCardProps {
  service: {
    id: string;
    name: string;
    agentId: string;
    port: number;
    status: ServiceStatus;
    description?: string;
    url?: string;
    interpreter?: string;
    lastUpdatedAt: string;
  };
  agentName?: string;
  isDark: boolean;
}

function ServiceCard({ service, agentName, isDark }: ServiceCardProps) {
  const statusColors = getStatusColor(service.status, isDark);
  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
  };

  return (
    <Box
      sx={{
        p: 2,
        mb: 1,
        borderRadius: "8px",
        border: "1px solid",
        borderColor: "neutral.outlinedBorder",
        bgcolor: "background.surface",
      }}
    >
      <Box
        sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", mb: 1 }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.85rem",
              fontWeight: 600,
              color: "text.primary",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {service.name}
          </Typography>
          {service.url && (
            <Link
              href={service.url}
              target="_blank"
              rel="noopener noreferrer"
              sx={{
                fontFamily: "code",
                fontSize: "0.65rem",
                color: colors.amber,
                display: "block",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {service.url}
            </Link>
          )}
        </Box>
        <Chip
          size="sm"
          variant="soft"
          sx={{
            fontFamily: "code",
            fontSize: "0.6rem",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            bgcolor: statusColors.bg,
            color: statusColors.text,
            border: `1px solid ${statusColors.border}`,
            flexShrink: 0,
            ml: 1,
          }}
        >
          {service.status}
        </Chip>
      </Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5, mt: 1 }}>
        <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: colors.amber }}>
          Agent: {agentName || service.agentId.slice(0, 8)}
        </Typography>
        <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.secondary" }}>
          Port: {service.port}
        </Typography>
        {service.interpreter && (
          <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
            {service.interpreter}
          </Typography>
        )}
      </Box>
      {service.description && (
        <Typography
          sx={{
            fontFamily: "code",
            fontSize: "0.7rem",
            color: "text.tertiary",
            mt: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {service.description}
        </Typography>
      )}
    </Box>
  );
}

export default function ServicesPanel({
  statusFilter: controlledStatusFilter,
  onStatusFilterChange,
}: ServicesPanelProps) {
  const [internalStatusFilter, setInternalStatusFilter] = useState<ServiceStatus | "all">("all");
  const [agentFilter, setAgentFilter] = useState<string | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Use controlled or internal state
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
    const f: { status?: string; agentId?: string; name?: string } = {};
    if (statusFilter !== "all") f.status = statusFilter;
    if (agentFilter !== "all") f.agentId = agentFilter;
    if (searchQuery.trim()) f.name = searchQuery.trim();
    return Object.keys(f).length > 0 ? f : undefined;
  }, [statusFilter, agentFilter, searchQuery]);

  const { data: services, isLoading } = useServices(filters);

  // Create agent lookup
  const agentMap = useMemo(() => {
    const map = new Map<string, string>();
    agents?.forEach((a) => map.set(a.id, a.name));
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
            SERVICES
          </Typography>
          <Typography
            sx={{
              fontFamily: "code",
              fontSize: "0.7rem",
              color: "text.tertiary",
            }}
          >
            ({services?.length || 0})
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
            placeholder="Search services..."
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

          {/* Agent Filter - hidden on mobile to save space */}
          <Select
            value={agentFilter}
            onChange={(_, value) => setAgentFilter(value as string)}
            size="sm"
            sx={{
              fontFamily: "code",
              fontSize: "0.75rem",
              minWidth: { xs: "100%", sm: 130 },
              display: { xs: "none", sm: "flex" },
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
            <Option value="all">ALL AGENTS</Option>
            {agents?.map((agent) => (
              <Option key={agent.id} value={agent.id}>
                {agent.name}
              </Option>
            ))}
          </Select>

          {/* Status Filter */}
          <Select
            value={statusFilter}
            onChange={(_, value) => setStatusFilter(value as ServiceStatus | "all")}
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
            <Option value="starting">STARTING</Option>
            <Option value="healthy">HEALTHY</Option>
            <Option value="unhealthy">UNHEALTHY</Option>
            <Option value="stopped">STOPPED</Option>
          </Select>
        </Box>
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: "auto" }}>
        {isLoading ? (
          <Box sx={{ p: 3, textAlign: "center" }}>
            <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
              Loading services...
            </Typography>
          </Box>
        ) : !services || services.length === 0 ? (
          <Box sx={{ p: 3, textAlign: "center" }}>
            <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
              No services found
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
                  },
                  "& tbody tr:hover": {
                    bgcolor: colors.hoverBg,
                  },
                }}
              >
                <thead>
                  <tr>
                    <th style={{ width: "20%" }}>NAME</th>
                    <th style={{ width: "15%" }}>AGENT</th>
                    <th style={{ width: "10%" }}>PORT</th>
                    <th style={{ width: "10%" }}>STATUS</th>
                    <th style={{ width: "25%" }}>DESCRIPTION</th>
                    <th style={{ width: "10%" }}>INTERPRETER</th>
                    <th style={{ width: "10%" }}>UPDATED</th>
                  </tr>
                </thead>
                <tbody>
                  {services.slice(0, 50).map((service) => {
                    const statusColors = getStatusColor(service.status, isDark);
                    return (
                      <tr key={service.id}>
                        <td>
                          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
                            <Typography
                              sx={{
                                fontFamily: "code",
                                fontSize: "0.8rem",
                                color: "text.primary",
                                fontWeight: 500,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {service.name}
                            </Typography>
                            {service.url && (
                              <Link
                                href={service.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                sx={{
                                  fontFamily: "code",
                                  fontSize: "0.65rem",
                                  color: colors.amber,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {service.url}
                              </Link>
                            )}
                          </Box>
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
                            {agentMap.get(service.agentId) || service.agentId.slice(0, 8)}
                          </Typography>
                        </td>
                        <td>
                          <Typography
                            sx={{
                              fontFamily: "code",
                              fontSize: "0.75rem",
                              color: "text.secondary",
                            }}
                          >
                            :{service.port}
                          </Typography>
                        </td>
                        <td>
                          <Chip
                            size="sm"
                            variant="soft"
                            sx={{
                              fontFamily: "code",
                              fontSize: "0.65rem",
                              fontWeight: 600,
                              textTransform: "uppercase",
                              letterSpacing: "0.03em",
                              bgcolor: statusColors.bg,
                              color: statusColors.text,
                              border: `1px solid ${statusColors.border}`,
                            }}
                          >
                            {service.status}
                          </Chip>
                        </td>
                        <td>
                          <Typography
                            sx={{
                              fontFamily: "code",
                              fontSize: "0.7rem",
                              color: service.description ? "text.secondary" : "text.tertiary",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {service.description || "—"}
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
                            {service.interpreter || "auto"}
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
                            {formatSmartTime(service.lastUpdatedAt)}
                          </Typography>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </Box>

            {/* Mobile Cards */}
            <Box sx={{ display: { xs: "block", md: "none" }, p: 1.5 }}>
              {services.slice(0, 50).map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  agentName={agentMap.get(service.agentId)}
                  isDark={isDark}
                />
              ))}
            </Box>
          </>
        )}
      </Box>

      {/* Footer */}
      {services && services.length > 50 && (
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
            Showing 50 of {services.length} services
          </Typography>
        </Box>
      )}
    </Card>
  );
}

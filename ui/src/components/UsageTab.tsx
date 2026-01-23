import Box from "@mui/joy/Box";
import Card from "@mui/joy/Card";
import Option from "@mui/joy/Option";
import Select from "@mui/joy/Select";
import { useColorScheme } from "@mui/joy/styles";
import Table from "@mui/joy/Table";
import Typography from "@mui/joy/Typography";
import { useMemo, useState } from "react";
import { useAgents, useSessionCosts } from "../hooks/queries";
import { formatCompactNumber, formatCurrency, formatDuration } from "../lib/utils";
import { CostTrendChart, ModelUsageChart, TokenDistributionChart } from "./UsageCharts";

type TimeRange = "7d" | "30d" | "90d";

export default function UsageTab() {
  const [timeRange, setTimeRange] = useState<TimeRange>("30d");
  const { data: costs } = useSessionCosts({ limit: 2000 });
  const { data: agents } = useAgents();
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
    blue: "#3B82F6",
    green: "#22C55E",
    hoverBg: isDark ? "rgba(245, 166, 35, 0.05)" : "rgba(212, 136, 6, 0.05)",
    amberGlow: isDark ? "0 0 8px rgba(245, 166, 35, 0.5)" : "0 0 6px rgba(212, 136, 6, 0.3)",
  };

  // Filter costs by time range
  const filteredCosts = useMemo(() => {
    if (!costs) return [];

    const days = timeRange === "7d" ? 7 : timeRange === "30d" ? 30 : 90;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    return costs.filter((c) => new Date(c.createdAt) >= cutoff);
  }, [costs, timeRange]);

  // Calculate summary stats
  const summaryStats = useMemo(() => {
    return {
      totalCost: filteredCosts.reduce((sum, c) => sum + c.totalCostUsd, 0),
      totalTokens: filteredCosts.reduce((sum, c) => sum + c.inputTokens + c.outputTokens, 0),
      totalSessions: filteredCosts.length,
      totalDuration: filteredCosts.reduce((sum, c) => sum + c.durationMs, 0),
      avgCostPerSession:
        filteredCosts.length > 0
          ? filteredCosts.reduce((sum, c) => sum + c.totalCostUsd, 0) / filteredCosts.length
          : 0,
    };
  }, [filteredCosts]);

  // Agent leaderboard
  const agentLeaderboard = useMemo(() => {
    const byAgent = new Map<string, { cost: number; tokens: number; sessions: number }>();

    filteredCosts.forEach((c) => {
      const existing = byAgent.get(c.agentId) || { cost: 0, tokens: 0, sessions: 0 };
      byAgent.set(c.agentId, {
        cost: existing.cost + c.totalCostUsd,
        tokens: existing.tokens + c.inputTokens + c.outputTokens,
        sessions: existing.sessions + 1,
      });
    });

    return Array.from(byAgent.entries())
      .map(([agentId, data]) => ({
        agentId,
        agentName: agents?.find((a) => a.id === agentId)?.name || agentId.slice(0, 8),
        ...data,
      }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10);
  }, [filteredCosts, agents]);

  // Stat card component
  const StatCard = ({
    title,
    value,
    subValue,
    color,
  }: {
    title: string;
    value: string;
    subValue?: string;
    color: string;
  }) => (
    <Card
      variant="outlined"
      sx={{
        p: 2,
        bgcolor: "background.surface",
        borderColor: "neutral.outlinedBorder",
        flex: 1,
        minWidth: 140,
      }}
    >
      <Typography
        sx={{
          fontFamily: "code",
          fontSize: "0.65rem",
          color: "text.tertiary",
          letterSpacing: "0.05em",
          mb: 0.5,
        }}
      >
        {title}
      </Typography>
      <Typography sx={{ fontFamily: "code", fontSize: "1.5rem", fontWeight: 600, color }}>
        {value}
      </Typography>
      {subValue && (
        <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}>
          {subValue}
        </Typography>
      )}
    </Card>
  );

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
      {/* Header with time range selector */}
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
              fontSize: { xs: "0.9rem", md: "1rem" },
            }}
          >
            USAGE
          </Typography>
        </Box>

        <Select
          value={timeRange}
          onChange={(_, value) => value && setTimeRange(value)}
          size="sm"
          sx={{
            fontFamily: "code",
            fontSize: "0.75rem",
            bgcolor: "background.surface",
            borderColor: "neutral.outlinedBorder",
            minWidth: 100,
          }}
        >
          <Option value="7d">Last 7 days</Option>
          <Option value="30d">Last 30 days</Option>
          <Option value="90d">Last 90 days</Option>
        </Select>
      </Box>

      {/* Scrollable content area */}
      <Box
        sx={{
          flex: 1,
          overflow: "auto",
          p: { xs: 1.5, md: 2 },
          display: "flex",
          flexDirection: "column",
          gap: 3,
        }}
      >
        {/* Summary Stats */}
        <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
          <StatCard
            title="TOTAL COST"
            value={formatCurrency(summaryStats.totalCost)}
            color={colors.amber}
          />
          <StatCard
            title="TOTAL TOKENS"
            value={formatCompactNumber(summaryStats.totalTokens)}
            color={colors.green}
          />
          <StatCard
            title="SESSIONS"
            value={summaryStats.totalSessions.toString()}
            color={colors.blue}
          />
          <StatCard
            title="TOTAL TIME"
            value={formatDuration(summaryStats.totalDuration)}
            color={colors.gold}
          />
          <StatCard
            title="AVG COST/SESSION"
            value={formatCurrency(summaryStats.avgCostPerSession)}
            color={colors.amber}
          />
        </Box>

        {/* Charts */}
        <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {/* Cost Trend */}
          <Card
            variant="outlined"
            sx={{
              p: 2,
              bgcolor: "background.surface",
              borderColor: "neutral.outlinedBorder",
              flex: 2,
              minWidth: 300,
            }}
          >
            {filteredCosts.length > 0 ? (
              <CostTrendChart costs={filteredCosts} timeRange={timeRange} />
            ) : (
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
                No usage data available
              </Typography>
            )}
          </Card>

          {/* Token Distribution */}
          <Card
            variant="outlined"
            sx={{
              p: 2,
              bgcolor: "background.surface",
              borderColor: "neutral.outlinedBorder",
              flex: 1,
              minWidth: 250,
            }}
          >
            {filteredCosts.length > 0 ? (
              <TokenDistributionChart costs={filteredCosts} />
            ) : (
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
                No usage data
              </Typography>
            )}
          </Card>
        </Box>

        {/* Second Row: Model Usage + Agent Leaderboard */}
        <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {/* Model Usage */}
          <Card
            variant="outlined"
            sx={{
              p: 2,
              bgcolor: "background.surface",
              borderColor: "neutral.outlinedBorder",
              flex: 1,
              minWidth: 250,
            }}
          >
            {filteredCosts.length > 0 ? (
              <ModelUsageChart costs={filteredCosts} />
            ) : (
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
                No usage data
              </Typography>
            )}
          </Card>

          {/* Agent Leaderboard */}
          <Card
            variant="outlined"
            sx={{
              p: 2,
              bgcolor: "background.surface",
              borderColor: "neutral.outlinedBorder",
              flex: 1,
              minWidth: 300,
            }}
          >
            <Typography
              sx={{
                fontFamily: "code",
                fontSize: "0.7rem",
                color: "text.tertiary",
                letterSpacing: "0.05em",
                mb: 2,
              }}
            >
              TOP AGENTS BY COST
            </Typography>

            {agentLeaderboard.length > 0 ? (
              <Table
                size="sm"
                sx={{
                  "--TableCell-paddingY": "8px",
                  "--TableCell-paddingX": "8px",
                  "--TableCell-borderColor": "var(--joy-palette-neutral-outlinedBorder)",
                  "& thead th": {
                    bgcolor: "background.surface",
                    fontFamily: "code",
                    fontSize: "0.65rem",
                    letterSpacing: "0.05em",
                    color: "text.tertiary",
                  },
                  "& tbody tr:hover": {
                    bgcolor: colors.hoverBg,
                  },
                }}
              >
                <thead>
                  <tr>
                    <th>AGENT</th>
                    <th style={{ width: 80, textAlign: "right" }}>COST</th>
                    <th style={{ width: 80, textAlign: "right" }}>TOKENS</th>
                    <th style={{ width: 60, textAlign: "right" }}>SESSIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {agentLeaderboard.map((agent) => (
                    <tr key={agent.agentId}>
                      <td>
                        <Typography
                          sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.primary" }}
                        >
                          {agent.agentName}
                        </Typography>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Typography
                          sx={{ fontFamily: "code", fontSize: "0.75rem", color: colors.amber }}
                        >
                          {formatCurrency(agent.cost)}
                        </Typography>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Typography
                          sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.secondary" }}
                        >
                          {formatCompactNumber(agent.tokens)}
                        </Typography>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Typography
                          sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary" }}
                        >
                          {agent.sessions}
                        </Typography>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
                No agent usage data
              </Typography>
            )}
          </Card>
        </Box>
      </Box>
    </Card>
  );
}

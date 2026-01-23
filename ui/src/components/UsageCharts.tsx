import Box from "@mui/joy/Box";
import { useColorScheme } from "@mui/joy/styles";
import Typography from "@mui/joy/Typography";
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SessionCost } from "../types/api";

interface UsageChartsProps {
  costs: SessionCost[];
  timeRange?: "7d" | "30d" | "90d";
}

export function CostTrendChart({ costs, timeRange = "30d" }: UsageChartsProps) {
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const chartData = useMemo(() => {
    const days = timeRange === "7d" ? 7 : timeRange === "30d" ? 30 : 90;
    const data: { date: string; cost: number; tokens: number }[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0] ?? "";

      const dayCosts = costs.filter((c) => c.createdAt.startsWith(dateStr));

      data.push({
        date: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        cost: dayCosts.reduce((sum, c) => sum + c.totalCostUsd, 0),
        tokens: dayCosts.reduce((sum, c) => sum + c.inputTokens + c.outputTokens, 0),
      });
    }

    return data;
  }, [costs, timeRange]);

  const colors = {
    line: isDark ? "#F5A623" : "#D48806",
    grid: isDark ? "#3D3020" : "#E5DDD0",
    text: isDark ? "#8B7355" : "#6B5344",
  };

  return (
    <Box sx={{ width: "100%", height: 250 }}>
      <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary", mb: 1 }}>
        COST TREND
      </Typography>
      <ResponsiveContainer>
        <AreaChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: colors.text }} tickLine={false} />
          <YAxis
            tick={{ fontSize: 10, fill: colors.text }}
            tickFormatter={(v) => `$${v.toFixed(2)}`}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: isDark ? "#1A130E" : "#FFFFFF",
              border: `1px solid ${colors.grid}`,
              borderRadius: 4,
              fontFamily: "monospace",
              fontSize: 12,
            }}
            formatter={(value) => [`$${Number(value).toFixed(4)}`, "Cost"]}
          />
          <Area
            type="monotone"
            dataKey="cost"
            stroke={colors.line}
            fill={`${colors.line}40`}
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Box>
  );
}

export function TokenDistributionChart({ costs }: { costs: SessionCost[] }) {
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const data = useMemo(() => {
    const totals = costs.reduce(
      (acc, c) => ({
        input: acc.input + c.inputTokens,
        output: acc.output + c.outputTokens,
        cacheRead: acc.cacheRead + c.cacheReadTokens,
        cacheWrite: acc.cacheWrite + c.cacheWriteTokens,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );

    return [
      { name: "Input", value: totals.input, color: "#3B82F6" },
      { name: "Output", value: totals.output, color: "#F5A623" },
      { name: "Cache Read", value: totals.cacheRead, color: "#22C55E" },
      { name: "Cache Write", value: totals.cacheWrite, color: "#D4A574" },
    ].filter((d) => d.value > 0);
  }, [costs]);

  return (
    <Box sx={{ width: "100%", height: 250 }}>
      <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary", mb: 1 }}>
        TOKEN DISTRIBUTION
      </Typography>
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={80}
            label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
            labelLine={false}
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value) => [Number(value).toLocaleString(), "Tokens"]}
            contentStyle={{
              backgroundColor: isDark ? "#1A130E" : "#FFFFFF",
              borderRadius: 4,
              fontFamily: "monospace",
              fontSize: 12,
            }}
          />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </Box>
  );
}

export function ModelUsageChart({ costs }: { costs: SessionCost[] }) {
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const data = useMemo(() => {
    const byModel = new Map<string, { cost: number; sessions: number }>();

    costs.forEach((c) => {
      const existing = byModel.get(c.model) || { cost: 0, sessions: 0 };
      byModel.set(c.model, {
        cost: existing.cost + c.totalCostUsd,
        sessions: existing.sessions + 1,
      });
    });

    return Array.from(byModel.entries()).map(([model, data]) => ({
      model: model.length > 15 ? model.slice(0, 15) + "..." : model,
      cost: data.cost,
      sessions: data.sessions,
    }));
  }, [costs]);

  const colors = {
    bar: isDark ? "#F5A623" : "#D48806",
    grid: isDark ? "#3D3020" : "#E5DDD0",
    text: isDark ? "#8B7355" : "#6B5344",
  };

  return (
    <Box sx={{ width: "100%", height: 200 }}>
      <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary", mb: 1 }}>
        COST BY MODEL
      </Typography>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
          <XAxis
            type="number"
            tick={{ fontSize: 10, fill: colors.text }}
            tickFormatter={(v) => `$${v.toFixed(2)}`}
          />
          <YAxis
            type="category"
            dataKey="model"
            tick={{ fontSize: 10, fill: colors.text }}
            width={80}
          />
          <Tooltip
            formatter={(value) => [`$${Number(value).toFixed(4)}`, "Cost"]}
            contentStyle={{
              backgroundColor: isDark ? "#1A130E" : "#FFFFFF",
              borderRadius: 4,
              fontFamily: "monospace",
              fontSize: 12,
            }}
          />
          <Bar dataKey="cost" fill={colors.bar} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
}

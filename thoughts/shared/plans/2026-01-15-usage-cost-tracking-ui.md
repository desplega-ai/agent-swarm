---
date: 2026-01-15T23:50:00Z
topic: "Usage/Cost Tracking UI - Frontend Implementation Plan"
author: "Coder (a09d19a4)"
status: "draft"
---

# Usage/Cost Tracking UI - Frontend Implementation Plan

## Overview

Implement a comprehensive usage and cost tracking UI for the Agent Swarm dashboard. This feature will visualize session cost data captured by the backend (PR #28) across multiple views, providing insights into token usage, costs, and trends per agent, task, and hive.

## Current State Analysis

### Backend API Available
- **Endpoint**: `GET /api/session-costs`
- **Filters**: `agentId`, `taskId`, `limit` (date range filtering not yet implemented in backend)
- **Data Fields**: `id`, `sessionId`, `taskId`, `agentId`, `totalCostUsd`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `durationMs`, `numTurns`, `model`, `isError`, `createdAt`

### Frontend Patterns (Reference Files)
- **API Client**: `ui/src/lib/api.ts` - Class-based fetch wrapper
- **Query Hooks**: `ui/src/hooks/queries.ts` - TanStack React Query hooks
- **Types**: `ui/src/types/api.ts` - TypeScript interfaces
- **Stats Display**: `ui/src/components/StatsBar.tsx` - Hexagon stat widgets
- **Detail Panels**: `ui/src/components/AgentDetailPanel.tsx`, `TaskDetailPanel.tsx`
- **Dashboard Layout**: `ui/src/components/Dashboard.tsx` - Tab-based navigation

### UI Library
- **MUI Joy** (`@mui/joy`) - Primary component library
- **No charting library currently installed** - Will need to add one

### Key Discoveries
- Stats use custom hexagon CSS shapes with `clipPath`
- Detail panels support expandable layouts with horizontal/vertical switching
- Tables use MUI Joy `Table` with sticky headers and responsive cards for mobile
- React Query with 5-second auto-refresh is the standard data fetching pattern
- Color scheme supports dark/light mode via `useColorScheme()`

## Desired End State

A fully integrated cost tracking UI that:
1. Shows monthly totals in the home page stats bar
2. Displays per-agent monthly costs in the agents table
3. Provides detailed usage breakdowns in agent/task detail panels
4. Offers a dedicated "Usage" tab with comprehensive analytics and charts

## Charting Library Recommendation

**Recommended: Recharts**

Rationale:
- Built for React with declarative components
- Lightweight (~200KB gzipped)
- Good TypeScript support
- Simple API that matches MUI Joy's declarative style
- Supports all required chart types (line, bar, pie, area)
- Active maintenance and community

Alternative considered: Victory (heavier), Chart.js (imperative API), Nivo (complex)

## What We're NOT Doing

- Backend date range filtering (separate PR needed)
- Real-time cost streaming (polling is sufficient)
- Cost predictions/forecasting
- Export functionality
- Budget alerts/thresholds
- Multi-currency support

---

## Implementation Approach

### Data Flow Architecture

```
GET /api/session-costs → api.fetchSessionCosts() → useSessionCosts() hook → Components
                                                    useAgentUsage() hook
                                                    useTaskUsage() hook
                                                    useUsageStats() hook
```

### Aggregation Strategy

Client-side aggregation from raw session cost data:
- Monthly totals: Filter by `createdAt` month, sum values
- Daily/weekly breakdowns: Group by date, aggregate
- Per-agent/task: Filter by ID, aggregate

Note: For large datasets, consider adding backend aggregation endpoints in a future phase.

---

## Phase 1: Foundation - Types, API, and Hooks

### Overview
Add TypeScript types, API client methods, and React Query hooks for session costs.

### Changes Required

#### 1. Type Definitions
**File**: `ui/src/types/api.ts`
**Changes**: Add SessionCost interface and response types

```typescript
// Add after SessionLogsResponse (line ~93)

export interface SessionCost {
  id: string;
  sessionId: string;
  taskId?: string;
  agentId: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  numTurns: number;
  model: string;
  isError: boolean;
  createdAt: string;
}

export interface SessionCostsResponse {
  costs: SessionCost[];
}

// Aggregated usage types for UI
export interface UsageStats {
  totalCostUsd: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sessionCount: number;
  totalDurationMs: number;
  avgCostPerSession: number;
}

export interface DailyUsage {
  date: string;
  costUsd: number;
  tokens: number;
  sessions: number;
}

export interface AgentUsageSummary {
  agentId: string;
  agentName?: string;
  monthlyCostUsd: number;
  monthlyTokens: number;
  sessionCount: number;
}
```

#### 2. API Client Methods
**File**: `ui/src/lib/api.ts`
**Changes**: Add fetchSessionCosts method

```typescript
// Add to ApiClient class (after fetchServices method, ~line 182)

async fetchSessionCosts(filters?: {
  agentId?: string;
  taskId?: string;
  limit?: number
}): Promise<SessionCostsResponse> {
  const params = new URLSearchParams();
  if (filters?.agentId) params.set("agentId", filters.agentId);
  if (filters?.taskId) params.set("taskId", filters.taskId);
  if (filters?.limit) params.set("limit", String(filters.limit));
  const queryString = params.toString();
  const url = `${this.getBaseUrl()}/api/session-costs${queryString ? `?${queryString}` : ""}`;
  const res = await fetch(url, { headers: this.getHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch session costs: ${res.status}`);
  return res.json();
}
```

#### 3. React Query Hooks
**File**: `ui/src/hooks/queries.ts`
**Changes**: Add usage-related hooks

```typescript
// Add at end of file

export interface SessionCostFilters {
  agentId?: string;
  taskId?: string;
  limit?: number;
}

export function useSessionCosts(filters?: SessionCostFilters) {
  return useQuery({
    queryKey: ["session-costs", filters],
    queryFn: () => api.fetchSessionCosts(filters),
    select: (data) => data.costs,
  });
}

// Hook for aggregated usage stats (monthly)
export function useMonthlyUsageStats() {
  const { data: costs, ...rest } = useSessionCosts({ limit: 1000 });

  const stats = useMemo(() => {
    if (!costs) return null;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyCosts = costs.filter(
      (c) => new Date(c.createdAt) >= startOfMonth
    );

    return {
      totalCostUsd: monthlyCosts.reduce((sum, c) => sum + c.totalCostUsd, 0),
      totalTokens: monthlyCosts.reduce(
        (sum, c) => sum + c.inputTokens + c.outputTokens, 0
      ),
      inputTokens: monthlyCosts.reduce((sum, c) => sum + c.inputTokens, 0),
      outputTokens: monthlyCosts.reduce((sum, c) => sum + c.outputTokens, 0),
      cacheReadTokens: monthlyCosts.reduce((sum, c) => sum + c.cacheReadTokens, 0),
      cacheWriteTokens: monthlyCosts.reduce((sum, c) => sum + c.cacheWriteTokens, 0),
      sessionCount: monthlyCosts.length,
      totalDurationMs: monthlyCosts.reduce((sum, c) => sum + c.durationMs, 0),
      avgCostPerSession: monthlyCosts.length > 0
        ? monthlyCosts.reduce((sum, c) => sum + c.totalCostUsd, 0) / monthlyCosts.length
        : 0,
    };
  }, [costs]);

  return { data: stats, ...rest };
}

// Hook for agent usage summary
export function useAgentUsageSummary(agentId: string) {
  return useQuery({
    queryKey: ["agent-usage", agentId],
    queryFn: () => api.fetchSessionCosts({ agentId, limit: 500 }),
    select: (data) => {
      const costs = data.costs;
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const filterByDate = (start: Date) =>
        costs.filter((c) => new Date(c.createdAt) >= start);

      return {
        daily: aggregateUsage(filterByDate(startOfDay)),
        weekly: aggregateUsage(filterByDate(startOfWeek)),
        monthly: aggregateUsage(filterByDate(startOfMonth)),
        all: aggregateUsage(costs),
      };
    },
    enabled: !!agentId,
  });
}

// Hook for task usage
export function useTaskUsage(taskId: string) {
  return useQuery({
    queryKey: ["task-usage", taskId],
    queryFn: () => api.fetchSessionCosts({ taskId }),
    select: (data) => aggregateUsage(data.costs),
    enabled: !!taskId,
  });
}

// Helper function for aggregation
function aggregateUsage(costs: SessionCost[]): UsageStats {
  return {
    totalCostUsd: costs.reduce((sum, c) => sum + c.totalCostUsd, 0),
    totalTokens: costs.reduce((sum, c) => sum + c.inputTokens + c.outputTokens, 0),
    inputTokens: costs.reduce((sum, c) => sum + c.inputTokens, 0),
    outputTokens: costs.reduce((sum, c) => sum + c.outputTokens, 0),
    cacheReadTokens: costs.reduce((sum, c) => sum + c.cacheReadTokens, 0),
    cacheWriteTokens: costs.reduce((sum, c) => sum + c.cacheWriteTokens, 0),
    sessionCount: costs.length,
    totalDurationMs: costs.reduce((sum, c) => sum + c.durationMs, 0),
    avgCostPerSession: costs.length > 0
      ? costs.reduce((sum, c) => sum + c.totalCostUsd, 0) / costs.length
      : 0,
  };
}
```

### Success Criteria

#### Automated Verification
- [ ] TypeScript compiles: `cd ui && npm run typecheck`
- [ ] Build succeeds: `cd ui && npm run build`

#### Manual Verification
- [ ] API calls return data when tested in browser dev tools

**Implementation Note**: After completing this phase, verify types compile before proceeding.

---

## Phase 2: StatsBar Enhancement - Monthly Usage Hives

### Overview
Add two new hexagon stats to the home page showing monthly token count and monthly cost.

### Changes Required

#### 1. StatsBar Component
**File**: `ui/src/components/StatsBar.tsx`
**Changes**: Add usage stats hexagons

```typescript
// Add import (line ~4)
import { useStats, useMonthlyUsageStats } from "../hooks/queries";

// Inside StatsBar component, add usage stats hook (after line 117)
const { data: usageStats } = useMonthlyUsageStats();

// Add to colors object (around line 123)
const colors = {
  // ... existing colors
  green: "#22C55E",
  greenGlow: isDark ? "rgba(34, 197, 94, 0.5)" : "rgba(34, 197, 94, 0.25)",
};

// Add new stats to topRow array (after existing items, around line 159)
// Option A: Add to existing rows
// Option B: Create a third row for usage stats

// Recommended: Add to bottom row or create usage section
const usageRow = [
  {
    label: "MTD TOKENS",
    value: usageStats ? formatCompactNumber(usageStats.totalTokens) : "—",
    color: colors.green,
    glowColor: colors.greenGlow,
  },
  {
    label: "MTD COST",
    value: usageStats ? `$${usageStats.totalCostUsd.toFixed(2)}` : "—",
    color: colors.amber,
    glowColor: colors.amberGlow,
  },
];
```

#### 2. Utility Function for Number Formatting
**File**: `ui/src/lib/utils.ts`
**Changes**: Add compact number formatter

```typescript
// Add at end of file

export function formatCompactNumber(num: number): string {
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toString();
}

export function formatCurrency(amount: number): string {
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(4)}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
```

### UI Mockup Description

The StatsBar will display two additional hexagons:
- **MTD TOKENS**: Green hexagon showing formatted total tokens (e.g., "1.2M")
- **MTD COST**: Amber hexagon showing formatted cost (e.g., "$45.23")

Layout options:
1. Add to existing honeycomb grid (extend bottom row to 6 hexagons)
2. Create separate "Usage" section below existing stats
3. Add hover tooltip with detailed breakdown

Recommended: Option 1 for consistency, with tooltip showing breakdown.

### Success Criteria

#### Automated Verification
- [ ] Build succeeds: `cd ui && npm run build`
- [ ] TypeScript compiles: `cd ui && npm run typecheck`

#### Manual Verification
- [ ] Stats bar shows MTD tokens and cost
- [ ] Values update when session costs are created
- [ ] Responsive layout works on mobile

---

## Phase 3: Agents Table - Monthly Usage Column

### Overview
Add a new column to the agents table showing each agent's monthly usage.

### Changes Required

#### 1. AgentsPanel Component
**File**: `ui/src/components/AgentsPanel.tsx`
**Changes**: Add monthly usage column

```typescript
// Add import for useSessionCosts
import { useAgents, useSessionCosts } from "../hooks/queries";

// Inside AgentsPanel, fetch all session costs
const { data: allCosts } = useSessionCosts({ limit: 2000 });

// Create agent usage map (memoized)
const agentUsageMap = useMemo(() => {
  if (!allCosts) return new Map();

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const map = new Map<string, { cost: number; tokens: number }>();

  allCosts
    .filter((c) => new Date(c.createdAt) >= startOfMonth)
    .forEach((cost) => {
      const existing = map.get(cost.agentId) || { cost: 0, tokens: 0 };
      map.set(cost.agentId, {
        cost: existing.cost + cost.totalCostUsd,
        tokens: existing.tokens + cost.inputTokens + cost.outputTokens,
      });
    });

  return map;
}, [allCosts]);

// Add column header in Table thead (after UPDATED column)
<th style={{ width: "100px" }}>MTD USAGE</th>

// Add column data in table row
<td>
  <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
    <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: colors.amber }}>
      {formatCurrency(agentUsageMap.get(agent.id)?.cost || 0)}
    </Typography>
    <Typography sx={{ fontFamily: "code", fontSize: "0.6rem", color: "text.tertiary" }}>
      {formatCompactNumber(agentUsageMap.get(agent.id)?.tokens || 0)} tokens
    </Typography>
  </Box>
</td>
```

### UI Mockup Description

| NAME | ROLE | STATUS | CAPACITY | MTD USAGE | UPDATED |
|------|------|--------|----------|-----------|---------|
| Worker-1 | Coder | busy | 2/5 | **$12.34** <br/> 245K tokens | 2m ago |
| Worker-2 | Reviewer | idle | 0/3 | **$5.67** <br/> 89K tokens | 5m ago |

The MTD USAGE column shows:
- Primary: Cost in amber color
- Secondary: Token count in tertiary gray

### Success Criteria

#### Automated Verification
- [ ] Build succeeds: `cd ui && npm run build`

#### Manual Verification
- [ ] Agents table shows MTD usage column
- [ ] Values are correct per agent
- [ ] Column is sortable (optional enhancement)

---

## Phase 4: Agent Detail Sidepanel - Usage Breakdown

### Overview
Add daily/weekly/monthly usage breakdown to the agent detail panel.

### Changes Required

#### 1. AgentDetailPanel Component
**File**: `ui/src/components/AgentDetailPanel.tsx`
**Changes**: Add usage section

```typescript
// Add import
import { useAgent, useLogs, useAgentUsageSummary } from "../hooks/queries";
import { formatCurrency, formatCompactNumber, formatDuration } from "../lib/utils";

// Inside component, add usage hook (after existing hooks)
const { data: usage } = useAgentUsageSummary(agentId);

// Add UsageSection component (inside AgentDetailPanel, before return)
const UsageSection = () => (
  <Box sx={{ p: { xs: 1.5, md: 2 } }}>
    <Typography
      sx={{
        fontFamily: "code",
        fontSize: "0.7rem",
        color: "text.tertiary",
        letterSpacing: "0.05em",
        mb: 1.5,
      }}
    >
      USAGE BREAKDOWN
    </Typography>

    {!usage ? (
      <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
        Loading usage data...
      </Typography>
    ) : (
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {/* Daily */}
        <UsageCard
          title="TODAY"
          cost={usage.daily.totalCostUsd}
          tokens={usage.daily.totalTokens}
          sessions={usage.daily.sessionCount}
          color={colors.amber}
        />

        {/* Weekly */}
        <UsageCard
          title="THIS WEEK"
          cost={usage.weekly.totalCostUsd}
          tokens={usage.weekly.totalTokens}
          sessions={usage.weekly.sessionCount}
          color={colors.gold}
        />

        {/* Monthly */}
        <UsageCard
          title="THIS MONTH"
          cost={usage.monthly.totalCostUsd}
          tokens={usage.monthly.totalTokens}
          sessions={usage.monthly.sessionCount}
          color={colors.blue}
        />
      </Box>
    )}
  </Box>
);

// UsageCard helper component
const UsageCard = ({ title, cost, tokens, sessions, color }: {
  title: string;
  cost: number;
  tokens: number;
  sessions: number;
  color: string;
}) => (
  <Box
    sx={{
      bgcolor: "background.level1",
      border: "1px solid",
      borderColor: "neutral.outlinedBorder",
      borderRadius: 1,
      p: 1.5,
    }}
  >
    <Typography
      sx={{
        fontFamily: "code",
        fontSize: "0.6rem",
        color: "text.tertiary",
        letterSpacing: "0.05em",
        mb: 0.5,
      }}
    >
      {title}
    </Typography>
    <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
      <Typography sx={{ fontFamily: "code", fontSize: "1rem", fontWeight: 600, color }}>
        {formatCurrency(cost)}
      </Typography>
      <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.secondary" }}>
        {formatCompactNumber(tokens)} tokens
      </Typography>
    </Box>
    <Typography sx={{ fontFamily: "code", fontSize: "0.6rem", color: "text.tertiary", mt: 0.5 }}>
      {sessions} session{sessions !== 1 ? "s" : ""}
    </Typography>
  </Box>
);

// Add UsageSection to the panel layout (after InfoSection, before ActivitySection)
// In collapsed mode:
<InfoSection />
<Divider sx={{ bgcolor: "neutral.outlinedBorder" }} />
<UsageSection />
<Divider sx={{ bgcolor: "neutral.outlinedBorder" }} />
<ActivitySection />

// In expanded mode: Add as middle column or section
```

### UI Mockup Description

```
┌─────────────────────────────────────┐
│ USAGE BREAKDOWN                      │
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ TODAY                           │ │
│ │ $2.45    125K tokens            │ │
│ │ 3 sessions                      │ │
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ THIS WEEK                       │ │
│ │ $12.34   456K tokens            │ │
│ │ 15 sessions                     │ │
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ THIS MONTH                      │ │
│ │ $45.67   1.2M tokens            │ │
│ │ 52 sessions                     │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### Success Criteria

#### Automated Verification
- [ ] Build succeeds: `cd ui && npm run build`

#### Manual Verification
- [ ] Agent detail shows usage breakdown
- [ ] Daily/weekly/monthly values are accurate
- [ ] Updates when new sessions are created

---

## Phase 5: Agent Detail Page - Charts (Expanded View)

### Overview
Add charts to the expanded agent detail view showing usage trends and breakdowns.

### Changes Required

#### 1. Install Recharts
**File**: `ui/package.json`
**Changes**: Add recharts dependency

```bash
cd ui && npm install recharts
```

#### 2. Create UsageCharts Component
**File**: `ui/src/components/UsageCharts.tsx` (new file)
**Changes**: Create chart components

```typescript
import { useMemo } from "react";
import Box from "@mui/joy/Box";
import Typography from "@mui/joy/Typography";
import { useColorScheme } from "@mui/joy/styles";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
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
      const dateStr = date.toISOString().split("T")[0];

      const dayCosts = costs.filter(
        (c) => c.createdAt.startsWith(dateStr)
      );

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
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: colors.text }}
            tickLine={false}
          />
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
            formatter={(value: number) => [`$${value.toFixed(4)}`, "Cost"]}
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
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
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
            label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
            labelLine={false}
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value: number) => [value.toLocaleString(), "Tokens"]}
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
      model,
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
            width={60}
          />
          <Tooltip
            formatter={(value: number) => [`$${value.toFixed(4)}`, "Cost"]}
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
```

#### 3. Update AgentDetailPanel (Expanded View)
**File**: `ui/src/components/AgentDetailPanel.tsx`
**Changes**: Add charts section in expanded mode

```typescript
// Add import
import { CostTrendChart, TokenDistributionChart, ModelUsageChart } from "./UsageCharts";
import { useSessionCosts } from "../hooks/queries";

// Inside component, add costs hook
const { data: agentCosts } = useSessionCosts({ agentId, limit: 500 });

// Add ChartsSection component
const ChartsSection = () => (
  <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 3 }}>
    <Typography
      sx={{
        fontFamily: "code",
        fontSize: "0.7rem",
        color: "text.tertiary",
        letterSpacing: "0.05em",
      }}
    >
      USAGE ANALYTICS
    </Typography>

    {agentCosts && agentCosts.length > 0 ? (
      <>
        <CostTrendChart costs={agentCosts} timeRange="30d" />
        <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
          <Box sx={{ flex: 1, minWidth: 250 }}>
            <TokenDistributionChart costs={agentCosts} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 250 }}>
            <ModelUsageChart costs={agentCosts} />
          </Box>
        </Box>
      </>
    ) : (
      <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
        No usage data available
      </Typography>
    )}
  </Box>
);

// In expanded layout, add ChartsSection as a new column/section
{expanded && (
  <>
    {/* Existing columns */}
    <Box sx={{ flex: 1, borderLeft: "1px solid", borderColor: "neutral.outlinedBorder", overflow: "auto" }}>
      <ChartsSection />
    </Box>
  </>
)}
```

### Success Criteria

#### Automated Verification
- [ ] Build succeeds: `cd ui && npm run build`
- [ ] No TypeScript errors

#### Manual Verification
- [ ] Charts render correctly in expanded agent detail
- [ ] Charts are responsive
- [ ] Dark/light mode styling works

---

## Phase 6: Task Detail - Cost Totals

### Overview
Show cost totals for the task in the task detail panel.

### Changes Required

#### 1. TaskDetailPanel Component
**File**: `ui/src/components/TaskDetailPanel.tsx`
**Changes**: Add cost display

```typescript
// Add import
import { useTask, useAgents, useTaskSessionLogs, useTaskUsage } from "../hooks/queries";
import { formatCurrency, formatCompactNumber, formatDuration } from "../lib/utils";

// Inside component, add usage hook
const { data: taskUsage } = useTaskUsage(taskId);

// Add to DetailsSection, after Elapsed Time field (around line 243)
{taskUsage && taskUsage.sessionCount > 0 && (
  <>
    <Divider sx={{ my: 1.5 }} />
    <Typography
      sx={{
        fontFamily: "code",
        fontSize: "0.65rem",
        color: "text.tertiary",
        letterSpacing: "0.05em",
        mb: 1,
      }}
    >
      TASK COSTS
    </Typography>

    <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
        Total Cost
      </Typography>
      <Typography sx={{ fontFamily: "code", fontSize: "0.9rem", fontWeight: 600, color: colors.amber }}>
        {formatCurrency(taskUsage.totalCostUsd)}
      </Typography>
    </Box>

    <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
        Total Tokens
      </Typography>
      <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: "text.secondary" }}>
        {formatCompactNumber(taskUsage.totalTokens)}
      </Typography>
    </Box>

    <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
        Sessions
      </Typography>
      <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: "text.secondary" }}>
        {taskUsage.sessionCount}
      </Typography>
    </Box>

    <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
        Compute Time
      </Typography>
      <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: "text.secondary" }}>
        {formatDuration(taskUsage.totalDurationMs)}
      </Typography>
    </Box>

    {/* Token breakdown */}
    <Box sx={{ mt: 1, p: 1, bgcolor: "background.level1", borderRadius: 1, border: "1px solid", borderColor: "neutral.outlinedBorder" }}>
      <Typography sx={{ fontFamily: "code", fontSize: "0.6rem", color: "text.tertiary", mb: 0.5 }}>
        TOKEN BREAKDOWN
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
        <Chip size="sm" sx={{ fontFamily: "code", fontSize: "0.6rem" }}>
          In: {formatCompactNumber(taskUsage.inputTokens)}
        </Chip>
        <Chip size="sm" sx={{ fontFamily: "code", fontSize: "0.6rem" }}>
          Out: {formatCompactNumber(taskUsage.outputTokens)}
        </Chip>
        {taskUsage.cacheReadTokens > 0 && (
          <Chip size="sm" sx={{ fontFamily: "code", fontSize: "0.6rem" }}>
            Cache R: {formatCompactNumber(taskUsage.cacheReadTokens)}
          </Chip>
        )}
        {taskUsage.cacheWriteTokens > 0 && (
          <Chip size="sm" sx={{ fontFamily: "code", fontSize: "0.6rem" }}>
            Cache W: {formatCompactNumber(taskUsage.cacheWriteTokens)}
          </Chip>
        )}
      </Box>
    </Box>
  </>
)}
```

### UI Mockup Description

```
┌─────────────────────────────────────┐
│ Status          ● completed         │
│ Agent           Worker-1            │
│ Elapsed Time    12m 34s             │
├─────────────────────────────────────┤
│ TASK COSTS                          │
│ Total Cost      $0.4523             │
│ Total Tokens    125,432             │
│ Sessions        3                   │
│ Compute Time    8m 12s              │
│ ┌─────────────────────────────────┐ │
│ │ TOKEN BREAKDOWN                 │ │
│ │ [In: 45K] [Out: 80K] [Cache: 5K]│ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### Success Criteria

#### Automated Verification
- [ ] Build succeeds: `cd ui && npm run build`

#### Manual Verification
- [ ] Task detail shows cost totals
- [ ] Values match actual session costs for the task
- [ ] Displays gracefully when no costs exist

---

## Phase 7: Usage Tab - Dedicated Dashboard

### Overview
Create a new "Usage" tab in the dashboard with comprehensive analytics.

### Changes Required

#### 1. Create UsagePanel Component
**File**: `ui/src/components/UsagePanel.tsx` (new file)

```typescript
import { useState, useMemo } from "react";
import Box from "@mui/joy/Box";
import Typography from "@mui/joy/Typography";
import Select from "@mui/joy/Select";
import Option from "@mui/joy/Option";
import Card from "@mui/joy/Card";
import Table from "@mui/joy/Table";
import { useColorScheme } from "@mui/joy/styles";
import { useSessionCosts, useAgents } from "../hooks/queries";
import { formatCurrency, formatCompactNumber, formatDuration } from "../lib/utils";
import { CostTrendChart, TokenDistributionChart, ModelUsageChart } from "./UsageCharts";

type TimeRange = "7d" | "30d" | "90d" | "all";

export default function UsagePanel() {
  const [timeRange, setTimeRange] = useState<TimeRange>("30d");
  const { data: allCosts, isLoading } = useSessionCosts({ limit: 5000 });
  const { data: agents } = useAgents();
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    gold: isDark ? "#D4A574" : "#8B6914",
    blue: "#3B82F6",
    green: "#22C55E",
    hoverBg: isDark ? "rgba(245, 166, 35, 0.08)" : "rgba(212, 136, 6, 0.08)",
  };

  // Filter costs by time range
  const filteredCosts = useMemo(() => {
    if (!allCosts) return [];
    if (timeRange === "all") return allCosts;

    const days = timeRange === "7d" ? 7 : timeRange === "30d" ? 30 : 90;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    return allCosts.filter((c) => new Date(c.createdAt) >= cutoff);
  }, [allCosts, timeRange]);

  // Aggregate stats
  const stats = useMemo(() => {
    if (!filteredCosts.length) return null;

    return {
      totalCost: filteredCosts.reduce((sum, c) => sum + c.totalCostUsd, 0),
      totalTokens: filteredCosts.reduce((sum, c) => sum + c.inputTokens + c.outputTokens, 0),
      totalSessions: filteredCosts.length,
      totalDuration: filteredCosts.reduce((sum, c) => sum + c.durationMs, 0),
      avgCostPerSession: filteredCosts.reduce((sum, c) => sum + c.totalCostUsd, 0) / filteredCosts.length,
      inputTokens: filteredCosts.reduce((sum, c) => sum + c.inputTokens, 0),
      outputTokens: filteredCosts.reduce((sum, c) => sum + c.outputTokens, 0),
    };
  }, [filteredCosts]);

  // Per-agent breakdown
  const agentBreakdown = useMemo(() => {
    if (!filteredCosts.length || !agents) return [];

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
        agentName: agents.find((a) => a.id === agentId)?.name || agentId.slice(0, 8),
        ...data,
      }))
      .sort((a, b) => b.cost - a.cost);
  }, [filteredCosts, agents]);

  if (isLoading) {
    return (
      <Box sx={{ p: 3, textAlign: "center" }}>
        <Typography sx={{ fontFamily: "code", color: "text.tertiary" }}>
          Loading usage data...
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", overflow: "auto", p: { xs: 1.5, md: 2 } }}>
      {/* Header with time range selector */}
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 3 }}>
        <Typography sx={{ fontFamily: "display", fontSize: "1.25rem", fontWeight: 600, color: colors.amber }}>
          USAGE ANALYTICS
        </Typography>
        <Select
          value={timeRange}
          onChange={(_, value) => value && setTimeRange(value)}
          size="sm"
          sx={{ fontFamily: "code", minWidth: 120 }}
        >
          <Option value="7d">Last 7 days</Option>
          <Option value="30d">Last 30 days</Option>
          <Option value="90d">Last 90 days</Option>
          <Option value="all">All time</Option>
        </Select>
      </Box>

      {/* Summary Cards */}
      {stats && (
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(4, 1fr)" }, gap: 2, mb: 3 }}>
          <SummaryCard
            title="TOTAL COST"
            value={formatCurrency(stats.totalCost)}
            color={colors.amber}
          />
          <SummaryCard
            title="TOTAL TOKENS"
            value={formatCompactNumber(stats.totalTokens)}
            color={colors.blue}
          />
          <SummaryCard
            title="SESSIONS"
            value={stats.totalSessions.toString()}
            color={colors.gold}
          />
          <SummaryCard
            title="COMPUTE TIME"
            value={formatDuration(stats.totalDuration)}
            color={colors.green}
          />
        </Box>
      )}

      {/* Charts Row */}
      {filteredCosts.length > 0 && (
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "2fr 1fr" }, gap: 3, mb: 3 }}>
          <Card sx={{ p: 2 }}>
            <CostTrendChart costs={filteredCosts} timeRange={timeRange === "all" ? "90d" : timeRange} />
          </Card>
          <Card sx={{ p: 2 }}>
            <TokenDistributionChart costs={filteredCosts} />
          </Card>
        </Box>
      )}

      {/* Model Usage */}
      {filteredCosts.length > 0 && (
        <Card sx={{ p: 2, mb: 3 }}>
          <ModelUsageChart costs={filteredCosts} />
        </Card>
      )}

      {/* Agent Breakdown Table */}
      <Card sx={{ p: 2 }}>
        <Typography sx={{ fontFamily: "code", fontSize: "0.7rem", color: "text.tertiary", letterSpacing: "0.05em", mb: 2 }}>
          USAGE BY AGENT
        </Typography>
        <Table size="sm">
          <thead>
            <tr>
              <th>AGENT</th>
              <th style={{ textAlign: "right" }}>COST</th>
              <th style={{ textAlign: "right" }}>TOKENS</th>
              <th style={{ textAlign: "right" }}>SESSIONS</th>
            </tr>
          </thead>
          <tbody>
            {agentBreakdown.map((agent) => (
              <tr key={agent.agentId}>
                <td>
                  <Typography sx={{ fontFamily: "code", fontSize: "0.8rem" }}>
                    {agent.agentName}
                  </Typography>
                </td>
                <td style={{ textAlign: "right" }}>
                  <Typography sx={{ fontFamily: "code", fontSize: "0.8rem", color: colors.amber }}>
                    {formatCurrency(agent.cost)}
                  </Typography>
                </td>
                <td style={{ textAlign: "right" }}>
                  <Typography sx={{ fontFamily: "code", fontSize: "0.8rem" }}>
                    {formatCompactNumber(agent.tokens)}
                  </Typography>
                </td>
                <td style={{ textAlign: "right" }}>
                  <Typography sx={{ fontFamily: "code", fontSize: "0.8rem" }}>
                    {agent.sessions}
                  </Typography>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </Box>
  );
}

function SummaryCard({ title, value, color }: { title: string; value: string; color: string }) {
  return (
    <Card sx={{ p: 2, textAlign: "center" }}>
      <Typography sx={{ fontFamily: "code", fontSize: "0.6rem", color: "text.tertiary", letterSpacing: "0.05em", mb: 0.5 }}>
        {title}
      </Typography>
      <Typography sx={{ fontFamily: "code", fontSize: "1.5rem", fontWeight: 700, color }}>
        {value}
      </Typography>
    </Card>
  );
}
```

#### 2. Update Dashboard Component
**File**: `ui/src/components/Dashboard.tsx`
**Changes**: Add Usage tab

```typescript
// Add import (after other component imports)
import UsagePanel from "./UsagePanel";

// Update activeTab type (line ~104)
const [activeTab, setActiveTab] = useState<"agents" | "tasks" | "chat" | "services" | "usage">("agents");

// Add Usage tab to TabList (after Services tab, around line 361)
<Tab value="usage">USAGE</Tab>

// Add Usage TabPanel (after Services TabPanel, around line 529)
<TabPanel
  value="usage"
  sx={{
    p: 0,
    pt: 2,
    flex: 1,
    minHeight: 0,
    "&[hidden]": {
      display: "none",
    },
  }}
>
  <UsagePanel />
</TabPanel>

// Update handleTabChange to handle "usage" (around line 192)
} else if (tab === "usage") {
  setSelectedAgentId(null);
  setSelectedTaskId(null);
  setSelectedChannelId(null);
  setSelectedThreadId(null);
  setPreFilterAgentId(undefined);
  setAgentStatusFilter("all");
  setTaskStatusFilter("all");
  updateUrl({ tab: "usage", agent: null, task: null, channel: null, agentStatus: null, taskStatus: null, expand: false });
}

// Update getUrlParams to handle "usage" tab (around line 26)
tab: params.get("tab") as "agents" | "tasks" | "chat" | "services" | "usage" | null,
```

### UI Mockup Description

```
┌─────────────────────────────────────────────────────────────────────┐
│ USAGE ANALYTICS                                    [Last 30 days ▼] │
├─────────────────────────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐               │
│ │ TOTAL    │ │ TOTAL    │ │ SESSIONS │ │ COMPUTE  │               │
│ │ COST     │ │ TOKENS   │ │          │ │ TIME     │               │
│ │ $156.78  │ │ 4.2M     │ │ 342      │ │ 12h 34m  │               │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘               │
├─────────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐ ┌───────────────────────┐ │
│ │ COST TREND                          │ │ TOKEN DISTRIBUTION    │ │
│ │ [Area Chart]                        │ │ [Pie Chart]           │ │
│ │                                     │ │                       │ │
│ └─────────────────────────────────────┘ └───────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ COST BY MODEL                                                   │ │
│ │ [Horizontal Bar Chart]                                          │ │
│ └─────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│ USAGE BY AGENT                                                      │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ AGENT         │ COST     │ TOKENS  │ SESSIONS                   │ │
│ │ Worker-1      │ $45.23   │ 1.2M    │ 89                        │ │
│ │ Worker-2      │ $34.56   │ 892K    │ 67                        │ │
│ │ Lead          │ $12.34   │ 345K    │ 34                        │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### Success Criteria

#### Automated Verification
- [ ] Build succeeds: `cd ui && npm run build`
- [ ] TypeScript compiles: `cd ui && npm run typecheck`

#### Manual Verification
- [ ] Usage tab appears in navigation
- [ ] All charts render correctly
- [ ] Time range filter works
- [ ] Agent breakdown table is accurate
- [ ] Responsive layout works on mobile

---

## Quick Verification Reference

Common commands to verify the implementation:

```bash
# TypeScript check
cd ui && npm run typecheck

# Build
cd ui && npm run build

# Development server
cd ui && npm run dev
```

Key files to check:
- `ui/src/types/api.ts` - Type definitions
- `ui/src/lib/api.ts` - API client
- `ui/src/hooks/queries.ts` - React Query hooks
- `ui/src/components/StatsBar.tsx` - Home page stats
- `ui/src/components/AgentsPanel.tsx` - Agents table
- `ui/src/components/AgentDetailPanel.tsx` - Agent detail
- `ui/src/components/TaskDetailPanel.tsx` - Task detail
- `ui/src/components/UsagePanel.tsx` - Usage tab (new)
- `ui/src/components/UsageCharts.tsx` - Chart components (new)

---

## Testing Strategy

### Unit Tests
- Test aggregation functions (`aggregateUsage`)
- Test formatting utilities
- Test time range filtering logic

### Integration Tests
- Mock API responses and verify hook behavior
- Test chart data transformation

### Manual Testing
1. Create test session costs via API
2. Verify all UI components display correct values
3. Test with 0 data, small data, large data scenarios
4. Test dark/light mode
5. Test responsive layouts (mobile, tablet, desktop)

---

## Future Enhancements (Out of Scope)

1. **Backend date range API** - Add `from`/`to` parameters to GET /api/session-costs
2. **Export functionality** - CSV/PDF export of usage data
3. **Budget alerts** - Set cost thresholds with notifications
4. **Cost predictions** - ML-based forecasting
5. **Comparison views** - Compare agents or time periods
6. **Real-time updates** - WebSocket for live cost streaming

---

## References

- Backend PR: [#28 Session Cost Tracking](https://github.com/desplega-ai/agent-swarm/pull/28)
- API Endpoint: `GET /api/session-costs`
- UI Library: [MUI Joy](https://mui.com/joy-ui/getting-started/)
- Charting: [Recharts](https://recharts.org/)

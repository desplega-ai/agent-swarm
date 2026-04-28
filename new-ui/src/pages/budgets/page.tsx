import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Pencil, Plus, Trash2, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import {
  useBudgetRefusals,
  useBudgets,
  useDeleteBudget,
  useDeletePricing,
  useInsertPricing,
  usePricing,
  useUpsertBudget,
} from "@/api/hooks/use-budgets";
import { useUsageSummary } from "@/api/hooks/use-costs";
import { useLogs } from "@/api/hooks/use-stats";
import type {
  Agent,
  Budget,
  BudgetRefusalNotification,
  PricingProvider,
  PricingRow,
  PricingTokenClass,
} from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatSmartTime, formatUTCTime } from "@/lib/utils";

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatUsd(value: number, fractionDigits = 2): string {
  return `$${value.toFixed(fractionDigits)}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns a tailwind utility class for the spend bar fill, color-coded by
 * usage ratio: emerald (<70%), amber (70-99%), red (≥100%).
 */
function spendBarColor(ratio: number): string {
  if (ratio >= 1) return "bg-red-500";
  if (ratio >= 0.7) return "bg-amber-500";
  return "bg-emerald-500";
}

function SpendBar({ spend, budget }: { spend: number; budget: number | null }) {
  if (!budget || budget <= 0) {
    return (
      <div className="space-y-1">
        <div className="flex justify-between text-xs">
          <span className="font-mono">{formatUsd(spend)}</span>
          <span className="text-muted-foreground">no budget</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full w-0" />
        </div>
      </div>
    );
  }
  const ratio = spend / budget;
  const pct = Math.min(100, Math.round(ratio * 100));
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="font-mono">
          {formatUsd(spend)} / {formatUsd(budget)}
        </span>
        <span className={cn("font-medium", ratio >= 1 ? "text-red-400" : "text-muted-foreground")}>
          {pct}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full transition-all", spendBarColor(ratio))}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── budget edit dialog ───────────────────────────────────────────────────────

interface BudgetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: "global" | "agent";
  scopeId: string;
  scopeLabel: string;
  initialDailyBudgetUsd: number | null;
}

function BudgetDialog({
  open,
  onOpenChange,
  scope,
  scopeId,
  scopeLabel,
  initialDailyBudgetUsd,
}: BudgetDialogProps) {
  const [dailyBudgetUsd, setDailyBudgetUsd] = useState(
    initialDailyBudgetUsd != null ? String(initialDailyBudgetUsd) : "",
  );
  const upsert = useUpsertBudget();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = Number.parseFloat(dailyBudgetUsd);
    if (!Number.isFinite(value) || value < 0) return;
    upsert.mutate(
      { scope, scopeId, dailyBudgetUsd: value },
      {
        onSuccess: () => onOpenChange(false),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {initialDailyBudgetUsd != null ? "Edit" : "Set"}{" "}
              {scope === "global" ? "global" : "agent"} budget
            </DialogTitle>
            <DialogDescription>
              {scope === "global"
                ? "Maximum total daily spend across all agents."
                : `Maximum daily spend for ${scopeLabel}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Daily budget (USD) *</Label>
              <Input
                type="number"
                step="0.01"
                min={0}
                placeholder="10.00"
                value={dailyBudgetUsd}
                onChange={(e) => setDailyBudgetUsd(e.target.value)}
                required
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Set to 0 to block all new tasks for this scope.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={upsert.isPending}>
              {upsert.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── pricing add dialog ───────────────────────────────────────────────────────

const PRICING_PROVIDERS: PricingProvider[] = ["claude", "codex", "pi"];
const PRICING_TOKEN_CLASSES: PricingTokenClass[] = ["input", "cached_input", "output"];

function AddPricingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [provider, setProvider] = useState<PricingProvider>("claude");
  const [model, setModel] = useState("");
  const [tokenClass, setTokenClass] = useState<PricingTokenClass>("input");
  const [pricePerMillionUsd, setPricePerMillionUsd] = useState("");
  const insert = useInsertPricing();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const price = Number.parseFloat(pricePerMillionUsd);
    if (!model.trim() || !Number.isFinite(price) || price < 0) return;
    insert.mutate(
      { provider, model: model.trim(), tokenClass, pricePerMillionUsd: price },
      {
        onSuccess: () => {
          setModel("");
          setPricePerMillionUsd("");
          onOpenChange(false);
        },
        onError: (err) => setError(err instanceof Error ? err.message : "Failed to insert"),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add pricing row</DialogTitle>
            <DialogDescription>
              Pricing is append-only — adding a new row supersedes the previous active row from now
              forward.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Provider *</Label>
                <Select value={provider} onValueChange={(v) => setProvider(v as PricingProvider)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRICING_PROVIDERS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Token class *</Label>
                <Select
                  value={tokenClass}
                  onValueChange={(v) => setTokenClass(v as PricingTokenClass)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRICING_TOKEN_CLASSES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Model *</Label>
              <Input
                placeholder="gpt-4o, claude-opus-4-7, ..."
                value={model}
                onChange={(e) => setModel(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Price per 1M tokens (USD) *</Label>
              <Input
                type="number"
                step="0.000001"
                min={0}
                placeholder="3.00"
                value={pricePerMillionUsd}
                onChange={(e) => setPricePerMillionUsd(e.target.value)}
                required
              />
            </div>
            {error ? <p className="text-xs text-red-400">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={insert.isPending}>
              {insert.isPending ? "Adding..." : "Add row"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── refusals row utilities ──────────────────────────────────────────────────

function refusalCauseBadge(cause: BudgetRefusalNotification["cause"]) {
  if (cause === "global") {
    return (
      <Badge variant="outline" size="tag" className="border-red-500/30 text-red-400">
        GLOBAL
      </Badge>
    );
  }
  return (
    <Badge variant="outline" size="tag" className="border-amber-500/30 text-amber-400">
      AGENT
    </Badge>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function BudgetsPage() {
  const { data: budgets, isLoading: loadingBudgets } = useBudgets();
  const { data: agents, isLoading: loadingAgents } = useAgents();
  const today = todayISO();
  // NOTE: only `startDate` (today) — server compares createdAt lexicographically
  // against the date string, so passing endDate=today excludes records made
  // later that same day (`'2026-04-28T20:59:32Z' <= '2026-04-28'` is false).
  // Records past midnight UTC are filtered by startDate alone.
  const { data: todaysSummary, isLoading: loadingSummary } = useUsageSummary({
    startDate: today,
    groupBy: "agent",
  });
  const { data: refusals, isLoading: loadingRefusals } = useBudgetRefusals(50);
  const { data: pricing, isLoading: loadingPricing } = usePricing();
  const { data: logs } = useLogs(200);

  const deleteBudget = useDeleteBudget();
  const deletePricing = useDeletePricing();

  const [budgetDialog, setBudgetDialog] = useState<{
    scope: "global" | "agent";
    scopeId: string;
    scopeLabel: string;
    initial: number | null;
  } | null>(null);
  const [pricingDialogOpen, setPricingDialogOpen] = useState(false);
  const [budgetDeleteTarget, setBudgetDeleteTarget] = useState<{
    scope: "global" | "agent";
    scopeId: string;
    label: string;
  } | null>(null);
  const [pricingDeleteTarget, setPricingDeleteTarget] = useState<PricingRow | null>(null);

  // Index helpers ------------------------------------------------------------

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    agents?.forEach((a) => {
      m.set(a.id, a);
    });
    return m;
  }, [agents]);

  const todaysSpendByAgent = useMemo(() => {
    const m = new Map<string, number>();
    todaysSummary?.byAgent.forEach((row) => {
      m.set(row.agentId, row.costUsd);
    });
    return m;
  }, [todaysSummary]);

  const todaysGlobalSpend = todaysSummary?.totals.totalCostUsd ?? 0;

  const globalBudget = useMemo(
    () => budgets?.find((b) => b.scope === "global" && b.scopeId === "") ?? null,
    [budgets],
  );

  const agentBudgetMap = useMemo(() => {
    const m = new Map<string, Budget>();
    budgets?.forEach((b) => {
      if (b.scope === "agent" && b.scopeId) m.set(b.scopeId, b);
    });
    return m;
  }, [budgets]);

  const agentRows = useMemo(() => {
    if (!agents) return [];
    return agents
      .map((a) => {
        const budget = agentBudgetMap.get(a.id) ?? null;
        const spend = todaysSpendByAgent.get(a.id) ?? 0;
        return {
          agent: a,
          budget,
          spend,
        };
      })
      .sort((a, b) => {
        // Agents with budgets first, then highest spend.
        if (!!a.budget !== !!b.budget) return a.budget ? -1 : 1;
        return b.spend - a.spend;
      });
  }, [agents, agentBudgetMap, todaysSpendByAgent]);

  const auditLogs = useMemo(() => {
    if (!logs) return [];
    const auditTypes = new Set([
      "budget.upserted",
      "budget.deleted",
      "pricing.inserted",
      "pricing.deleted",
    ]);
    return logs.filter((l) => auditTypes.has(l.eventType as string)).slice(0, 25);
  }, [logs]);

  // Column defs --------------------------------------------------------------

  const agentColumnDefs = useMemo<ColDef<(typeof agentRows)[number]>[]>(
    () => [
      {
        headerName: "Agent",
        flex: 1,
        minWidth: 200,
        cellRenderer: (params: ICellRendererParams<(typeof agentRows)[number]>) => {
          const row = params.data;
          if (!row) return null;
          return (
            <Link
              to={`/agents/${row.agent.id}`}
              className="font-medium hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.agent.name}
              {row.agent.isLead ? " (Lead)" : ""}
            </Link>
          );
        },
      },
      {
        headerName: "Daily spend / budget",
        flex: 2,
        minWidth: 280,
        cellRenderer: (params: ICellRendererParams<(typeof agentRows)[number]>) => {
          const row = params.data;
          if (!row) return null;
          return (
            <div className="py-2">
              <SpendBar spend={row.spend} budget={row.budget?.dailyBudgetUsd ?? null} />
            </div>
          );
        },
      },
      {
        headerName: "Updated",
        width: 160,
        cellRenderer: (params: ICellRendererParams<(typeof agentRows)[number]>) => {
          const row = params.data;
          if (!row?.budget) return <span className="text-muted-foreground">—</span>;
          return (
            <span className="text-xs text-muted-foreground">
              {formatSmartTime(new Date(row.budget.lastUpdatedAt).toISOString())}
            </span>
          );
        },
      },
      {
        headerName: "Actions",
        width: 110,
        cellRenderer: (params: ICellRendererParams<(typeof agentRows)[number]>) => {
          const row = params.data;
          if (!row) return null;
          return (
            <div
              className="flex h-full items-center gap-1"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() =>
                  setBudgetDialog({
                    scope: "agent",
                    scopeId: row.agent.id,
                    scopeLabel: row.agent.name,
                    initial: row.budget?.dailyBudgetUsd ?? null,
                  })
                }
                title={row.budget ? "Edit budget" : "Set budget"}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              {row.budget ? (
                <Button
                  variant="destructive-outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() =>
                    setBudgetDeleteTarget({
                      scope: "agent",
                      scopeId: row.agent.id,
                      label: row.agent.name,
                    })
                  }
                  title="Remove budget"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [],
  );

  const refusalColumnDefs = useMemo<ColDef<BudgetRefusalNotification>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "When",
        width: 160,
        cellRenderer: (params: ICellRendererParams<BudgetRefusalNotification>) => {
          if (!params.value) return null;
          const iso = new Date(params.value).toISOString();
          return (
            <span className="text-xs text-muted-foreground" title={formatUTCTime(iso)}>
              {formatSmartTime(iso)}
            </span>
          );
        },
      },
      {
        field: "cause",
        headerName: "Cause",
        width: 110,
        cellRenderer: (params: ICellRendererParams<BudgetRefusalNotification>) =>
          params.value
            ? refusalCauseBadge(params.value as BudgetRefusalNotification["cause"])
            : null,
      },
      {
        headerName: "Agent",
        flex: 1,
        minWidth: 160,
        valueGetter: (params) =>
          agentMap.get(params.data?.agentId ?? "")?.name ?? params.data?.agentId,
        cellRenderer: (params: ICellRendererParams<BudgetRefusalNotification>) => {
          const agentId = params.data?.agentId;
          if (!agentId) return null;
          const name = agentMap.get(agentId)?.name ?? `${agentId.slice(0, 8)}...`;
          return (
            <Link
              to={`/agents/${agentId}`}
              className="hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {name}
            </Link>
          );
        },
      },
      {
        headerName: "Spend / budget",
        flex: 1,
        minWidth: 200,
        cellRenderer: (params: ICellRendererParams<BudgetRefusalNotification>) => {
          const r = params.data;
          if (!r) return null;
          if (r.cause === "global") {
            return (
              <span className="font-mono text-xs">
                {formatUsd(r.globalSpendUsd ?? 0)} / {formatUsd(r.globalBudgetUsd ?? 0)}
              </span>
            );
          }
          return (
            <span className="font-mono text-xs">
              {formatUsd(r.agentSpendUsd ?? 0)} / {formatUsd(r.agentBudgetUsd ?? 0)}
            </span>
          );
        },
      },
      {
        headerName: "Parent task",
        flex: 1,
        minWidth: 140,
        cellRenderer: (params: ICellRendererParams<BudgetRefusalNotification>) => {
          const id = params.data?.taskId;
          if (!id) return null;
          return (
            <Link
              to={`/tasks/${id}`}
              className="font-mono text-xs hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {id.slice(0, 8)}
            </Link>
          );
        },
      },
      {
        headerName: "Follow-up",
        flex: 1,
        minWidth: 140,
        cellRenderer: (params: ICellRendererParams<BudgetRefusalNotification>) => {
          const id = params.data?.followUpTaskId;
          if (!id) return <span className="text-muted-foreground">—</span>;
          return (
            <Link
              to={`/tasks/${id}`}
              className="font-mono text-xs hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {id.slice(0, 8)}
            </Link>
          );
        },
      },
      {
        field: "date",
        headerName: "Reset day",
        width: 120,
        cellRenderer: (params: ICellRendererParams<BudgetRefusalNotification>) => (
          <span className="font-mono text-xs text-muted-foreground">{params.value}</span>
        ),
      },
    ],
    [agentMap],
  );

  const pricingColumnDefs = useMemo<ColDef<PricingRow>[]>(
    () => [
      {
        field: "provider",
        headerName: "Provider",
        width: 100,
        cellRenderer: (params: ICellRendererParams<PricingRow>) => (
          <Badge variant="outline" size="tag">
            {params.value}
          </Badge>
        ),
      },
      { field: "model", headerName: "Model", flex: 1, minWidth: 200 },
      {
        field: "tokenClass",
        headerName: "Token class",
        width: 130,
        cellRenderer: (params: ICellRendererParams<PricingRow>) => (
          <Badge variant="outline" size="tag" className="border-sky-500/30 text-sky-400">
            {params.value}
          </Badge>
        ),
      },
      {
        field: "pricePerMillionUsd",
        headerName: "$ / 1M tokens",
        width: 140,
        cellRenderer: (params: ICellRendererParams<PricingRow>) => (
          <span className="font-mono text-xs">${(params.value ?? 0).toFixed(6)}</span>
        ),
      },
      {
        field: "effectiveFrom",
        headerName: "Effective from",
        width: 180,
        cellRenderer: (params: ICellRendererParams<PricingRow>) => {
          if (!params.value) return null;
          const iso = new Date(params.value).toISOString();
          return (
            <span className="text-xs text-muted-foreground" title={formatUTCTime(iso)}>
              {formatSmartTime(iso)}
            </span>
          );
        },
      },
      {
        headerName: "",
        width: 60,
        cellRenderer: (params: ICellRendererParams<PricingRow>) => {
          const row = params.data;
          if (!row) return null;
          return (
            <div
              className="flex h-full items-center"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Button
                variant="destructive-outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => setPricingDeleteTarget(row)}
                title="Delete row (typo correction)"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        },
      },
    ],
    [],
  );

  // ─── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-6">
      <div className="flex items-center gap-2">
        <Wallet className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Budgets &amp; spend</h1>
      </div>

      {/* Global budget */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Global daily budget</CardTitle>
          <CardAction className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setBudgetDialog({
                  scope: "global",
                  scopeId: "",
                  scopeLabel: "global",
                  initial: globalBudget?.dailyBudgetUsd ?? null,
                })
              }
            >
              <Pencil className="h-3.5 w-3.5" />
              {globalBudget ? "Edit" : "Set budget"}
            </Button>
            {globalBudget ? (
              <Button
                size="sm"
                variant="destructive-outline"
                onClick={() =>
                  setBudgetDeleteTarget({ scope: "global", scopeId: "", label: "global" })
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </Button>
            ) : null}
          </CardAction>
        </CardHeader>
        <CardContent>
          {loadingBudgets || loadingSummary ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <SpendBar spend={todaysGlobalSpend} budget={globalBudget?.dailyBudgetUsd ?? null} />
          )}
        </CardContent>
      </Card>

      {/* Per-agent budgets */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Per-agent daily budgets</CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid
            rowData={agentRows}
            columnDefs={agentColumnDefs}
            loading={loadingAgents || loadingSummary || loadingBudgets}
            emptyMessage="No agents found"
            domLayout="autoHeight"
          />
        </CardContent>
      </Card>

      {/* Refusals */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Recent budget refusals</CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid
            rowData={refusals ?? []}
            columnDefs={refusalColumnDefs}
            loading={loadingRefusals}
            emptyMessage="No budget refusals recorded"
            domLayout="autoHeight"
          />
        </CardContent>
      </Card>

      {/* Pricing */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Pricing rows (append-only)</CardTitle>
          <CardAction>
            <Button size="sm" onClick={() => setPricingDialogOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add row
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <DataGrid
            rowData={pricing ?? []}
            columnDefs={pricingColumnDefs}
            loading={loadingPricing}
            emptyMessage="No pricing rows configured (provider falls back to harness-reported cost)"
            domLayout="autoHeight"
          />
        </CardContent>
      </Card>

      {/* Audit feed */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">
            Recent budget &amp; pricing changes
          </CardTitle>
        </CardHeader>
        <CardContent>
          {auditLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No mutation events recorded yet.</p>
          ) : (
            <ul className="space-y-2 text-xs">
              {auditLogs.map((log) => {
                const meta = log.metadata ? JSON.parse(log.metadata) : {};
                return (
                  <li
                    key={log.id}
                    className="flex items-center gap-2 border-b border-border pb-2 last:border-0"
                  >
                    <span className="text-muted-foreground" title={formatUTCTime(log.createdAt)}>
                      {formatSmartTime(log.createdAt)}
                    </span>
                    <Badge variant="outline" size="tag">
                      {log.eventType}
                    </Badge>
                    <span className="font-mono text-muted-foreground">
                      {summarizeAuditEntry(log.eventType, meta)}
                    </span>
                    {meta.apiKeyFingerprint ? (
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                        key:{meta.apiKeyFingerprint}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      {budgetDialog ? (
        <BudgetDialog
          open
          onOpenChange={(open) => !open && setBudgetDialog(null)}
          scope={budgetDialog.scope}
          scopeId={budgetDialog.scopeId}
          scopeLabel={budgetDialog.scopeLabel}
          initialDailyBudgetUsd={budgetDialog.initial}
        />
      ) : null}
      <AddPricingDialog open={pricingDialogOpen} onOpenChange={setPricingDialogOpen} />

      <AlertDialog
        open={!!budgetDeleteTarget}
        onOpenChange={(open) => !open && setBudgetDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove budget</AlertDialogTitle>
            <AlertDialogDescription>
              Remove the daily budget for <strong>{budgetDeleteTarget?.label}</strong>? Any
              currently-running tasks are unaffected; future tasks will no longer be capped at this
              scope.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!budgetDeleteTarget) return;
                deleteBudget.mutate(
                  { scope: budgetDeleteTarget.scope, scopeId: budgetDeleteTarget.scopeId },
                  { onSuccess: () => setBudgetDeleteTarget(null) },
                );
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!pricingDeleteTarget}
        onOpenChange={(open) => !open && setPricingDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete pricing row</AlertDialogTitle>
            <AlertDialogDescription>
              Pricing is normally append-only — delete is intended for typo correction. Are you sure
              you want to remove this row?
              {pricingDeleteTarget ? (
                <span className="mt-2 block font-mono text-xs">
                  {pricingDeleteTarget.provider} / {pricingDeleteTarget.model} /{" "}
                  {pricingDeleteTarget.tokenClass} (effectiveFrom=
                  {pricingDeleteTarget.effectiveFrom})
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!pricingDeleteTarget) return;
                deletePricing.mutate(
                  {
                    provider: pricingDeleteTarget.provider,
                    model: pricingDeleteTarget.model,
                    tokenClass: pricingDeleteTarget.tokenClass,
                    effectiveFrom: pricingDeleteTarget.effectiveFrom,
                  },
                  { onSuccess: () => setPricingDeleteTarget(null) },
                );
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function summarizeAuditEntry(eventType: string, meta: Record<string, unknown>): string {
  if (eventType === "budget.upserted") {
    const before = (meta.before as { dailyBudgetUsd?: number } | null)?.dailyBudgetUsd;
    const after = (meta.after as { dailyBudgetUsd?: number } | null)?.dailyBudgetUsd;
    const scopeId = meta.scopeId === "" ? "(global)" : (meta.scopeId as string);
    return `${meta.scope} ${scopeId}: ${before ?? "—"} → ${after ?? "—"}`;
  }
  if (eventType === "budget.deleted") {
    const before = (meta.before as { dailyBudgetUsd?: number } | null)?.dailyBudgetUsd;
    const scopeId = meta.scopeId === "" ? "(global)" : (meta.scopeId as string);
    return `${meta.scope} ${scopeId}: removed (was ${before ?? "—"})`;
  }
  if (eventType === "pricing.inserted") {
    return `${meta.provider} ${meta.model}/${meta.tokenClass}: $${meta.pricePerMillionUsd}/M`;
  }
  if (eventType === "pricing.deleted") {
    return `${meta.provider} ${meta.model}/${meta.tokenClass} @ ${meta.effectiveFrom}`;
  }
  return JSON.stringify(meta);
}

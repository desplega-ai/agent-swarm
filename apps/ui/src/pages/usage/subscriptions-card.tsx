import { type ReactNode, useMemo } from "react";
import { Link } from "react-router-dom";
import { useSubscriptionPlans } from "@/api/hooks/use-api-keys";
import type { SubscriptionPlan, UsageSummaryByCredentialRow } from "@/api/types";
import { PlanPicker } from "@/components/shared/plan-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DAY_MS, formatCount, formatDay, formatUsd } from "./usage-format";

/** Average month length, used to prorate a monthly list price to days. */
const DAYS_PER_MONTH = 30.44;

const SUBSCRIPTION_LABELS: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: "Claude",
  CODEX_OAUTH: "ChatGPT",
};

const PAY_AS_YOU_GO_LABELS: Record<string, string> = {
  ANTHROPIC_API_KEY: "Anthropic API key",
  OPENAI_API_KEY: "OpenAI API key",
  OPENROUTER_API_KEY: "OpenRouter API key",
  DEEPSEEK_API_KEY: "DeepSeek API key",
  DEVIN_API_KEY: "Devin API key",
};

/** Desktop row layout. Below it, each row stacks and the amounts carry their own labels. */
const ROW_GRID = "@3xl:grid-cols-[minmax(0,1fr)_17rem_6rem_6rem_8rem]";

interface SubscriptionLine {
  key: string;
  row: UsageSummaryByCredentialRow;
  plan: SubscriptionPlan | null;
  planCost: number | null;
  saved: number | null;
}

function credentialKey(row: UsageSummaryByCredentialRow): string {
  return `${row.keyType ?? "none"}:${row.keySuffix ?? "none"}`;
}

/** Saved share of the API value, as a whole percent. */
function savedPercent(saved: number, apiValue: number): string {
  return `${apiValue > 0 ? Math.round((saved / apiValue) * 100) : 0}%`;
}

function Suffix({ suffix }: { suffix: string | null }) {
  if (!suffix) return null;
  return <span className="font-mono text-muted-foreground">...{suffix}</span>;
}

/**
 * What the subscription runs would cost at API prices, minus what their
 * plans cost over the same days. Only credentials with a known plan count.
 * Pay-as-you-go spend is listed below for the full picture.
 */
export function SubscriptionsCard({
  rows,
  windowStartMs,
  filtered,
}: {
  rows: UsageSummaryByCredentialRow[];
  /** Start of the page's window. A credential first used later is billed from its first session. */
  windowStartMs: number;
  /** An agent or user filter is on: API values cover part of the runs, plan costs do not shrink. */
  filtered: boolean;
}) {
  const { data: catalog } = useSubscriptionPlans();

  const { lines, payg } = useMemo(() => {
    const now = Date.now();
    const byCost = (a: UsageSummaryByCredentialRow, b: UsageSummaryByCredentialRow) =>
      b.costUsd - a.costUsd;
    const lines: SubscriptionLine[] = rows
      .filter((row) => row.subscription)
      .sort(byCost)
      .map((row) => {
        const plan =
          catalog?.plans.find((p) => p.id === row.plan && p.keyType === row.keyType) ?? null;
        if (!plan) return { key: credentialKey(row), row, plan, planCost: null, saved: null };
        const billedFrom = Math.max(windowStartMs, Date.parse(row.firstSessionAt));
        const billedDays = Math.max(1, (now - billedFrom) / DAY_MS);
        const planCost = (plan.monthlyUsd * billedDays) / DAYS_PER_MONTH;
        return { key: credentialKey(row), row, plan, planCost, saved: row.costUsd - planCost };
      });
    const payg = rows.filter((row) => !row.subscription).sort(byCost);
    return { lines, payg };
  }, [rows, catalog, windowStartMs]);

  const counted = lines.filter((line) => line.plan);
  const apiValue = counted.reduce((sum, line) => sum + line.row.costUsd, 0);
  const plansCost = counted.reduce((sum, line) => sum + (line.planCost ?? 0), 0);
  const saved = apiValue - plansCost;
  const missing = lines.length - counted.length;
  const paygTotal = payg.reduce((sum, row) => sum + row.costUsd, 0);

  return (
    <Card className="gap-5 py-5">
      <CardHeader className="px-5">
        <CardTitle>Subscriptions vs API</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 px-5">
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No subscription runs in this window. All spend used pay-as-you-go keys.
          </p>
        ) : (
          <div className="space-y-1">
            {counted.length === 0 ? (
              <p className="text-sm">Pick a plan for each subscription to see what it saves.</p>
            ) : saved >= 0 ? (
              <p className="flex flex-wrap items-baseline gap-x-3 text-2xl font-semibold">
                <span>
                  Saved{" "}
                  <span className="font-mono tabular-nums text-status-success-strong">
                    {formatUsd(saved)}
                  </span>
                </span>
                <span className="text-sm font-medium text-status-success-strong">
                  {savedPercent(saved, apiValue)} saved
                </span>
              </p>
            ) : (
              <p className="text-2xl font-semibold">
                Plans cost <span className="font-mono tabular-nums">{formatUsd(-saved)}</span> more
                than API prices
              </p>
            )}
            {counted.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                API value of subscription runs{" "}
                <span className="font-mono tabular-nums text-foreground">
                  {formatUsd(apiValue)}
                </span>
                , minus plans{" "}
                <span className="font-mono tabular-nums text-foreground">
                  {formatUsd(plansCost)}
                </span>
                .
              </p>
            ) : null}
            {counted.length > 0 && saved < 0 ? (
              <p className="text-xs text-muted-foreground">
                Plan cost is prorated per day from the first session in the window.
              </p>
            ) : null}
            {filtered && counted.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                A filter is on. API values count only the filtered runs, but plan costs are for the
                whole credential.
              </p>
            ) : null}
            {missing > 0 && counted.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {missing === 1
                  ? "1 subscription has no plan yet. Its savings are not counted."
                  : `${missing} subscriptions have no plan yet. Their savings are not counted.`}
              </p>
            ) : null}
          </div>
        )}

        {lines.length > 0 ? (
          <div className="@container">
            <div
              className={cn(
                "hidden gap-x-4 border-b border-border-subtle pb-2 text-xs whitespace-nowrap text-muted-foreground @3xl:grid",
                ROW_GRID,
              )}
            >
              <span>Subscription</span>
              <span>Plan</span>
              <span className="text-right">API value</span>
              <span className="text-right">Plan cost</span>
              <span className="text-right">Saved</span>
            </div>
            <ul className="divide-y divide-border-subtle">
              {lines.map((line) => (
                <SubscriptionRow key={line.key} line={line} />
              ))}
            </ul>
          </div>
        ) : null}

        {payg.length > 0 ? (
          <div>
            <div className="flex items-baseline justify-between gap-4 border-b border-border-subtle pb-2">
              <span className="text-sm font-medium">Pay-as-you-go</span>
              <span className="font-mono text-sm tabular-nums">{formatUsd(paygTotal)}</span>
            </div>
            <ul className="divide-y divide-border-subtle">
              {payg.map((row) => (
                <li
                  key={credentialKey(row)}
                  className="flex items-baseline justify-between gap-4 py-2 text-sm"
                >
                  <span className="min-w-0 truncate">
                    {row.keyType === null
                      ? "No recorded credential"
                      : (row.name ?? PAY_AS_YOU_GO_LABELS[row.keyType] ?? row.keyType)}{" "}
                    <Suffix suffix={row.keySuffix} />
                  </span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {formatUsd(row.costUsd)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          {catalog ? `List prices checked ${formatDay(catalog.checkedAt, true)}. ` : null}
          <Link to="/settings/api-keys" className="text-primary hover:underline">
            Rename credentials on the API Keys page
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}

function SubscriptionRow({ line }: { line: SubscriptionLine }) {
  const { row, planCost, saved } = line;
  const typeLabel = (row.keyType && SUBSCRIPTION_LABELS[row.keyType]) ?? row.keyType ?? "";
  return (
    <li className={cn("grid grid-cols-3 items-center gap-x-4 gap-y-2 py-3", ROW_GRID)}>
      <div className="col-span-3 min-w-0 @3xl:col-span-1">
        <p className="truncate text-sm font-medium">
          {row.name ?? (
            <>
              {typeLabel} <Suffix suffix={row.keySuffix} />
            </>
          )}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {row.name ? (
            <>
              {typeLabel} <Suffix suffix={row.keySuffix} />,{" "}
            </>
          ) : null}
          {formatCount(row.sessions)} {row.sessions === 1 ? "session" : "sessions"}
        </p>
      </div>
      <div className="col-span-3 @3xl:col-span-1">
        <PlanPicker
          credential={row}
          label={`Plan for ${row.name ?? `${typeLabel} ...${row.keySuffix ?? ""}`}`}
        />
      </div>
      <Amount label="API value">{formatUsd(row.costUsd)}</Amount>
      <Amount label="Plan cost">{planCost === null ? null : formatUsd(planCost)}</Amount>
      <Amount label="Saved">
        {saved === null ? null : saved >= 0 ? (
          <>
            <span className="text-status-success-strong">{formatUsd(saved)}</span>
            <span className="text-xs text-muted-foreground">
              {savedPercent(saved, row.costUsd)}
            </span>
          </>
        ) : (
          <>
            <span className="text-muted-foreground">+{formatUsd(-saved)}</span>
            <span className="font-sans text-xs text-muted-foreground">plan cost</span>
          </>
        )}
      </Amount>
    </li>
  );
}

/** A right-aligned amount. In the stacked layout the column header is gone, so the label rides along. */
function Amount({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground @3xl:hidden">{label}</p>
      <p
        className={cn(
          "flex flex-wrap items-baseline gap-x-1.5 font-mono text-sm tabular-nums @3xl:justify-end",
          children === null && "text-muted-foreground",
        )}
      >
        {children ?? "n/a"}
      </p>
    </div>
  );
}

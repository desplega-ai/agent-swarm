import { openAICompatibleProviders, providerKeyVars } from "@desplega/model-catalog";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useSubscriptionPlans } from "@/api/hooks/use-api-keys";
import type { UsageSummaryByCredentialRow } from "@/api/types";
import { PlanPicker } from "@/components/shared/plan-picker";
import { Card, CardContent } from "@/components/ui/card";
import {
  credentialKey,
  type SubscriptionLine,
  subscriptionSavings,
} from "@/lib/subscription-savings";
import { cn } from "@/lib/utils";
import { formatCount, formatDay, formatUsd } from "./usage-format";

const SUBSCRIPTION_LABELS: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: "Claude",
  CODEX_OAUTH: "ChatGPT",
};

const PAY_AS_YOU_GO_LABELS: Record<string, string> = {
  ANTHROPIC_API_KEY: "Anthropic API key",
  OPENAI_API_KEY: "OpenAI API key",
  OPENROUTER_API_KEY: "OpenRouter API key",
  DEEPSEEK_API_KEY: "DeepSeek API key",
  // OpenAI-compatible registry providers, canonical key and aliases.
  ...Object.fromEntries(
    openAICompatibleProviders().flatMap((p) =>
      providerKeyVars(p).map((name) => [name, `${p.displayName} API key`]),
    ),
  ),
  DEVIN_API_KEY: "Devin API key",
};

/** Desktop row layout. Below it, each row stacks and the amounts carry their own labels. */
const ROW_GRID = "@3xl:grid-cols-[minmax(0,1fr)_17rem_6rem_6rem_8rem]";

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
 * Pay-as-you-go spend is listed below for the full picture. The headline
 * comes first; both lists start folded so the chart stays on the first screen.
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

  const { lines, payg, counted, apiValue, plansCost, saved } = useMemo(
    () => subscriptionSavings(rows, catalog?.plans ?? [], windowStartMs, Date.now()),
    [rows, catalog, windowStartMs],
  );
  const missing = lines.length - counted.length;
  const paygTotal = payg.reduce((sum, row) => sum + row.costUsd, 0);
  const unattributed = rows.filter((row) => row.keyType === null);
  const unattributedSessions = unattributed.reduce((sum, row) => sum + row.sessions, 0);

  return (
    <Card className="gap-5 py-5">
      <CardContent className="relative space-y-4 px-5">
        <h2 className="absolute top-0 right-5 text-xs font-normal text-muted-foreground">
          Subscriptions vs API
        </h2>
        {lines.length === 0 ? (
          <p className="pr-36 text-sm text-muted-foreground">
            No attributed subscription runs in this window.
          </p>
        ) : (
          <div className="space-y-1 pr-36">
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
          <FoldedList
            title="Subscriptions"
            count={lines.length}
            total={formatUsd(lines.reduce((sum, line) => sum + line.row.costUsd, 0))}
          >
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
          </FoldedList>
        ) : null}

        {payg.length > 0 ? (
          <FoldedList title="Pay-as-you-go" count={payg.length} total={formatUsd(paygTotal)}>
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
          </FoldedList>
        ) : null}

        {unattributed.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Unattributed: {formatUsd(unattributed.reduce((sum, row) => sum + row.costUsd, 0))}
            {" across "}
            {formatCount(unattributedSessions)}
            {unattributedSessions === 1 ? " session" : " sessions"}
            {". They reported no credential, so their billing type is unknown."}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {catalog ? `List prices checked ${formatDay(catalog.checkedAt, true)}. ` : null}
          <Link to="/integrations/ai" className="text-primary hover:underline">
            Rename credentials on the AI providers page
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}

/** A list behind a one-line toggle (title, count, total). Folded on load. */
function FoldedList({
  title,
  count,
  total,
  children,
}: {
  title: string;
  count: number;
  total: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-baseline justify-between gap-4 border-b border-border-subtle pb-2 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <ChevronRight
            aria-hidden
            className={cn(
              "size-4 self-center text-muted-foreground transition-transform duration-150",
              open && "rotate-90",
            )}
          />
          {title}
          <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
            {count}
          </span>
        </span>
        <span className="font-mono text-sm tabular-nums">{total}</span>
      </button>
      {open ? <div id={bodyId}>{children}</div> : null}
    </div>
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

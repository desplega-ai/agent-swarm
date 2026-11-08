import { openAICompatibleProviders, providerKeyVars } from "@desplega/model-catalog";
import { ChevronRight, CircleAlert, RotateCcw } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApiKeyStatuses, useSubscriptionPlans } from "@/api/hooks/use-api-keys";
import type { ApiKeyStatus, UsageSummaryByCredentialRow } from "@/api/types";
import { KeyQuotaDetails, QuotaBar } from "@/components/providers/key-quota-details";
import { PlanPicker } from "@/components/shared/plan-picker";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { resetLabel } from "@/lib/ai-providers";
import {
  currentQuotaWindows,
  type QuotaWindow,
  quotaIsHigh,
  quotaLabel,
  quotaRemaining,
  quotaResetIn,
} from "@/lib/provider-quota";
import {
  credentialKey,
  type SubscriptionLine,
  subscriptionSavings,
} from "@/lib/subscription-savings";
import { cn } from "@/lib/utils";
import { formatCount, formatDay, formatUsd } from "./usage-format";

/** Subscription providers, in display order: label and mark. */
const SUBSCRIPTION_PROVIDERS: Record<string, { label: string; icon: "anthropic" | "openai" }> = {
  CLAUDE_CODE_OAUTH_TOKEN: { label: "Claude", icon: "anthropic" },
  CODEX_OAUTH: { label: "ChatGPT", icon: "openai" },
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

/** Saved share of the API value, as a whole percent. */
function savedPercent(saved: number, apiValue: number): string {
  return `${apiValue > 0 ? Math.round((saved / apiValue) * 100) : 0}%`;
}

/** A saving in green, a loss (plans cost more) in red with a minus sign. */
function SavedAmount({ saved, className }: { saved: number; className?: string }) {
  return (
    <span
      className={cn(
        "font-mono tabular-nums",
        saved >= 0 ? "text-status-success-strong" : "text-status-error-strong",
        className,
      )}
    >
      {saved >= 0 ? formatUsd(saved) : `-${formatUsd(-saved)}`}
    </span>
  );
}

function Suffix({ suffix }: { suffix: string | null }) {
  if (!suffix) return null;
  return <span className="font-mono text-muted-foreground">...{suffix}</span>;
}

/**
 * What the subscription runs would cost at API prices, minus what their
 * plans cost over the same days. Only credentials with a known plan count.
 * Each subscription is a card with its current provider limits, grouped by
 * provider. Pay-as-you-go spend is listed below for the full picture. Both
 * lists start folded so the chart stays on the first screen.
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
  const { data: catalog, isLoading: catalogLoading } = useSubscriptionPlans();

  const { lines, payg, counted, apiValue, plansCost, saved } = useMemo(
    () => subscriptionSavings(rows, catalog?.plans ?? [], windowStartMs, Date.now()),
    [rows, catalog, windowStartMs],
  );
  const missing = lines.length - counted.length;
  const paygTotal = payg.reduce((sum, row) => sum + row.costUsd, 0);
  const unattributed = rows.filter((row) => row.keyType === null);
  const unattributedSessions = unattributed.reduce((sum, row) => sum + row.sessions, 0);

  // The headline needs the plan prices: without them every plan reads unknown.
  if (catalogLoading) {
    return (
      <Card className="gap-5 py-5" aria-busy="true">
        <CardContent className="space-y-3 px-5">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
          <Skeleton className="h-6 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-5 py-5">
      <CardContent className="relative space-y-4 px-5">
        <h2 className="absolute top-0 right-5 hidden text-xs font-normal text-muted-foreground sm:block">
          Subscriptions vs API
        </h2>
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground sm:pr-36">
            No attributed subscription runs in this window.
          </p>
        ) : !catalog ? (
          <p className="text-sm text-muted-foreground sm:pr-36">
            Plan prices did not load, so savings are unknown.
          </p>
        ) : counted.length === 0 ? (
          <p className="text-sm sm:pr-36">
            Pick a plan for each subscription to see what it saves.
          </p>
        ) : (
          <div className="space-y-1.5 sm:pr-36">
            <p className="flex flex-wrap items-baseline gap-x-3 text-2xl font-semibold">
              <span>
                Saved <SavedAmount saved={saved} />
              </span>
              <span
                className={cn(
                  "text-sm font-medium",
                  saved >= 0 ? "text-status-success-strong" : "text-status-error-strong",
                )}
              >
                {saved >= 0 ? `${savedPercent(saved, apiValue)} saved` : "plans cost more"}
              </span>
            </p>
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
              API value
              <span className="font-mono tabular-nums text-foreground">{formatUsd(apiValue)}</span>
              <span aria-hidden>·</span>
              plans
              <span className="font-mono tabular-nums text-foreground">{formatUsd(plansCost)}</span>
              <InfoTip
                content={`API value of the subscription runs minus their plans at list price (checked ${formatDay(catalog.checkedAt, true)}), prorated per day from each credential's first session in the window.`}
              />
            </p>
            {missing > 0 || filtered ? (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {missing > 0 ? (
                  <NoteBadge
                    label={`${missing} without a plan`}
                    tip={
                      missing === 1
                        ? "Its savings are not counted. Pick its plan below."
                        : "Their savings are not counted. Pick their plans below."
                    }
                  />
                ) : null}
                {filtered ? (
                  <NoteBadge
                    label="Filter on"
                    tip="API values count only the filtered runs, but plan costs are for the whole credential."
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {lines.length > 0 ? (
          <FoldedList
            title="Subscriptions"
            count={lines.length}
            total={formatUsd(lines.reduce((sum, line) => sum + line.row.costUsd, 0))}
          >
            <SubscriptionGroups lines={lines} />
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

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {unattributed.length > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              Unattributed
              <span className="font-mono tabular-nums text-foreground">
                {formatUsd(unattributed.reduce((sum, row) => sum + row.costUsd, 0))}
              </span>
              · {formatCount(unattributedSessions)}
              {unattributedSessions === 1 ? " session" : " sessions"}
              <InfoTip content="These sessions reported no credential, so their billing type is unknown." />
            </span>
          ) : (
            <span />
          )}
          <Link to="/integrations/ai" className="text-primary hover:underline">
            Rename credentials
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

/** A short muted note whose explanation sits in a tooltip. */
function NoteBadge({ label, tip }: { label: string; tip: string }) {
  return (
    <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
      {label}
      <InfoTip content={tip} />
    </Badge>
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
      {open ? (
        <div id={bodyId} className="pt-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Subscription cards under a header per provider, providers in a fixed order. */
function SubscriptionGroups({ lines }: { lines: SubscriptionLine[] }) {
  // Quota windows come from the key status rows, the same source as the AI providers page.
  const { data: statuses } = useApiKeyStatuses();
  const nowMs = useMinuteClock();
  const groups = Object.entries(SUBSCRIPTION_PROVIDERS)
    .map(([keyType, provider]) => ({
      keyType,
      provider,
      lines: lines.filter((line) => line.row.keyType === keyType),
    }))
    .filter((group) => group.lines.length > 0);
  return (
    <div className="@container space-y-5">
      {groups.map((group) => (
        <section key={group.keyType} aria-label={group.provider.label} className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ProviderIcon provider={group.provider.icon} className="size-4 opacity-100" />
            {group.provider.label}
            <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
              {group.lines.length}
            </span>
          </h3>
          <ul className="space-y-2">
            {group.lines.map((line) => (
              <SubscriptionCard
                key={line.key}
                line={line}
                typeLabel={group.provider.label}
                statuses={(statuses ?? []).filter(
                  (s) => s.keyType === line.row.keyType && s.keySuffix === line.row.keySuffix,
                )}
                nowMs={nowMs}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SubscriptionCard({
  line,
  typeLabel,
  statuses,
  nowMs,
}: {
  line: SubscriptionLine;
  typeLabel: string;
  statuses: ApiKeyStatus[];
  nowMs: number;
}) {
  const { row, planCost, saved } = line;
  const label = row.name ?? `${typeLabel} ...${row.keySuffix ?? ""}`;
  const windows = currentQuotaWindows(statuses, nowMs);
  return (
    <li className="space-y-3 rounded-lg border border-border-subtle bg-card p-3 @xl:p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
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
                <Suffix suffix={row.keySuffix} /> ·{" "}
              </>
            ) : null}
            {formatCount(row.sessions)} {row.sessions === 1 ? "session" : "sessions"}
          </p>
        </div>
        <PlanPicker
          credential={row}
          label={`Plan for ${label}`}
          className="w-full @xl:w-auto @xl:flex-nowrap"
        />
      </div>
      <div
        className={cn(
          "grid gap-x-6 gap-y-3",
          windows.length > 0 && "@2xl:grid-cols-[13rem_minmax(0,1fr)] @2xl:items-center",
        )}
      >
        <div className="min-w-0">
          {saved === null ? (
            <>
              <p className="font-mono text-2xl font-semibold tabular-nums">
                {formatUsd(row.costUsd)}
              </p>
              <p className="text-xs text-muted-foreground">API value · no plan, not counted</p>
            </>
          ) : (
            <>
              <p className="flex items-baseline gap-2">
                <SavedAmount saved={saved} className="text-2xl font-semibold" />
                <span
                  className={cn(
                    "text-xs",
                    saved >= 0 ? "text-status-success-strong" : "text-status-error-strong",
                  )}
                >
                  {saved >= 0 ? `saved · ${savedPercent(saved, row.costUsd)}` : "plan costs more"}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                API value{" "}
                <span className="font-mono tabular-nums text-foreground">
                  {formatUsd(row.costUsd)}
                </span>{" "}
                · plan{" "}
                <span className="font-mono tabular-nums text-foreground">
                  {formatUsd(planCost ?? 0)}
                </span>
              </p>
            </>
          )}
        </div>
        {windows.length > 0 ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                aria-label={`Limits and usage for ${label}`}
                className="h-auto w-full flex-col items-stretch gap-2 px-2 py-1.5 font-normal"
              >
                {windows.map((w) => (
                  <WindowMeter key={w.key} window={w} nowMs={nowMs} />
                ))}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              collisionPadding={16}
              aria-label={`${label} quota details`}
              className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
            >
              <KeyQuotaDetails
                poolKey={{ keyType: row.keyType ?? "", suffix: row.keySuffix, label, statuses }}
                windows={windows}
                nowMs={nowMs}
              />
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </li>
  );
}

/**
 * One limit window: label, remaining share and reset countdown, with the bar
 * between them on wide cards and on its own line on narrow ones.
 */
function WindowMeter({ window, nowMs }: { window: QuotaWindow; nowMs: number }) {
  const label = quotaLabel(window);
  const warning = window.limited || window.overageStatus === "rejected";
  return (
    <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-xs @xl:grid-cols-[minmax(0,8rem)_minmax(0,1fr)_9rem]">
      <span className="flex min-w-0 items-center gap-1 text-left text-foreground/70">
        <span className="truncate" title={label}>
          {label}
        </span>
        {warning ? (
          <CircleAlert
            aria-label="Limit or credits restricted"
            className="size-3 shrink-0 text-status-warning-strong"
          />
        ) : null}
      </span>
      <span className="inline-flex items-center justify-end gap-2 tabular-nums @xl:col-start-3">
        <span className={cn(quotaIsHigh(window.percent) && "text-status-warning-strong")}>
          {window.percent === null ? "Use not reported" : `${quotaRemaining(window.percent)}% left`}
        </span>
        {window.resetsAtMs !== null ? (
          <span
            className="inline-flex items-center gap-1 text-foreground/70"
            title={`Resets ${resetLabel(window.resetsAtMs)}`}
          >
            <RotateCcw aria-hidden className="size-3" />
            {quotaResetIn(window.resetsAtMs, nowMs)}
          </span>
        ) : null}
      </span>
      {window.percent === null ? null : (
        <QuotaBar
          percent={window.percent}
          className="col-span-2 h-1.5 @xl:col-span-1 @xl:col-start-2 @xl:row-start-1"
        />
      )}
    </span>
  );
}

import { useKeyWindowUsage } from "@/api/hooks/use-api-keys";
import type { KeyWindowUsage, WindowUsageCounter } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { InfoRow } from "@/components/ui/info-row";
import { type ProviderKey, resetLabel } from "@/lib/ai-providers";
import { formatTokens } from "@/lib/format-tokens";
import {
  type AccountFacts,
  type AccountLimit,
  accountFacts,
  type Fact,
  type QuotaWindow,
  quotaIsHigh,
  quotaLabel,
  quotaRemaining,
  usageCreditsLabel,
} from "@/lib/provider-quota";
import { cn, formatRelativeTime } from "@/lib/utils";

const UNAVAILABLE: Record<NonNullable<KeyWindowUsage["unavailableReason"]>, string> = {
  missing_reset: "No reset time reported, so the window bounds are unknown.",
  unknown_duration: "The provider did not report the window length.",
  unknown_model_scope: "It is unknown which models this limit covers.",
  window_not_started: "This window has not started yet.",
};

const COUNTERS: Array<[keyof NonNullable<KeyWindowUsage["usage"]>["tokens"], string]> = [
  ["uncachedInput", "Input"],
  ["output", "Output"],
  ["cacheRead", "Cache read"],
  ["cacheWrite", "Cache write"],
  ["reasoning", "Reasoning"],
  ["thinking", "Thinking"],
];

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

/** Filled space represents the remaining allowance. */
export function QuotaBar({ percent, className }: { percent: number; className?: string }) {
  return (
    <span aria-hidden className={cn("block h-1 overflow-hidden rounded-full bg-muted", className)}>
      <span
        className={cn(
          "block h-full rounded-full",
          quotaIsHigh(percent) ? "bg-status-warning" : "bg-foreground/50",
        )}
        style={{ width: `${quotaRemaining(percent)}%` }}
      />
    </span>
  );
}

function counterText(counter: WindowUsageCounter, sessions: number): string {
  if (counter.value === null) return "Not reported";
  const value = formatTokens(counter.value);
  return counter.missingSessions > 0
    ? `${value} (${counter.measuredSessions} of ${sessions} sessions)`
    : value;
}

function ObservedUsage({
  match,
  state,
  nowMs,
}: {
  match: KeyWindowUsage | undefined;
  state: "loading" | "error" | "ready";
  nowMs: number;
}) {
  const muted = "text-xs text-foreground/70";
  if (state === "loading") return <p className={muted}>Loading Swarm usage…</p>;
  if (state === "error") return <p className={muted}>Swarm usage is not available.</p>;
  // A cached answer can outlive the window: the client clock decides.
  if (!match || (match.endsAt && Date.parse(match.endsAt) <= nowMs)) {
    return <p className={muted}>No Swarm usage for this window yet.</p>;
  }
  if (!match.usage) {
    return (
      <p className={muted}>
        Swarm usage unavailable.{" "}
        {match.unavailableReason ? UNAVAILABLE[match.unavailableReason] : null}
      </p>
    );
  }
  const { usage } = match;
  return (
    <div className="space-y-1.5">
      <p className="text-xs">
        <span className="text-foreground/70">Swarm runs: </span>
        {plural(usage.sessions, "session")}
        {usage.errorSessions > 0 ? ` (${usage.errorSessions} with errors)` : ""},{" "}
        {plural(usage.completedTasks, "task")} completed
      </p>
      {usage.sessions > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {COUNTERS.map(([key, label]) => (
            <div key={key} className="contents">
              <dt className="text-foreground/70">{label}</dt>
              <dd className="font-mono tabular-nums">
                {counterText(usage.tokens[key], usage.sessions)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {usage.modelUnattributedSessions > 0 ? (
        <p className={muted}>
          {plural(usage.modelUnattributedSessions, "session")} had no per-model breakdown and
          {usage.modelUnattributedSessions === 1 ? " is" : " are"} not counted here.
        </p>
      ) : null}
      {usage.swarmUnattributedSessions > 0 ? (
        <p className={muted}>
          Across the swarm, {plural(usage.swarmUnattributedSessions, "session")} in this period
          reported no credential. Those sessions count for no key, so this key's totals may be
          incomplete.
        </p>
      ) : null}
      <p className={muted}>
        Swarm sessions only, counted when each cost report arrived, through{" "}
        {resetLabel(Date.parse(match.dataThrough))}.
      </p>
    </div>
  );
}

function WindowCard({
  window,
  match,
  state,
  nowMs,
}: {
  window: QuotaWindow;
  match: KeyWindowUsage | undefined;
  state: "loading" | "error" | "ready";
  nowMs: number;
}) {
  const credits = usageCreditsLabel(window);
  return (
    <li className="space-y-2 rounded-md border border-border-subtle bg-card px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium" title={quotaLabel(window)}>
          {quotaLabel(window)}
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-xs tabular-nums",
            quotaIsHigh(window.percent) && "text-status-warning-strong",
          )}
        >
          {window.percent === null ? "Use not reported" : `${quotaRemaining(window.percent)}% left`}
        </span>
      </div>
      {window.percent !== null ? <QuotaBar percent={window.percent} /> : null}
      <p className="text-xs text-foreground/70">
        {window.resetsAtMs === null
          ? "Reset not reported"
          : `Resets ${resetLabel(window.resetsAtMs)}`}
        {` · seen ${formatRelativeTime(window.observedAt)}`}
        {window.resetObservedAt
          ? ` · reset reported ${formatRelativeTime(window.resetObservedAt)}`
          : ""}
      </p>
      {window.limited ? (
        <Badge
          variant="outline"
          size="tag"
          className="border-status-warning/30 text-status-warning-strong"
        >
          Limit reached
        </Badge>
      ) : null}
      {credits ? <p className="text-xs text-foreground/70">{credits}</p> : null}
      <details className="text-xs">
        <summary className="cursor-pointer rounded-sm text-foreground/70 outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
          Swarm usage
        </summary>
        <div className="pt-2">
          <ObservedUsage match={match} state={state} nowMs={nowMs} />
        </div>
      </details>
    </li>
  );
}

function FactValue<T>({
  fact,
  render,
  expiredAtMs,
}: {
  fact: Fact<T | null> | null | undefined;
  render: (v: T) => string;
  expiredAtMs?: number | null;
}) {
  if (!fact) return <span className="text-foreground/70">Not reported</span>;
  return (
    <span>
      {expiredAtMs != null && Date.parse(fact.at) <= expiredAtMs
        ? "Previous period, current state unknown"
        : fact.value === null
          ? "Not reported"
          : render(fact.value)}
      <span className="block text-xs text-foreground/70">
        reported {formatRelativeTime(fact.at)}
      </span>
    </span>
  );
}

const yesNo = (v: boolean) => (v ? "Yes" : "No");

function LimitFacts({ limit, nowMs }: { limit: AccountLimit; nowMs: number }) {
  const { credits, spend, spendControlReached, reachedType, planRaw } = limit.facts;
  const resetMs = spend?.value ? spend.value.resetsAt * 1000 : null;
  const expiredAtMs = resetMs !== null && resetMs <= nowMs ? resetMs : null;
  return (
    <>
      {planRaw ? (
        <InfoRow className="[&>span]:text-foreground/70" label="Plan reported">
          <FactValue fact={planRaw} render={(v) => String(v)} />
        </InfoRow>
      ) : null}
      {credits ? (
        <InfoRow className="[&>span]:text-foreground/70" label="Credits">
          <FactValue
            fact={credits}
            render={(v) =>
              v.unlimited
                ? "Unlimited"
                : typeof v.balance === "string"
                  ? `Balance ${v.balance}`
                  : v.hasCredits
                    ? "Has credits, balance not reported"
                    : "No credits"
            }
          />
        </InfoRow>
      ) : null}
      {spend ? (
        <InfoRow className="[&>span]:text-foreground/70" label="Spend control">
          <FactValue
            fact={spend}
            render={(v) =>
              expiredAtMs !== null
                ? `Period reset ${resetLabel(expiredAtMs)}, no newer report`
                : `${v.remainingPercent}% left, ${v.used} of ${v.limit} used (provider units), resets ${resetLabel(v.resetsAt * 1000)}`
            }
          />
        </InfoRow>
      ) : null}
      {spendControlReached ? (
        <InfoRow className="[&>span]:text-foreground/70" label="Spend cap reached">
          <FactValue fact={spendControlReached} render={yesNo} expiredAtMs={expiredAtMs} />
        </InfoRow>
      ) : null}
      {reachedType?.value ? (
        <InfoRow className="[&>span]:text-foreground/70" label="Blocked by">
          <FactValue
            fact={reachedType}
            render={(v) => v.replaceAll("_", " ")}
            expiredAtMs={expiredAtMs}
          />
        </InfoRow>
      ) : null}
    </>
  );
}

const FACT_GRID = "grid grid-cols-2 gap-3";

/** Account facts. One limit shares the grid with the account rows; several get a heading each. */
function AccountSection({ facts, nowMs }: { facts: AccountFacts; nowMs: number }) {
  const [first, ...rest] = facts.limits;
  const single = rest.length === 0;
  return (
    <div className="space-y-3">
      <p className="text-xs font-medium text-foreground/70">Account</p>
      <div className={FACT_GRID}>
        {facts.ordinaryUsageAllowed ? (
          <InfoRow className="[&>span]:text-foreground/70" label="Included use allowed">
            <FactValue fact={facts.ordinaryUsageAllowed} render={yesNo} />
          </InfoRow>
        ) : null}
        {facts.resetCreditsAvailable ? (
          <InfoRow className="[&>span]:text-foreground/70" label="Reset credits">
            <FactValue fact={facts.resetCreditsAvailable} render={(v) => v.toLocaleString()} />
          </InfoRow>
        ) : null}
        {single && first ? <LimitFacts limit={first} nowMs={nowMs} /> : null}
      </div>
      {single
        ? null
        : facts.limits.map((limit) => (
            <div key={limit.id} className="space-y-2">
              <p className="text-xs font-medium">{limit.name}</p>
              <div className={FACT_GRID}>
                <LimitFacts limit={limit} nowMs={nowMs} />
              </div>
            </div>
          ))}
    </div>
  );
}

/**
 * The expanded details of one credential: every current quota window with its
 * reset, observation age and the Swarm usage inside it, then the account facts
 * the provider reported (credits, spend control, blocking reasons).
 */
export function KeyQuotaDetails({
  poolKey: k,
  windows,
  nowMs,
}: {
  /** A pool key, or any credential with the same fields (the Usage page's subscriptions). */
  poolKey: Pick<ProviderKey, "keyType" | "suffix" | "label" | "statuses">;
  windows: QuotaWindow[];
  nowMs: number;
}) {
  const usage = useKeyWindowUsage(k.suffix ? { keyType: k.keyType, keySuffix: k.suffix } : null);
  const state = usage.isLoading ? "loading" : usage.isError ? "error" : "ready";
  const facts = accountFacts(k.statuses);
  const codex = k.keyType === "CODEX_OAUTH";
  return (
    <section aria-label={`${k.label} limits and usage`} className="space-y-3">
      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground/70">Current limits</p>
        {windows.length === 0 ? (
          <p className="text-sm text-foreground/70">
            No current limit data.{" "}
            {codex
              ? "Native Codex runs report quota. Runs through pi do not."
              : "The provider reports limits while agents run."}
          </p>
        ) : (
          <ul className="grid items-start gap-2">
            {windows.map((w) => (
              <WindowCard
                key={w.key}
                window={w}
                nowMs={nowMs}
                state={state}
                match={usage.data?.windows.find(
                  (u) => u.statusId === w.statusId && u.windowKey === w.key,
                )}
              />
            ))}
          </ul>
        )}
      </div>
      {facts ? <AccountSection facts={facts} nowMs={nowMs} /> : null}
    </section>
  );
}

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

/** The bar stops at 100%. The number keeps what the provider reported. */
export function QuotaBar({ percent, className }: { percent: number; className?: string }) {
  return (
    <span aria-hidden className={cn("block h-1 overflow-hidden rounded-full bg-muted", className)}>
      <span
        className={cn(
          "block h-full rounded-full",
          quotaIsHigh(percent) ? "bg-status-warning" : "bg-foreground/50",
        )}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
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
  const muted = "text-xs text-muted-foreground";
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
        <span className="text-muted-foreground">Swarm runs: </span>
        {plural(usage.sessions, "session")}
        {usage.errorSessions > 0 ? ` (${usage.errorSessions} with errors)` : ""},{" "}
        {plural(usage.completedTasks, "task")} completed
      </p>
      {usage.sessions > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {COUNTERS.map(([key, label]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
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
        Counted when each cost report arrived, through {resetLabel(Date.parse(match.dataThrough))}.
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
        <span className="min-w-0 truncate text-sm font-medium" title={window.name}>
          {window.name}
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-xs tabular-nums",
            quotaIsHigh(window.percent) && "text-status-warning-strong",
          )}
        >
          {window.percent === null ? "Use not reported" : `${window.percent}% used`}
        </span>
      </div>
      {window.percent !== null ? <QuotaBar percent={window.percent} /> : null}
      <p className="text-xs text-muted-foreground">
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
      {credits ? <p className="text-xs text-muted-foreground">{credits}</p> : null}
      <ObservedUsage match={match} state={state} nowMs={nowMs} />
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
  if (!fact) return <span className="text-muted-foreground">Not reported</span>;
  return (
    <span>
      {expiredAtMs != null && Date.parse(fact.at) <= expiredAtMs
        ? "Previous period, current state unknown"
        : fact.value === null
          ? "Not reported"
          : render(fact.value)}
      <span className="block text-xs text-muted-foreground">
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
        <InfoRow label="Plan reported">
          <FactValue fact={planRaw} render={(v) => String(v)} />
        </InfoRow>
      ) : null}
      {credits ? (
        <InfoRow label="Credits">
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
        <InfoRow label="Spend control">
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
        <InfoRow label="Spend cap reached">
          <FactValue fact={spendControlReached} render={yesNo} expiredAtMs={expiredAtMs} />
        </InfoRow>
      ) : null}
      {reachedType?.value ? (
        <InfoRow label="Blocked by">
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

const FACT_GRID = "grid gap-3 sm:grid-cols-2 lg:grid-cols-4";

/** Account facts. One limit shares the grid with the account rows; several get a heading each. */
function AccountSection({ facts, nowMs }: { facts: AccountFacts; nowMs: number }) {
  const [first, ...rest] = facts.limits;
  const single = rest.length === 0;
  return (
    <div className="space-y-3">
      <p className="text-xs font-medium text-muted-foreground">Account</p>
      <div className={FACT_GRID}>
        {facts.ordinaryUsageAllowed ? (
          <InfoRow label="Included use allowed">
            <FactValue fact={facts.ordinaryUsageAllowed} render={yesNo} />
          </InfoRow>
        ) : null}
        {facts.resetCreditsAvailable ? (
          <InfoRow label="Reset credits">
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
  id,
  poolKey: k,
  windows,
  nowMs,
}: {
  id: string;
  poolKey: ProviderKey;
  windows: QuotaWindow[];
  nowMs: number;
}) {
  const usage = useKeyWindowUsage(k.suffix ? { keyType: k.keyType, keySuffix: k.suffix } : null);
  const state = usage.isLoading ? "loading" : usage.isError ? "error" : "ready";
  const facts = accountFacts(k.statuses);
  const codex = k.keyType === "CODEX_OAUTH";
  return (
    <section
      id={id}
      aria-label={`${k.label} limits and usage`}
      className="space-y-4 border-t border-border-subtle px-4 py-3 md:pl-8"
    >
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Current limits</p>
        {windows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No current limit data.{" "}
            {codex
              ? "Native Codex runs report quota. Runs through pi do not."
              : "The provider reports limits while agents run."}
          </p>
        ) : (
          <ul className="grid items-start gap-2 sm:grid-cols-2 xl:grid-cols-3">
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
      <p className="text-xs text-muted-foreground">
        Swarm usage counts only this swarm's sessions on this credential. It is not the provider's
        allowance or remaining quota. Limits that overlap never add up.
      </p>
    </section>
  );
}

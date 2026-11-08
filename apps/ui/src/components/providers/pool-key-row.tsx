import { ChevronRight, CircleAlert, MoreHorizontal, Timer } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
  useClearApiKeyRateLimit,
  useSetApiKeyName,
  useSubscriptionPlans,
} from "@/api/hooks/use-api-keys";
import { useRemoveCodexAccount } from "@/api/hooks/use-codex-accounts";
import { useRemovePoolKey } from "@/api/hooks/use-pool-keys";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { isSubscriptionKeyType, PlanPicker } from "@/components/shared/plan-picker";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import {
  type AiProvider,
  backAt,
  type KeyHealth,
  type ProviderKey,
  resetLabel,
} from "@/lib/ai-providers";
import { formatCost } from "@/lib/cost-format";
import {
  currentQuotaWindows,
  planDisplay,
  type QuotaWindow,
  quotaIsHigh,
  usageCreditsLabel,
} from "@/lib/provider-quota";
import { cn, formatRelativeTime } from "@/lib/utils";
import { KeyQuotaDetails, QuotaBar } from "./key-quota-details";

/**
 * The column grid of the LLMs list, from `md` up: provider (or key), type,
 * count, status (or usage limits), today, 7 days, the row action. A key row
 * spans its plan over type and count, so the amounts line up.
 */
export const PROVIDER_GRID =
  "md:grid md:grid-cols-[minmax(0,1.6fr)_6.5rem_6.5rem_minmax(0,1.4fr)_5rem_5rem_2rem] md:items-center md:gap-x-4";

const DOT: Record<KeyHealth, string> = {
  ok: "bg-status-success",
  unchecked: "bg-status-neutral",
  limited: "bg-status-warning",
  failing: "bg-status-error",
};

const DOT_LABEL: Record<KeyHealth, string> = {
  ok: "Available",
  unchecked: "Not checked yet",
  limited: "Rate limited",
  failing: "Failing",
};

/** "fable" as "Fable". */
function modelName(model: string): string {
  return model.charAt(0).toUpperCase() + model.slice(1);
}

/** Older than this, a meter says when the provider last reported it. */
const STALE_MS = 60 * 60_000;
/** Meters in the row. The details list every window. */
const ROW_METERS = 3;

/**
 * One current window: its name ("7 d", "Fable 7 d"), a short bar, the percent
 * as reported (it can pass 100), and when it resets. An old observation says
 * so. A window without a reported percent shows no bar, never 0%.
 */
function Meter({ window, nowMs }: { window: QuotaWindow; nowMs: number }) {
  const high = quotaIsHigh(window.percent);
  const stale = nowMs - Date.parse(window.observedAt) > STALE_MS;
  const credits = usageCreditsLabel(window);
  return (
    <span className="inline-flex min-w-0 flex-col gap-0.5 text-[11px] text-muted-foreground">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="max-w-28 truncate" title={window.name}>
          {window.name}
        </span>
        {window.percent === null ? (
          <span>use not reported</span>
        ) : (
          <>
            <QuotaBar percent={window.percent} className="w-10 shrink-0" />
            <span className={cn("font-mono", high && "text-status-warning-strong")}>
              {window.percent}%
            </span>
          </>
        )}
      </span>
      <span>
        {window.resetsAtMs === null
          ? "Reset not reported"
          : `Resets ${resetLabel(window.resetsAtMs)}`}
        {stale ? `, seen ${formatRelativeTime(window.observedAt)}` : ""}
      </span>
      {window.limited ? <span className="text-status-warning-strong">Limit reached</span> : null}
      {credits ? <span>{credits}</span> : null}
    </span>
  );
}

/** A badge per model whose weekly window the provider closed ("Fable limit, resets 14:00"). */
function ModelLimitBadges({ status, nowMs }: { status: ProviderKey["status"]; nowMs: number }) {
  // `active` is the server's view when it answered: the clock hides a passed reset.
  const active = (status?.modelLimits ?? []).filter(
    (limit) => limit.active && limit.resetsAt * 1000 > nowMs,
  );
  if (active.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {active.map((limit) => (
        <Badge
          key={limit.window}
          variant="outline"
          className="h-5 gap-1.5 border-status-warning-strong/30 px-1.5 py-0 text-[11px] font-medium"
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-warning" />
          <span className="text-status-warning-strong">
            {modelName(limit.model)} limit, resets {resetLabel(limit.resetsAt * 1000)}
          </span>
        </Badge>
      ))}
    </span>
  );
}

function KeySubLine({ k }: { k: ProviderKey }) {
  if (k.health === "failing") {
    return (
      <span className="flex items-start gap-1 text-xs text-status-error-strong">
        <CircleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
        <span className="break-words">{k.reason ?? "The provider rejected it"}</span>
      </span>
    );
  }
  if (k.health === "limited") {
    return (
      <span className="flex items-center gap-1 text-xs text-status-warning-strong">
        <Timer aria-hidden className="size-3 shrink-0" />
        {k.rateLimitedUntil
          ? `Rate limited, back at ${backAt(k.rateLimitedUntil)}`
          : "Rate limited"}
      </span>
    );
  }
  if (k.health === "unchecked") {
    return <span className="text-xs text-muted-foreground">Not checked yet</span>;
  }
  return (
    <span className="text-xs text-muted-foreground">
      {k.lastUsedAt ? `Used ${formatRelativeTime(k.lastUsedAt)}` : "Not used yet"}
    </span>
  );
}

type KeyDialog = "rename" | "plan" | "clear" | "remove" | null;

/**
 * One key or ChatGPT account of an expanded provider row: its state, plan,
 * usage windows, the API value of today's and the week's runs, and a menu
 * with Rename, Set plan, Clear rate limit and Remove. Rename, plan and clear
 * need the key's status row, which the first check or run writes.
 */
export function PoolKeyRow({
  provider,
  poolKey: k,
  readOnly,
}: {
  provider: AiProvider;
  poolKey: ProviderKey;
  /** The pool comes from the deployment env: no Remove. */
  readOnly: boolean;
}) {
  const [dialog, setDialog] = useState<KeyDialog>(null);
  const [draftName, setDraftName] = useState("");
  const setName = useSetApiKeyName();
  const clearRateLimit = useClearApiKeyRateLimit();
  const removePoolKey = useRemovePoolKey(k.keyType);
  const removeAccount = useRemoveCodexAccount();
  const { data: plans } = useSubscriptionPlans();
  const nowMs = useMinuteClock();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const isCodex = k.keyType === "CODEX_OAUTH";
  const subscription = isSubscriptionKeyType(k.keyType);
  const status = k.status;
  const plan = planDisplay(k, plans?.plans);
  const windows = currentQuotaWindows(k.statuses, nowMs);
  const hasDetails = subscription || k.statuses.length > 0;
  const suffix = k.suffix ? `…${k.suffix}` : null;
  const removing = removePoolKey.isPending || removeAccount.isPending;

  function close() {
    setDialog(null);
  }

  function saveName() {
    if (!status) return;
    const trimmed = draftName.trim();
    setName.mutate(
      {
        keyType: status.keyType,
        keySuffix: status.keySuffix,
        scope: status.scope,
        scopeId: status.scopeId,
        name: trimmed.length > 0 ? trimmed : null,
      },
      { onError: (err) => toast.error(err instanceof Error ? err.message : String(err)) },
    );
    close();
  }

  function clear() {
    if (!status) return;
    clearRateLimit.mutate(
      {
        keyType: status.keyType,
        keySuffix: status.keySuffix,
        scope: status.scope,
        scopeId: status.scopeId,
      },
      {
        onSuccess: (result) => {
          toast.success(result.message || `Rate limit cleared for ${k.label}`);
          close();
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
      },
    );
  }

  function remove() {
    const onError = (err: Error) => toast.error(err.message);
    if (isCodex) {
      removeAccount.mutate(k.index, { onError });
    } else if (k.suffix) {
      removePoolKey.mutate({ index: k.index, suffix: k.suffix }, { onError });
    }
    close();
  }

  const canRemove = !readOnly && (isCodex || k.suffix !== null);
  const hasMenu = Boolean(status) || canRemove;

  return (
    <li>
      <div className={cn(PROVIDER_GRID, "flex items-start gap-3 px-4 py-2.5 md:py-2")}>
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <span
            role="img"
            aria-label={DOT_LABEL[k.health]}
            className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT[k.health])}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-sm font-medium">{k.label}</span>
              {suffix && k.label !== `Key ending ${k.suffix}` ? (
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{suffix}</span>
              ) : null}
            </span>
            <KeySubLine k={k} />
            <ModelLimitBadges status={status} nowMs={nowMs} />
            {/* Phone: the plan and today's amount, under the key. */}
            <span className="text-xs text-muted-foreground md:hidden">
              {subscription && plan.known
                ? `${plan.label}${plan.uncertain ? ` (${plan.note?.toLowerCase()})` : ""} · `
                : ""}
              today {formatCost(k.costToday, { placeholder: "$0" })}
            </span>
            {hasDetails ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-expanded={detailsOpen}
                aria-controls={detailsId}
                aria-label={`Limits and usage for ${k.label}`}
                onClick={() => setDetailsOpen((open) => !open)}
                className="w-fit text-muted-foreground"
              >
                <ChevronRight
                  aria-hidden
                  className={cn(
                    "size-3 transition-transform duration-150 ease-snappy",
                    detailsOpen && "rotate-90",
                  )}
                />
                Limits and usage
              </Button>
            ) : null}
          </div>
        </div>
        <div className="hidden min-w-0 flex-col md:col-span-2 md:flex">
          {subscription ? (
            <>
              <span
                className="truncate text-sm"
                title={plan.raw ? `Provider reports "${plan.raw}"` : undefined}
              >
                {plan.label}
              </span>
              {plan.note ? (
                <span className="text-xs text-muted-foreground">{plan.note}</span>
              ) : null}
            </>
          ) : (
            <span className="text-sm text-muted-foreground">Pay per token</span>
          )}
        </div>
        <div className="hidden min-w-0 flex-wrap gap-x-3 gap-y-1 md:flex">
          {windows.slice(0, ROW_METERS).map((w) => (
            <Meter key={w.key} window={w} nowMs={nowMs} />
          ))}
          {windows.length > ROW_METERS ? (
            <span className="self-center text-[11px] text-muted-foreground">
              +{windows.length - ROW_METERS} more
            </span>
          ) : null}
          {windows.length === 0 && subscription ? (
            <span className="text-[11px] text-muted-foreground">No current limit data</span>
          ) : null}
        </div>
        <span className="hidden text-right font-mono text-xs md:block">
          {formatCost(k.costToday, { placeholder: "$0" })}
        </span>
        <span className="hidden text-right font-mono text-xs md:block">
          {formatCost(k.cost7d, { placeholder: "$0" })}
        </span>
        <div className="flex justify-end">
          {hasMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Actions for ${k.label}`}
                  disabled={removing}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {status ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      setDraftName(k.name ?? "");
                      setDialog("rename");
                    }}
                  >
                    Rename
                  </DropdownMenuItem>
                ) : null}
                {status && subscription ? (
                  <DropdownMenuItem onSelect={() => setDialog("plan")}>Set plan</DropdownMenuItem>
                ) : null}
                {status?.status === "rate_limited" ? (
                  <DropdownMenuItem onSelect={() => setDialog("clear")}>
                    Clear rate limit
                  </DropdownMenuItem>
                ) : null}
                {canRemove ? (
                  <>
                    {status ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem variant="destructive" onSelect={() => setDialog("remove")}>
                      Remove
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      <AnimatedReveal open={detailsOpen}>
        <KeyQuotaDetails id={detailsId} poolKey={k} windows={windows} nowMs={nowMs} />
      </AnimatedReveal>

      <Dialog open={dialog === "rename"} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename {provider.noun}</DialogTitle>
            <DialogDescription>
              {provider.name}
              {suffix ? ` ${suffix}` : ""}. Leave it empty to clear the name.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            aria-label="Name"
            placeholder="For example team-max"
            value={draftName}
            maxLength={60}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                saveName();
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button onClick={saveName} disabled={setName.isPending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "plan"} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set plan</DialogTitle>
            <DialogDescription>
              The plan prices {k.label} on the Usage page. It applies at once.
            </DialogDescription>
          </DialogHeader>
          {status ? <PlanPicker credential={status} label={`Plan for ${k.label}`} /> : null}
          <DialogFooter>
            <Button onClick={close}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={dialog === "clear"}
        onOpenChange={(open) => !open && !clearRateLimit.isPending && close()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the rate limit of {k.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents can pick the {provider.noun} again at once. If the provider still limits it,
              the next run marks it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearRateLimit.isPending}>Cancel</AlertDialogCancel>
            <Button onClick={clear} disabled={clearRateLimit.isPending}>
              {clearRateLimit.isPending ? "Clearing…" : "Clear rate limit"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === "remove"} onOpenChange={(open) => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {k.label}
              {suffix && k.label !== `Key ending ${k.suffix}` ? ` (${suffix})` : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isCodex
                ? "Agents stop using this ChatGPT account. Sign in again to add it back."
                : `Agents stop using this ${provider.noun} within about 10 seconds.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              Remove {provider.noun}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

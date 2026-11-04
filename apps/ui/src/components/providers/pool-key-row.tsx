import { CircleAlert, MoreHorizontal, Timer } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  useClearApiKeyRateLimit,
  useSetApiKeyName,
  useSubscriptionPlans,
} from "@/api/hooks/use-api-keys";
import { useRemoveCodexAccount } from "@/api/hooks/use-codex-accounts";
import { useRemovePoolKey } from "@/api/hooks/use-pool-keys";
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
import { type AiProvider, backAt, type KeyHealth, type ProviderKey } from "@/lib/ai-providers";
import { formatCost } from "@/lib/cost-format";
import { cn, formatRelativeTime } from "@/lib/utils";

/**
 * The column grid of the LLMs list, from `md` up: provider (or key), type,
 * count, status (or usage limits), today, 7 days, the row action. A key row
 * spans its plan over type and count, so the amounts line up.
 */
export const PROVIDER_GRID =
  "md:grid md:grid-cols-[minmax(0,1.6fr)_6.5rem_6.5rem_minmax(0,1.4fr)_5rem_5rem_2rem] md:items-center md:gap-x-4";

const PLAN_SOURCE: Record<string, string> = {
  manual: "Set by you",
  detected: "Detected",
  estimated: "Estimated",
};

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

/** One usage window: "5 h", a short bar and the percent. 75% and up reads as a warning. */
function Meter({ label, value }: { label: string; value: number }) {
  const high = value >= 75;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {label}
      <span aria-hidden className="h-1 w-10 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full",
            high ? "bg-status-warning" : "bg-foreground/50",
          )}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </span>
      <span className={cn("w-8 font-mono", high && "text-status-warning-strong")}>{value}%</span>
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
  const isCodex = k.keyType === "CODEX_OAUTH";
  const subscription = isSubscriptionKeyType(k.keyType);
  const status = k.status;
  const planLabel = plans?.plans.find((p) => p.id === k.plan && p.keyType === k.keyType)?.label;
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
    <li className={cn(PROVIDER_GRID, "flex items-start gap-3 px-4 py-2.5 md:py-2")}>
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
          {/* Phone: the plan and today's amount, under the key. */}
          <span className="text-xs text-muted-foreground md:hidden">
            {subscription && planLabel ? `${planLabel} · ` : ""}today{" "}
            {formatCost(k.costToday, { placeholder: "$0" })}
          </span>
        </div>
      </div>
      <div className="hidden min-w-0 flex-col md:col-span-2 md:flex">
        {subscription ? (
          <>
            <span className="truncate text-sm">{planLabel ?? "No plan set"}</span>
            {planLabel && k.planSource ? (
              <span className="text-xs text-muted-foreground">{PLAN_SOURCE[k.planSource]}</span>
            ) : null}
          </>
        ) : (
          <span className="text-sm text-muted-foreground">Pay per token</span>
        )}
      </div>
      <div className="hidden flex-wrap gap-x-3 gap-y-1 md:flex">
        {k.window5h !== null ? <Meter label="5 h" value={k.window5h} /> : null}
        {k.window7d !== null ? <Meter label="7 d" value={k.window7d} /> : null}
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

import { toast } from "sonner";
import { useSetApiKeyPlan, useSubscriptionPlans } from "@/api/hooks/use-api-keys";
import { StatusIcon } from "@/components/shared/status-icon";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Credential types billed as a flat subscription. Mirrors `SUBSCRIPTION_KEY_TYPES` on the server. */
const SUBSCRIPTION_KEY_TYPES = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_OAUTH"]);

export function isSubscriptionKeyType(keyType: string | null): boolean {
  return keyType !== null && SUBSCRIPTION_KEY_TYPES.has(keyType);
}

export type PlanSource = "manual" | "detected" | "estimated";

/** The fields the picker reads. Usage rows and API key rows both have them. */
export interface PlanPickerCredential {
  keyType: string | null;
  keySuffix: string | null;
  plan: string | null;
  planSource: PlanSource | null;
}

const PLAN_SOURCES: Record<PlanSource, { label: string; hint: string }> = {
  detected: { label: "Detected", hint: "Read from the credential." },
  manual: { label: "Set by you", hint: "Picked by an operator." },
  estimated: {
    label: "Estimated",
    hint: "Estimated from rate-limit usage. Pick a plan to fix it.",
  },
};

/** Select value for "remove my choice" (the API takes `plan: null`). */
const USE_DETECTED = "__detected__";

/**
 * Pick the subscription plan of a pooled credential, with a badge that says
 * where the current plan comes from. A credential with no plan shows "Pick a
 * plan" in the accent color. A plan set by hand can be reset, so the detected
 * or estimated plan applies again.
 */
export function PlanPicker({
  credential,
  label,
  compact = false,
  className,
}: {
  credential: PlanPickerCredential;
  /** Accessible name of the trigger, for example "Plan for Claude ...c3d4". */
  label: string;
  /** One line at grid-row height (the API Keys table). */
  compact?: boolean;
  className?: string;
}) {
  const { data: catalog } = useSubscriptionPlans();
  const setPlan = useSetApiKeyPlan();
  const { keyType, keySuffix, planSource } = credential;
  const options = catalog?.plans.filter((p) => p.keyType === keyType) ?? [];
  const plan = options.find((p) => p.id === credential.plan) ?? null;
  const source = plan && planSource ? PLAN_SOURCES[planSource] : null;
  const canPick = Boolean(keyType && keySuffix && options.length > 0);

  function onValueChange(value: string) {
    if (!keyType || !keySuffix) return;
    setPlan.mutate(
      { keyType, keySuffix, plan: value === USE_DETECTED ? null : value },
      { onError: (err) => toast.error(err instanceof Error ? err.message : String(err)) },
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2",
        compact ? "h-full flex-nowrap" : "flex-wrap",
        className,
      )}
    >
      <Select
        value={plan?.id ?? ""}
        onValueChange={onValueChange}
        disabled={!canPick || setPlan.isPending}
      >
        <SelectTrigger
          size="sm"
          aria-label={label}
          className={cn(
            compact ? "h-7 min-w-[8.5rem] max-w-[13rem] px-2 text-xs" : "w-full max-w-[17rem]",
            !plan && "border-primary/60 data-[placeholder]:text-primary",
          )}
        >
          {/* The trigger shows the plan name only. The list adds the monthly price. */}
          <SelectValue placeholder="Pick a plan">{plan?.label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
              <span className="text-muted-foreground">${option.monthlyUsd}/mo</span>
            </SelectItem>
          ))}
          {planSource === "manual" ? (
            <>
              <SelectSeparator />
              <SelectItem value={USE_DETECTED}>Use detected plan</SelectItem>
            </>
          ) : null}
        </SelectContent>
      </Select>
      {setPlan.isPending ? (
        <StatusIcon tone="busy" label="Saving plan" />
      ) : source ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {source.label}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{source.hint}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

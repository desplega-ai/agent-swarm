import { ChevronRight, Plus } from "lucide-react";
import { useId } from "react";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { KeyStatusPill, type KeyStatusTone } from "@/components/shared/key-status-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { countLabel, healthLabel, type KeyHealth, type ProviderRow } from "@/lib/ai-providers";
import { formatCost } from "@/lib/cost-format";
import { cn } from "@/lib/utils";
import { PoolKeyRow, PROVIDER_GRID } from "./pool-key-row";
import { ProviderLogo } from "./provider-logo";

const TONE: Record<KeyHealth, KeyStatusTone> = {
  ok: "success",
  unchecked: "neutral",
  limited: "warning",
  failing: "error",
};

const REASON_TONE: Record<KeyHealth, string> = {
  ok: "text-muted-foreground",
  unchecked: "text-muted-foreground",
  limited: "text-status-warning-strong",
  failing: "text-status-error-strong",
};

function rotateNote(row: ProviderRow): string {
  const { provider, keys, readOnly } = row;
  if (readOnly) return "These keys come from the deployment env. Change them there.";
  if (keys.length < 2) return "Add another to let agents rotate across them.";
  return `Agents rotate across the ${countLabel(keys.length, provider.noun)} and skip one while it is limited.`;
}

/**
 * One configured provider: logo, name, the harnesses that use it, the type
 * tag, how many keys, the rolled-up status (worst key wins, with the reason
 * under the chip), and the API value of today's and the week's runs. A click
 * expands the keys. A provider set up with plain config fields has no keys:
 * its click opens the setup panel.
 */
export function ProviderListRow({
  row,
  open,
  onToggle,
  onAdd,
}: {
  row: ProviderRow;
  open: boolean;
  onToggle: () => void;
  /** Opens the side panel to add one more key or account. */
  onAdd: () => void;
}) {
  const { provider, keys, health } = row;
  const regionId = useId();
  const configOnly = row.configOnly === true;
  const count = configOnly ? "Config" : countLabel(keys.length, provider.noun);
  const addLabel = provider.id === "codex" ? "Sign in another account" : `Add ${provider.noun}`;

  return (
    <li className="border-b border-border-subtle last:border-b-0">
      <button
        type="button"
        aria-expanded={configOnly ? undefined : open}
        aria-controls={configOnly ? undefined : regionId}
        aria-haspopup={configOnly ? "dialog" : undefined}
        onClick={configOnly ? onAdd : onToggle}
        className={cn(
          PROVIDER_GRID,
          "flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring",
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <ProviderLogo provider={provider} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{provider.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              <span className="hidden md:inline">{provider.harnesses.join(", ")}</span>
              <span className="md:hidden">
                {count} · {formatCost(row.costToday, { placeholder: "$0" })} today
              </span>
            </span>
          </span>
        </span>
        <span className="hidden md:block">
          <Badge variant="outline" size="tag">
            {provider.type}
          </Badge>
        </span>
        <span className="hidden text-sm md:block">{count}</span>
        <span className="flex min-w-0 shrink-0 flex-col items-end gap-1 md:items-start">
          <KeyStatusPill tone={TONE[health]}>
            {configOnly ? "Set up" : healthLabel(row)}
          </KeyStatusPill>
          {row.reason ? (
            <span
              className={cn("hidden max-w-full truncate text-xs md:block", REASON_TONE[health])}
              title={row.reason}
            >
              {row.reason}
            </span>
          ) : null}
        </span>
        <span className="hidden text-right font-mono text-xs md:block">
          {formatCost(row.costToday, { placeholder: "$0" })}
        </span>
        <span className="hidden text-right font-mono text-xs md:block">
          {formatCost(row.cost7d, { placeholder: "$0" })}
        </span>
        <span className="flex justify-end text-muted-foreground">
          <ChevronRight
            aria-hidden
            className={cn(
              "size-4 transition-transform duration-150 ease-snappy",
              open && !configOnly && "rotate-90",
            )}
          />
        </span>
      </button>
      {/* Phone: the failure reason stays visible under the collapsed row. */}
      {row.reason ? (
        <p className={cn("-mt-2 px-4 pb-3 pl-15 text-xs md:hidden", REASON_TONE[health])}>
          {row.reason}
        </p>
      ) : null}
      <AnimatedReveal open={open && !configOnly}>
        <section
          id={regionId}
          aria-label={`${provider.name} ${provider.noun}s`}
          className="border-t border-border-subtle bg-muted/20"
        >
          <div
            aria-hidden
            className={cn(
              PROVIDER_GRID,
              "hidden px-4 pt-2 pb-1 text-[11px] font-medium text-muted-foreground",
            )}
          >
            <span className="pl-4">{provider.noun === "account" ? "Account" : "Key"}</span>
            <span className="md:col-span-2">
              {provider.group === "subscription" ? "Plan" : "Billing"}
            </span>
            <span>{keys.some((k) => k.window5h !== null) ? "Usage limits" : ""}</span>
            <span />
            <span />
            <span />
          </div>
          <ul className="divide-y divide-border-subtle">
            {keys.map((k) => (
              <PoolKeyRow key={k.id} provider={provider} poolKey={k} readOnly={row.readOnly} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border-subtle px-4 py-2.5">
            {row.readOnly ? null : (
              <Button type="button" variant="outline" size="sm" onClick={onAdd}>
                <Plus />
                {addLabel}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">{rotateNote(row)}</p>
          </div>
        </section>
      </AnimatedReveal>
    </li>
  );
}

import { CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";
import { AlertCallout } from "@/components/ui/alert-callout";
import type { CardRollup } from "./model";

/**
 * Amber spinner + shimmer text. Only for real waits: a worker checking a key,
 * or the user approving a device code. Both degrade to static under reduced motion.
 * Phrasing content only, so it can sit inside an `<output>` live region.
 */
export function WaitingLine({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-sm">
      <span
        aria-hidden
        className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-primary/25 border-t-primary motion-reduce:animate-none"
      />
      <span className="shimmer-text font-medium">{children}</span>
    </span>
  );
}

/** Shown in a card once its key is saved: waits for a worker, then confirms. */
export function WaitingPanel({
  rollup,
  harnessLabel,
}: {
  rollup: CardRollup;
  harnessLabel: string;
}) {
  if (rollup.verified) {
    const n = rollup.verifiedWorkers;
    return (
      <AlertCallout tone="success" icon={CheckCircle2}>
        Verified by {n} agent{n === 1 ? "" : "s"}.
      </AlertCallout>
    );
  }
  return (
    <output className="block space-y-1 rounded-lg border border-border bg-surface px-3 py-2.5">
      <WaitingLine>Saved. Waiting for a worker to check this key.</WaitingLine>
      <span className="block text-xs text-muted-foreground">
        Workers re-check new keys within about 30 seconds.
      </span>
      <span className="block font-mono text-[11px] tabular-nums text-muted-foreground">
        {rollup.workers > 0
          ? `${rollup.verifiedWorkers} of ${rollup.workers} ${harnessLabel} agents verified`
          : `No ${harnessLabel} agents yet.`}
      </span>
    </output>
  );
}

import type { ReactNode } from "react";
import { Spinner, StatusLine } from "@/components/onboarding/save-indicator";
import { InfoTip } from "@/components/ui/info-tip";
import type { CardRollup } from "./model";

/**
 * Amber spinner + shimmer text. Only for real waits: a worker checking a key,
 * or the user approving a device code. Both degrade to static under reduced motion.
 * Phrasing content only, so it can sit inside an `<output>` live region.
 */
export function WaitingLine({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-sm">
      <Spinner />
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
      <StatusLine tone="done">
        Verified by {n} agent{n === 1 ? "" : "s"}
      </StatusLine>
    );
  }
  return (
    <output className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <WaitingLine>Waiting for a worker to check this key</WaitingLine>
      <InfoTip content="Workers re-check new keys within about 30 seconds." />
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {rollup.workers > 0
          ? `${rollup.verifiedWorkers}/${rollup.workers} ${harnessLabel} agents`
          : `No ${harnessLabel} agents yet`}
      </span>
    </output>
  );
}

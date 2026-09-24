import { StatusLine } from "@/components/onboarding/save-indicator";
import { InfoTip } from "@/components/ui/info-tip";
import type { CardRollup } from "./model";

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
      <StatusLine tone="busy">Waiting for a worker to check this key</StatusLine>
      <InfoTip content="Workers re-check new keys within about 30 seconds." />
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {rollup.workers > 0
          ? `${rollup.verifiedWorkers}/${rollup.workers} ${harnessLabel} agents`
          : `No ${harnessLabel} agents yet`}
      </span>
    </output>
  );
}

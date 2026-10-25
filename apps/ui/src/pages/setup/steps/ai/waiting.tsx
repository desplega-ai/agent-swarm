import { StatusLine } from "@/components/shared/status-icon";
import { InfoTip } from "@/components/ui/info-tip";
import { type CardRollup, rejectionText } from "./model";

/** Workers test a changed key on their next config reload. */
const RECHECK_TIP = "Agents check a changed key again within about 10 seconds.";

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
      <div className="space-y-1">
        <StatusLine tone="done">
          Verified by {n} agent{n === 1 ? "" : "s"}
        </StatusLine>
        {rollup.warning ? (
          <StatusLine tone="warning">{rollup.warning} Agents skip a rejected key.</StatusLine>
        ) : null}
      </div>
    );
  }
  if (rollup.error) {
    return (
      <output className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusLine tone="error">{rejectionText(rollup.error)}</StatusLine>
        <InfoTip content={`Fix the key and save it. ${RECHECK_TIP}`} />
      </output>
    );
  }
  return (
    <output className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusLine tone="busy">Waiting for a worker to check this key</StatusLine>
      <InfoTip content={RECHECK_TIP} />
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {rollup.workers > 0
          ? `${rollup.verifiedWorkers}/${rollup.workers} ${harnessLabel} agents`
          : `No ${harnessLabel} agents yet`}
      </span>
    </output>
  );
}

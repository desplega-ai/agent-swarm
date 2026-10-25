import { StatusLine } from "@/components/shared/status-icon";
import { InfoTip } from "@/components/ui/info-tip";
import { type CardRollup, rejectionText } from "./model";

/**
 * A worker that waits for its first key re-reads config every 10 s at most. A
 * running worker re-reads it when its idle poll returns, up to a minute later.
 */
const NEW_KEY_TIP = "Agents check a new key within about 10 seconds.";
const CHANGED_KEY_TIP = "Running agents check a changed key within about a minute.";

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
          <StatusLine tone="warning">
            {rollup.warning} Agents skip a key the provider rejects with HTTP 401.
          </StatusLine>
        ) : null}
      </div>
    );
  }
  if (rollup.error) {
    return (
      <output className="block space-y-1">
        <StatusLine tone="error">{rejectionText(rollup.error)}</StatusLine>
        <p className="text-xs text-muted-foreground">Fix the key and save it. {CHANGED_KEY_TIP}</p>
      </output>
    );
  }
  return (
    <output className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusLine tone="busy">Waiting for a worker to check this key</StatusLine>
      <InfoTip content={`${NEW_KEY_TIP} ${CHANGED_KEY_TIP}`} />
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {rollup.workers > 0
          ? `${rollup.verifiedWorkers}/${rollup.workers} ${harnessLabel} agents`
          : `No ${harnessLabel} agents yet`}
      </span>
    </output>
  );
}

import type { ReactNode } from "react";
import { SetupCard, SetupChip } from "../../components/setup-card";
import { HarnessSwitch } from "./harness-switch";
import { type AiCardId, type AiCardProps, CARD_HARNESSES, HARNESS_NAME } from "./model";
import { WaitingPanel } from "./waiting";

/** "Codex" for one harness, "opencode, pi, or DeepSeek (dsh)" for several. */
function harnessPhrase(card: AiCardId): string {
  const names = CARD_HARNESSES[card].map((h) => HARNESS_NAME[h] ?? h);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

/**
 * Accordion card shared by the four providers: status chip, the card's form,
 * then the waiting panel once a key is saved, then the R2 harness switch when
 * no worker runs the card's harness.
 */
export function ProviderCard({
  card,
  icon,
  title,
  subtitle,
  saved,
  open,
  onOpenChange,
  rollup,
  agents,
  children,
}: Pick<AiCardProps, "open" | "onOpenChange" | "rollup" | "agents"> & {
  card: AiCardId;
  icon: ReactNode;
  title: string;
  subtitle: string;
  saved: boolean;
  children: ReactNode;
}) {
  const harnesses = CARD_HARNESSES[card];
  const runsHarness =
    rollup.workers > 0 ||
    agents.some((a) => a.harnessProvider != null && harnesses.includes(a.harnessProvider));
  // The waiting panel names the harness that actually has workers, when only one does.
  const withWorkers = harnesses.filter((h) =>
    agents.some((a) => (a.harnessProvider as string | null | undefined) === h),
  );
  const waitingLabel =
    harnesses.length === 1
      ? (HARNESS_NAME[harnesses[0]] ?? harnesses[0])
      : withWorkers.length === 1
        ? (HARNESS_NAME[withWorkers[0]] ?? withWorkers[0])
        : "open harness";

  const chip = rollup.verified ? (
    <SetupChip tone="success">Verified</SetupChip>
  ) : saved ? (
    <SetupChip tone="pending">Waiting for a worker</SetupChip>
  ) : (
    <SetupChip>Not set up</SetupChip>
  );

  return (
    <SetupCard
      icon={icon}
      title={title}
      description={
        <>
          {subtitle}
          {rollup.verified ? (
            <span className="block tabular-nums text-status-success-strong">
              {Math.max(rollup.verifiedWorkers, 1)}/{Math.max(rollup.workers, 1)} workers verified
            </span>
          ) : null}
        </>
      }
      status={chip}
      collapsible={{ open, onOpenChange }}
      active={open}
      bodyClassName="space-y-3 sm:pl-[60px]"
    >
      {children}
      {saved || rollup.verified ? (
        <WaitingPanel rollup={rollup} harnessLabel={waitingLabel} />
      ) : null}
      {!runsHarness && agents.length > 0 ? (
        <HarnessSwitch harnessPhrase={harnessPhrase(card)} targets={harnesses} agents={agents} />
      ) : null}
    </SetupCard>
  );
}

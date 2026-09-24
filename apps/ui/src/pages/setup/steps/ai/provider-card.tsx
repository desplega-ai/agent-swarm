import type { ReactNode } from "react";
import { StatusIcon } from "@/components/onboarding/save-indicator";
import { SetupCard } from "@/components/onboarding/setup-card";
import { HARNESS_LABEL } from "@/lib/agent-runtime-models";
import { HarnessSwitch } from "./harness-switch";
import { type AiCardId, type AiCardProps, CARD_HARNESSES } from "./model";
import { WaitingPanel } from "./waiting";

/** "Codex" for one harness, "Pi-Mono, Opencode, or DeepSeek (dsh)" for several. */
function harnessPhrase(card: AiCardId): string {
  const names = CARD_HARNESSES[card].map((h) => HARNESS_LABEL[h] ?? h);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

/**
 * Accordion card shared by the four providers: status icon, the card's form,
 * then the waiting line once a key is saved, then (also once a key is saved)
 * the R2 harness switch when no worker runs the card's harness.
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
      ? (HARNESS_LABEL[harnesses[0]] ?? harnesses[0])
      : withWorkers.length === 1
        ? (HARNESS_LABEL[withWorkers[0]] ?? withWorkers[0])
        : "open harness";

  const noWorker = !runsHarness && agents.length > 0;
  const status = rollup.verified ? (
    <StatusIcon
      tone="done"
      label={`Verified by ${rollup.verifiedWorkers} of ${rollup.workers} agents`}
    />
  ) : saved && noWorker ? (
    <StatusIcon tone="warning" label={`Saved. No worker runs ${harnessPhrase(card)} yet.`} />
  ) : saved ? (
    <StatusIcon tone="busy" label="Saved. Waiting for a worker to check this key." />
  ) : (
    <StatusIcon tone="none" />
  );

  return (
    <SetupCard
      icon={icon}
      title={title}
      description={subtitle}
      status={status}
      collapsible={{ open, onOpenChange }}
      active={open}
      bodyClassName="space-y-3 sm:pl-[60px]"
    >
      {children}
      {saved || rollup.verified ? (
        <WaitingPanel rollup={rollup} harnessLabel={waitingLabel} />
      ) : null}
      {/* Offer the switch once there is a key a worker could check. */}
      {saved && noWorker ? (
        <HarnessSwitch harnessPhrase={harnessPhrase(card)} targets={harnesses} agents={agents} />
      ) : null}
    </SetupCard>
  );
}

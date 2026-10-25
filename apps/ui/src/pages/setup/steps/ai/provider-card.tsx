import type { ReactNode } from "react";
import { SetupCard } from "@/components/shared/setup-card";
import { StatusIcon } from "@/components/shared/status-icon";
import { HARNESS_LABEL } from "@/lib/agent-runtime-models";
import { HarnessSwitch } from "./harness-switch";
import { type AiCardId, type AiCardProps, CARD_HARNESSES, harnessNames } from "./model";
import { WaitingPanel } from "./waiting";

/**
 * Accordion card shared by the four providers: status icon, the card's form,
 * then the waiting line once a key is saved, then the R2 harness switch once
 * a key is saved and no worker runs the card's harness.
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
  dialContext,
  children,
}: Pick<AiCardProps, "open" | "onOpenChange" | "rollup" | "agents" | "dialContext"> & {
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
  // The header is a button: its status icon must not take focus of its own.
  const status = rollup.verified ? (
    <StatusIcon
      tone="done"
      focusable={false}
      label={`Verified by ${rollup.verifiedWorkers} of ${rollup.workers} agents`}
    />
  ) : rollup.error ? (
    <StatusIcon tone="error" focusable={false} label="Key rejected. Fix it and save it again." />
  ) : saved && noWorker ? (
    <StatusIcon
      tone="warning"
      focusable={false}
      label={`Saved. No worker runs ${harnessNames(card)} yet.`}
    />
  ) : saved ? (
    <StatusIcon
      tone="busy"
      focusable={false}
      label="Saved. Waiting for a worker to check this key."
    />
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
      {saved || rollup.verified || rollup.error ? (
        <WaitingPanel rollup={rollup} harnessLabel={waitingLabel} />
      ) : null}
      {/* A key only verifies on a worker that runs this harness. Before a key
          is saved, the agent list would only push the form down. */}
      {saved && noWorker ? (
        <HarnessSwitch
          harnessPhrase={harnessNames(card)}
          targets={harnesses}
          agents={agents}
          dialContext={dialContext}
        />
      ) : null}
    </SetupCard>
  );
}

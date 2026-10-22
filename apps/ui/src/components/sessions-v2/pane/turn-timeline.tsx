import { MessageSquarePlus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { useAgents } from "@/api/hooks/use-agents";
import type { AgentTask, SessionApproval } from "@/api/types";
import { ChainOfThought } from "@/components/sessions/chain-of-thought";
import { TaskCard } from "@/components/sessions/task-card";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { EmptyState } from "@/components/shared/empty-state";
import { UserAvatar } from "@/components/shared/user-avatar";
import { agentName } from "@/lib/agent-name";
import type { SessionViewer } from "@/lib/session-presence";
import {
  approvalsByPart,
  buildTurns,
  partSteps,
  type TurnPart,
  type WorkerSummary,
  workerSummary,
} from "@/lib/session-turns";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { ApprovalLine } from "./approval-line";
import { InternalLine } from "./internal-line";
import { PersonBubble } from "./person-bubble";
import { SwarmReply } from "./swarm-reply";
import { useStepBlocks } from "./use-step-blocks";
import { WorkerStep } from "./worker-step";
import { WorkerSummaryLine } from "./worker-summary";

/** Re-renders every 30 s while `ticking`, so a running time keeps counting between polls. */
function useClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [ticking]);
  return ticking ? now : Date.now();
}

/** A step block opens and closes in 150/120 ms (`AnimatedReveal` fast). */
const REVEAL_MS = 200;

/**
 * The session timeline in turns (SPEC R8 to R10, mockup sB1): each person's
 * message, then its parts (a deferred wake-up starts a new part). A part
 * shows the swarm's reply, a folded line for its workers, the swarm's latest
 * answer, and a live line while the lead works. Handoffs On shows the
 * internal rows. Tasks that fit no turn render as plain task cards at the
 * end. A typing person shows as a bubble row in the flow, so it never covers
 * a message.
 */
export function TurnTimeline({
  rootTaskId,
  chain,
  approvals,
  showHandoffs,
  typing,
  onLayoutChange,
}: {
  rootTaskId: string;
  chain: AgentTask[];
  /** Pending approvals in the chain (`approvals` on the session detail). */
  approvals: SessionApproval[];
  showHandoffs: boolean;
  /** The other people typing in the composer now. */
  typing: SessionViewer[];
  /** Called after a person opens or closes a step block: the bottom edge moved. */
  onLayoutChange?: () => void;
}) {
  const { turns, rest } = useMemo(() => buildTurns(chain), [chain]);
  const placed = useMemo(() => approvalsByPart(turns, approvals), [turns, approvals]);
  const { data: agents } = useAgents();
  const nameOf = (agentId: string | null) => agentName(agents, agentId);
  const blocks = useStepBlocks(rootTaskId, showHandoffs);
  const idPrefix = useId();
  // Open work ("is working · 3m", "is queued · 3m") counts up between polls.
  const openWork = turns.some((turn) =>
    turn.parts.some((part) =>
      partSteps(part).some(
        (step) => !TERMINAL_STATUSES.has(step.tries[step.tries.length - 1].status),
      ),
    ),
  );
  const now = useClock(openWork);
  const rootSource = turns[0]?.parts[0]?.reply.source ?? "ui";
  const toggle = (partId: string) => {
    blocks.toggle(partId);
    if (onLayoutChange) window.setTimeout(onLayoutChange, REVEAL_MS);
  };

  if (turns.length === 0 && rest.length === 0) {
    return (
      <EmptyState
        icon={MessageSquarePlus}
        title="No messages yet"
        description="Start typing below to send the first message in this session."
      />
    );
  }

  return (
    <div className="@container/turns mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6">
      {turns.map((turn) => (
        <Fragment key={turn.id}>
          {turn.person ? <PersonBubble task={turn.person} rootSource={rootSource} /> : null}
          {turn.parts.map((part, index) => (
            <PartView
              key={part.id}
              part={part}
              // A root no person wrote (a schedule, a workflow) keeps the task card, so its prompt shows.
              card={index === 0 && !turn.person}
              summary={workerSummary(part, now)}
              approvals={placed.get(part.id) ?? []}
              showHandoffs={showHandoffs}
              open={blocks.isOpen(part.id)}
              onToggle={() => toggle(part.id)}
              stepsId={`${idPrefix}-steps-${part.id}`}
              nameOf={nameOf}
            />
          ))}
        </Fragment>
      ))}
      {placed.get(null)?.map((approval) => (
        <ApprovalLine key={approval.id} approval={approval} />
      ))}
      {rest.length > 0 ? (
        <section aria-label="Other tasks" className="flex min-w-0 flex-col">
          {rest.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </section>
      ) : null}
      <TypingRow typing={typing} />
    </div>
  );
}

function PartView({
  part,
  card,
  summary,
  approvals,
  showHandoffs,
  open,
  onToggle,
  stepsId,
  nameOf,
}: {
  part: TurnPart;
  card: boolean;
  summary: WorkerSummary | null;
  approvals: SessionApproval[];
  showHandoffs: boolean;
  open: boolean;
  onToggle: () => void;
  stepsId: string;
  nameOf: (agentId: string | null) => string;
}) {
  const internal = showHandoffs ? part.internal : [];
  // Steps and handoffs in one column, oldest first.
  const rows = [
    ...partSteps(part).map((step) => ({ at: step.tries[0].createdAt, step, task: null })),
    ...internal.map((task) => ({ at: task.createdAt, step: null, task })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const block = (
    <div className="mt-1 flex min-w-0 flex-col border-l-2 border-border-subtle pl-3">
      {rows.map((row) =>
        row.step ? (
          <WorkerStep
            key={row.step.tries[0].id}
            step={row.step}
            agentName={nameOf(row.step.agentId)}
          />
        ) : row.task ? (
          <InternalLine key={row.task.id} task={row.task} />
        ) : null,
      )}
    </div>
  );
  return (
    <div data-slot="swarm-turn" className="flex min-w-0 flex-col gap-2">
      {card ? <TaskCard task={part.reply} className="pb-0" /> : <SwarmReply task={part.reply} />}
      {summary ? (
        <div className="flex min-w-0 flex-col">
          <WorkerSummaryLine
            summary={summary}
            nameOf={nameOf}
            open={open}
            onToggle={onToggle}
            controls={stepsId}
          />
          <div id={stepsId}>
            <AnimatedReveal open={open} speed="fast">
              {block}
            </AnimatedReveal>
          </div>
        </div>
      ) : rows.length > 0 ? (
        block
      ) : null}
      {part.result ? (
        <div className={summary || rows.length > 0 ? "mt-3" : undefined}>
          <SwarmReply task={part.result} />
        </div>
      ) : null}
      {/* The lead works again: a live line under the latest answer, never in its place. */}
      {part.live ? <ChainOfThought taskId={part.live.id} status={part.live.status} /> : null}
      {approvals.map((approval) => (
        <ApprovalLine key={approval.id} approval={approval} />
      ))}
    </div>
  );
}

/**
 * "Lena is typing" as a bubble row in the flow (SPEC R10.4): her avatar and
 * three dots in a bubble shaped like other people's. The words go to the
 * live region next to the composer.
 */
function TypingRow({ typing }: { typing: SessionViewer[] }) {
  const first = typing[0];
  return (
    // SPEC R10.4 asks for this 150/100 ms fade on presence data: the one
    // exception to "never animate poll-driven changes".
    <AnimatePresence initial={false}>
      {first ? (
        <motion.div
          key="typing"
          data-slot="typing-row"
          aria-hidden
          className="flex items-start gap-2.5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.15, ease: [0.2, 0, 0, 1] } }}
          exit={{ opacity: 0, transition: { duration: 0.1, ease: [0.2, 0, 0, 1] } }}
        >
          <UserAvatar id={first.id} name={first.name} className="mt-2" />
          <div className="flex h-10 items-center gap-1 rounded-2xl rounded-tl-sm border border-border bg-card px-3.5 text-muted-foreground">
            {[0, 200, 400].map((delay) => (
              <span
                key={delay}
                className="size-1.5 rounded-full bg-current opacity-60 motion-safe:animate-pulse"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

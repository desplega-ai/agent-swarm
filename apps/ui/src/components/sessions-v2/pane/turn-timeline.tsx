import { ChevronUp, MessageSquarePlus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAgents } from "@/api/hooks/use-agents";
import type { AgentTask, SessionApproval } from "@/api/types";
import { TaskCard } from "@/components/sessions/task-card";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { EmptyState } from "@/components/shared/empty-state";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import { agentName } from "@/lib/agent-name";
import { CHAT_COLUMN } from "@/lib/chat-width";
import type { SessionViewer } from "@/lib/session-presence";
import {
  approvalsByPart,
  buildTurns,
  foldWaits,
  isDeferral,
  keepSeenApprovals,
  onlyWaits,
  partSteps,
  type TurnPart,
  type WorkerSummary,
  workerSummary,
} from "@/lib/session-turns";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { cn } from "@/lib/utils";
import { ApprovalLine } from "./approval-line";
import { DeferralGroup, DeferralLine } from "./deferral-line";
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
 * Tasks rendered at first, and added per "Show earlier" click. A long-running
 * case holds hundreds of tasks; the newest turns are what a person opens it
 * for. A turn always renders whole, and at least `MIN_TURNS` show.
 */
export const TASK_BUDGET = 60;
export const MIN_TURNS = 3;

/** The nearest ancestor that scrolls vertically. */
function scrollParent(el: Element): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/** The first turn to render: the newest turns that fit `budget` tasks. */
export function windowStart<T>(turns: T[], weight: (turn: T) => number, budget: number): number {
  let used = 0;
  let start = turns.length;
  while (start > 0) {
    const next = used + weight(turns[start - 1]);
    if (next > budget && turns.length - start >= MIN_TURNS) break;
    used = next;
    start -= 1;
  }
  return start;
}

/**
 * The newest turns within the task budget, plus a `showEarlier` that adds a
 * budget above and keeps the turn the person was looking at in place.
 * Resets per session.
 */
function useTurnWindow<T>(rootTaskId: string, turns: T[], weight: (turn: T) => number) {
  const [shown, setShown] = useState({ rootTaskId, pages: 1 });
  const pages = shown.rootTaskId === rootTaskId ? shown.pages : 1;
  const hidden = windowStart(turns, weight, TASK_BUDGET * pages);
  const anchor = useRef<{ el: Element; top: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after the earlier turns render.
  useLayoutEffect(() => {
    const kept = anchor.current;
    if (!kept) return;
    anchor.current = null;
    const scroller = scrollParent(kept.el);
    if (scroller) scroller.scrollTop += kept.el.getBoundingClientRect().top - kept.top;
  }, [pages]);

  const showEarlier = (firstShown: Element | null) => {
    if (firstShown)
      anchor.current = { el: firstShown, top: firstShown.getBoundingClientRect().top };
    setShown({ rootTaskId, pages: pages + 1 });
  };
  return { visible: hidden > 0 ? turns.slice(hidden) : turns, hidden, showEarlier };
}

/** Tasks a turn renders: its person message, and each part's reply and steps. */
function turnWeight(turn: { person?: unknown; parts: TurnPart[] }): number {
  return (
    (turn.person ? 1 : 0) +
    turn.parts.reduce((sum, part) => sum + 1 + partSteps(part).length + part.internal.length, 0)
  );
}

/**
 * The session timeline in turns (SPEC R8 to R10, mockup sB1): each person's
 * message, then its parts (a deferred wake-up starts a new part). A part
 * shows the swarm's reply, a row per worker step (two or more fold into a
 * group under one head), the swarm's latest answer, and a live line while the
 * lead works. A reply that only waits (a deferral) is one muted line, and
 * waiting parts in a row fold into one. Handoffs On shows the internal rows. Tasks that fit no turn
 * render as plain task cards at the end. A typing person shows as a bubble
 * row in the flow, so it never covers a message.
 */
export function TurnTimeline({
  rootTaskId,
  chain,
  approvals,
  showHandoffs,
  typing,
  onLayoutChange,
  requestText,
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
  /**
   * The person's words in a task whose prompt wraps them (a json-render app
   * page's action prompt), or null for any other task. A task it names opens
   * a turn, and its bubble shows only those words. Pass a stable function.
   * Omitted: turns follow the task sources and show `task.task`.
   */
  requestText?: (task: AgentTask) => string | null;
}) {
  const { turns, rest } = useMemo(
    () => buildTurns(chain, { personText: requestText }),
    [chain, requestText],
  );
  const seen = useRef<{ rootTaskId: string; approvals: SessionApproval[] }>({
    rootTaskId,
    approvals: [],
  });
  const placed = useMemo(() => {
    const before = seen.current.rootTaskId === rootTaskId ? seen.current.approvals : [];
    const shown = keepSeenApprovals(before, approvals);
    seen.current = { rootTaskId, approvals: shown };
    return approvalsByPart(turns, shown);
  }, [rootTaskId, turns, approvals]);
  const pendingIds = useMemo(() => new Set(approvals.map((approval) => approval.id)), [approvals]);
  const { visible, hidden, showEarlier } = useTurnWindow(rootTaskId, turns, turnWeight);
  const earlierRef = useRef<HTMLDivElement>(null);
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
  const relayout = () => {
    if (onLayoutChange) window.setTimeout(onLayoutChange, REVEAL_MS);
  };
  const toggle = (partId: string) => {
    blocks.toggle(partId);
    relayout();
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
    <div className={cn("@container/turns flex min-w-0 flex-col gap-6", CHAT_COLUMN)}>
      {hidden > 0 ? (
        <div ref={earlierRef} className="flex justify-center">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-xs text-muted-foreground"
            onClick={() => showEarlier(earlierRef.current?.nextElementSibling ?? null)}
          >
            <ChevronUp className="h-3.5 w-3.5" />
            Show earlier messages ({hidden})
          </Button>
        </div>
      ) : null}
      {visible.map((turn) => (
        <Fragment key={turn.id}>
          {turn.person ? (
            <PersonBubble
              task={turn.person}
              rootSource={rootSource}
              text={requestText?.(turn.person) ?? undefined}
            />
          ) : null}
          {/* Waits in a row fold into one line; a part with a card, an approval, or handoffs on screen stays whole. */}
          {foldWaits(
            turn.parts,
            (part) =>
              onlyWaits(part) &&
              (part !== turn.parts[0] || !!turn.person) &&
              !placed.get(part.id)?.length &&
              !(showHandoffs && part.internal.length > 0),
          ).map((run) =>
            run.kind === "waits" ? (
              <DeferralGroup key={run.parts[0].id} parts={run.parts} onToggle={relayout} />
            ) : (
              <PartView
                key={run.part.id}
                part={run.part}
                // A root no person wrote (a schedule, a workflow) keeps the task card, so its prompt shows.
                card={run.part === turn.parts[0] && !turn.person}
                summary={workerSummary(run.part, now)}
                approvals={placed.get(run.part.id) ?? []}
                pendingIds={pendingIds}
                showHandoffs={showHandoffs}
                open={blocks.isOpen(run.part.id)}
                onToggle={() => toggle(run.part.id)}
                onStepToggle={relayout}
                stepsId={`${idPrefix}-steps-${run.part.id}`}
                nameOf={nameOf}
                now={now}
              />
            ),
          )}
        </Fragment>
      ))}
      {placed.get(null)?.map((approval) => (
        <ApprovalLine key={approval.id} approval={approval} pending={pendingIds.has(approval.id)} />
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
  pendingIds,
  showHandoffs,
  open,
  onToggle,
  onStepToggle,
  stepsId,
  nameOf,
  now,
}: {
  part: TurnPart;
  card: boolean;
  summary: WorkerSummary | null;
  approvals: SessionApproval[];
  /** Approval ids still in the session detail's pending list. */
  pendingIds: Set<string>;
  showHandoffs: boolean;
  open: boolean;
  onToggle: () => void;
  /** Called after a person opens or closes one step row. */
  onStepToggle: () => void;
  stepsId: string;
  nameOf: (agentId: string | null) => string;
  now: number;
}) {
  const internal = showHandoffs ? part.internal : [];
  const steps = partSteps(part);
  // Steps and handoffs in one column, oldest first.
  const rows = [
    ...steps.map((step) => ({ at: step.tries[0].createdAt, step, task: null })),
    ...internal.map((task) => ({ at: task.createdAt, step: null, task })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const list = rows.map((row) =>
    row.step ? (
      <WorkerStep
        key={row.step.tries[0].id}
        step={row.step}
        agentName={nameOf(row.step.agentId)}
        now={now}
        onToggle={onStepToggle}
      />
    ) : row.task ? (
      <div key={row.task.id} className="px-1.5">
        <InternalLine task={row.task} />
      </div>
    ) : null,
  );
  return (
    <div data-slot="swarm-turn" className="flex min-w-0 flex-col gap-2">
      {card ? (
        <TaskCard task={part.reply} className="pb-0" />
      ) : (
        <Reply task={part.reply} onToggle={onStepToggle} />
      )}
      {summary && steps.length > 1 ? (
        <div className="flex min-w-0 flex-col gap-1">
          <WorkerSummaryLine
            summary={summary}
            steps={steps}
            nameOf={nameOf}
            open={open}
            onToggle={onToggle}
            controls={stepsId}
          />
          <div id={stepsId}>
            <AnimatedReveal open={open} speed="fast">
              <div className="flex min-w-0 flex-col rounded-lg border border-border p-1">
                {list}
              </div>
            </AnimatedReveal>
          </div>
        </div>
      ) : rows.length > 0 ? (
        // One step (or handoffs only): plain rows, lined up with the reply text.
        <div className="-mx-1.5 flex min-w-0 flex-col">{list}</div>
      ) : null}
      {part.result ? (
        <div className={rows.length > 0 ? "mt-3" : undefined}>
          <Reply task={part.result} onToggle={onStepToggle} />
        </div>
      ) : null}
      {approvals.map((approval) => (
        <ApprovalLine key={approval.id} approval={approval} pending={pendingIds.has(approval.id)} />
      ))}
      {/* The lead works again: a live line under the latest answer, never in its place. */}
      {part.live ? <SwarmReply task={part.live} /> : null}
    </div>
  );
}

/** A swarm reply, or one muted line when the reply only says the swarm waits. */
function Reply({ task, onToggle }: { task: AgentTask; onToggle: () => void }) {
  return isDeferral(task) ? (
    <DeferralLine task={task} onToggle={onToggle} />
  ) : (
    <SwarmReply task={task} />
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

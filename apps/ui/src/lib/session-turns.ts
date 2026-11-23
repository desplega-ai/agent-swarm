// The turn model of a session timeline (SPEC R8.3, R8.4, mockup sB1). A turn
// starts at a person's message: a `ui` task (a dashboard message), a Slack or
// chat message, or the root. In the swarm that one task is also the lead's
// first reply: the lead owns it, and its output is the reply.
//
// A turn has one part, plus one more part per deferred wake-up and per later
// lead answer (a `system` follow-up after a worker, with an output). A task
// belongs to the session when a walk up from it reaches an opener (the
// person's message or a wake-up). "Up" follows the task that dispatched a task
// when it is in the chain, else `parentTaskId`: a continuation's parent can be
// an earlier worker task in another turn. Then each task joins the part of the
// latest opener created at or before it, so the timeline reads in time order.
// Each part shows:
//   - reply: the opener. Its answer is the opener itself, or the server's
//     `resume` of it when a deploy or a crash cut it: one answer, tried again.
//   - workers: tasks of other agents created in the part, by agent, then by
//     task type. A try that did not pass (failed, cancelled, superseded) and a
//     later try of the same agent and type form one step.
//   - live: a lead task that runs now, after the part's answer. It never
//     replaces an answer.
//   - internal: everything else of the lead or the system (follow-ups that
//     ended with no output, reroutes, the lead's resume), for the Handoffs
//     toggle.
// Tasks with no path to the root land in `rest`, which the timeline renders
// as plain task cards in chain order.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { AgentTask, SessionApproval } from "../api/types";
import { dispatchParentId } from "./dispatch-parent";
import { TERMINAL_STATUSES } from "./task-activity";

/** One unit of delegated work: the tries of one agent at one task type. */
export interface WorkerStep {
  taskType: string;
  /** Oldest first. Every try but the last did not pass. */
  tries: AgentTask[];
}

export interface TurnWorker {
  /** Null for work still in the pool. */
  agentId: string | null;
  steps: WorkerStep[];
}

/**
 * One answer of the lead: its tries, oldest first. Every try but the last did
 * not pass (a deploy or a crash cut it, and the server's `resume` of it took
 * the work over); the last try is the answer shown.
 */
export interface LeadStep {
  tries: AgentTask[];
}

export interface TurnPart {
  /** The task that opened the part: the person's message, the root, a wake-up, or a lead answer. */
  id: string;
  /** The opener: its text is the person's message, its source the channel. */
  reply: AgentTask;
  /** The opener's answer. `answer.tries[0]` is `reply`. */
  answer: LeadStep;
  workers: TurnWorker[];
  /** Oldest first. Excludes `live`. */
  internal: AgentTask[];
  /** A lead task that runs now, after the part's answer. */
  live?: AgentTask;
}

/** The try an answer shows: its last. */
export const shownTry = (step: LeadStep): AgentTask => step.tries[step.tries.length - 1];

export interface Turn {
  /** The task that opened the turn. */
  id: string;
  /** The person's message. Missing when the root did not come from a person (a schedule, a workflow). */
  person?: AgentTask;
  /** The first part, then one per deferred wake-up or later lead answer, oldest first. */
  parts: TurnPart[];
}

export interface SessionTurns {
  turns: Turn[];
  /** Tasks with no path to the root, in chain order. */
  rest: AgentTask[];
}

/** Sources where a person writes the task text: the dashboard, Slack, and chat channels. */
const PERSON_SOURCES = new Set(["ui", "slack", "chat"]);
/** A try that ended without a pass; the next try of the same step is a retry. */
const NOT_PASSED = new Set(["failed", "cancelled", "superseded"]);

/**
 * How a task joins the timeline. `person` opens a turn, `wake` opens a part.
 * `continue` is the same work again (a task-page Retry, a resume, a deferred
 * worker): it joins the step of the task it continues, or the lead's answers.
 */
type Kind = "person" | "wake" | "continue" | "try" | "lead" | "internal";

/** A task-page Retry (`lib/task-retry.ts`): a `ui` copy of its parent with the same prompt. */
function isRetryOf(task: AgentTask, parent: AgentTask | undefined): boolean {
  return (
    !!parent &&
    task.source === "ui" &&
    task.task === parent.task &&
    (task.taskType ?? "") === (parent.taskType ?? "") &&
    (!parent.agentId || task.agentId === parent.agentId)
  );
}

/**
 * Options for `buildTurns`. `personText` names more tasks a person wrote: a
 * task it returns text for opens a turn whatever its source (a json-render
 * app page sends its messages as `api` tasks). Tasks it returns null for keep
 * the source rules.
 */
export interface BuildTurnsOptions {
  personText?: (task: AgentTask) => string | null;
}

function isPersonTask(task: AgentTask, options: BuildTurnsOptions): boolean {
  return PERSON_SOURCES.has(task.source) || (options.personText?.(task) ?? null) !== null;
}

function kindOf(
  task: AgentTask,
  parent: AgentTask | undefined,
  isLead: boolean,
  options: BuildTurnsOptions,
): Kind {
  if (isRetryOf(task, parent)) return "continue";
  // A dashboard message with no picked user is still a person writing.
  if (isPersonTask(task, options)) return "person";
  if (task.taskType === "deferred") return isLead ? "wake" : "continue";
  // A worker's resume is the same work in a new session; its superseded try did not pass.
  if (!isLead && (task.taskType === "resume" || task.status === "superseded")) return "continue";
  if (task.source === "system" || task.status === "superseded") return "internal";
  return isLead ? "lead" : "try";
}

interface DraftTurn extends Omit<Turn, "parts"> {
  parts: Draft[];
}

interface Draft extends TurnPart {
  turn: DraftTurn;
  lead: AgentTask[];
  byAgent: Map<string, TurnWorker>;
}

export function buildTurns(chain: AgentTask[], options: BuildTurnsOptions = {}): SessionTurns {
  const byId = new Map<string, AgentTask>();
  for (const task of chain) byId.set(task.id, task);
  const tasks = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const root = tasks.find((task) => !task.parentTaskId);
  if (!root) return { turns: [], rest: tasks };

  // Session reads mark lead tasks. Older servers do not, so the root's agent
  // (the lead that took the first message) stands in.
  const leadKnown = tasks.some((task) => task.isLeadTask !== undefined);
  const isLead = (task: AgentTask) =>
    leadKnown ? task.isLeadTask === true : !!task.agentId && task.agentId === root.agentId;

  const kinds = new Map<string, Kind>();
  for (const task of tasks) {
    const parent = task.parentTaskId ? byId.get(task.parentTaskId) : undefined;
    kinds.set(task.id, task === root ? "person" : kindOf(task, parent, isLead(task), options));
  }

  const turns: DraftTurn[] = [];
  const parts = new Map<string, Draft>();
  const newPart = (opener: AgentTask, turn: DraftTurn): Draft => {
    const part: Draft = {
      id: opener.id,
      reply: opener,
      answer: { tries: [opener] },
      workers: [],
      internal: [],
      turn,
      lead: [],
      byAgent: new Map(),
    };
    turn.parts.push(part);
    parts.set(opener.id, part);
    return part;
  };
  // Turns in chain order. The root opens the first turn, person or not.
  for (const task of tasks) {
    if (kinds.get(task.id) !== "person" || (task !== root && !task.parentTaskId)) continue;
    const turn: DraftTurn = {
      id: task.id,
      ...(task !== root || isPersonTask(task, options) ? { person: task } : {}),
      parts: [],
    };
    turns.push(turn);
    newPart(task, turn);
  }

  // The part of each task: its nearest opener above it. Each walk stops at a
  // task whose part is known, so every task is walked once. Null: the walk
  // left the chain (a missing parent) or looped.
  const partOf = new Map<string, Draft | null>();
  const resolve = (start: AgentTask): Draft | null => {
    const path: AgentTask[] = [];
    let node: AgentTask | undefined = start;
    let found: Draft | null = null;
    while (node) {
      const known = partOf.get(node.id);
      if (known !== undefined) {
        found = known;
        break;
      }
      const opened = parts.get(node.id);
      if (opened) {
        found = opened;
        break;
      }
      if (kinds.get(node.id) === "wake") {
        // A wake-up opens a part in the turn of the part that waited.
        const parent: AgentTask | undefined = node.parentTaskId
          ? byId.get(node.parentTaskId)
          : undefined;
        const waited = parent ? resolve(parent) : null;
        found = waited ? newPart(node, waited.turn) : null;
        break;
      }
      path.push(node);
      if (path.length > tasks.length) break;
      const above = dispatchParentId(node, (id) => byId.has(id));
      node = above ? byId.get(above) : undefined;
    }
    for (const task of path) partOf.set(task.id, found);
    return found;
  };

  const rest: AgentTask[] = [];
  const stepOf = new Map<string, WorkerStep>();
  for (const task of tasks) {
    if (parts.has(task.id)) continue;
    const part = resolve(task);
    if (!part) {
      rest.push(task);
      continue;
    }
    if (part.id === task.id) continue;
    let kind = kinds.get(task.id) as Kind;
    const continued = task.parentTaskId ? stepOf.get(task.parentTaskId) : undefined;
    if (kind === "continue") kind = continued ? "try" : isLead(task) ? "lead" : "try";
    if (kind === "try") {
      stepOf.set(task.id, addTry(part, task, continued?.taskType ?? task.taskType ?? ""));
    } else {
      // The lead's internal tasks can carry its answer, so they are also answer candidates.
      if (isLead(task)) part.lead.push(task);
      if (kind === "internal") part.internal.push(task);
    }
  }

  return { turns: placeByTime(turns), rest };
}

/** A lead answer a person reads: its shown try completed with an output. */
const isAnswer = (step: LeadStep) => {
  const last = shownTry(step);
  return last.status === "completed" && !!last.output?.trim();
};

interface Slot {
  at: string;
  part: TurnPart;
  byAgent: Map<string, TurnWorker>;
  loose: AgentTask[];
}

/**
 * The parts in time order (the timeline reads as a continuation). The walk
 * above finds where a task belongs by who sent it; this puts it where it
 * happened. Every opener (a person's message, a wake-up, each later lead
 * answer) starts a part, and every other task joins the part of the latest
 * opener created at or before it. So a worker that a GitHub review started an
 * hour later shows after the lead's latest answer, not folded into the first
 * reply's group, and a turn's work never shows above a later message.
 */
function placeByTime(drafts: DraftTurn[]): Turn[] {
  const turns: Turn[] = drafts.map(({ parts: _parts, ...turn }) => ({ ...turn, parts: [] }));
  const openers: Array<{ at: string; answer: LeadStep; turn?: Turn }> = [];
  const loose: AgentTask[] = [];
  const leadIds = new Set<string>();
  const steps: Array<WorkerStep & { agentId: string | null }> = [];
  drafts.forEach((draft, index) => {
    for (const part of draft.parts) {
      const { answer, later } = leadSteps(part);
      // A turn's first part opens the turn; a wake-up joins the turn it lands in by time.
      openers.push({
        at: part.reply.createdAt,
        answer,
        ...(part === draft.parts[0] ? { turn: turns[index] } : {}),
      });
      for (const step of later) {
        if (isAnswer(step)) openers.push({ at: step.tries[0].createdAt, answer: step });
        else loose.push(...step.tries);
      }
      for (const task of part.lead) leadIds.add(task.id);
      for (const task of part.internal) if (!leadIds.has(task.id)) loose.push(task);
      for (const worker of part.workers)
        for (const step of worker.steps) steps.push({ ...step, agentId: worker.agentId });
    }
  });
  // Stable: an opener keeps chain order on a tied timestamp.
  openers.sort((a, b) => a.at.localeCompare(b.at));
  const slots: Slot[] = [];
  let turn = turns[0];
  for (const opener of openers) {
    turn = opener.turn ?? turn;
    const reply = opener.answer.tries[0];
    const part: TurnPart = {
      id: reply.id,
      reply,
      answer: opener.answer,
      workers: [],
      internal: [],
    };
    turn.parts.push(part);
    slots.push({ at: opener.at, part, byAgent: new Map(), loose: [] });
  }
  // The latest slot opened at or before `at`; the first for anything older.
  const slotAt = (at: string): Slot => {
    let lo = 0;
    let hi = slots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (slots[mid].at <= at) lo = mid;
      else hi = mid - 1;
    }
    return slots[lo];
  };

  // A step sits where its first try started, retries included.
  steps.sort((a, b) => a.tries[0].createdAt.localeCompare(b.tries[0].createdAt));
  for (const { agentId, ...step } of steps) {
    const slot = slotAt(step.tries[0].createdAt);
    const key = agentId ?? "";
    let worker = slot.byAgent.get(key);
    if (!worker) {
      worker = { agentId, steps: [] };
      slot.byAgent.set(key, worker);
      slot.part.workers.push(worker);
    }
    worker.steps.push(step);
  }
  for (const task of loose) slotAt(task.createdAt).loose.push(task);
  for (const { part, loose: tasks } of slots) {
    // The lead works again: the newest open lead task after the part's answer.
    const shownAt = shownTry(part.answer).createdAt;
    const live = tasks
      .filter(
        (task) =>
          leadIds.has(task.id) && !TERMINAL_STATUSES.has(task.status) && task.createdAt >= shownAt,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
    part.internal = tasks
      .filter((task) => task !== live)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (live) part.live = live;
  }
  return turns;
}

function addTry(part: Draft, task: AgentTask, taskType: string): WorkerStep {
  const key = task.agentId ?? "";
  let worker = part.byAgent.get(key);
  if (!worker) {
    worker = { agentId: task.agentId ?? null, steps: [] };
    part.byAgent.set(key, worker);
    part.workers.push(worker);
  }
  let step: WorkerStep | undefined;
  for (let i = worker.steps.length - 1; i >= 0 && !step; i--) {
    if (worker.steps[i].taskType === taskType) step = worker.steps[i];
  }
  const last = step?.tries[step.tries.length - 1];
  if (step && last && NOT_PASSED.has(last.status)) {
    step.tries.push(task);
    return step;
  }
  const created = { taskType, tries: [task] };
  worker.steps.push(created);
  return created;
}

/** A part's lead tasks as answers: the opener's, then each later one, oldest first. */
function leadSteps({ reply, lead }: Draft): { answer: LeadStep; later: LeadStep[] } {
  // Lead tasks arrive oldest first. The server's `resume` of a lead task that
  // did not pass is the same answer tried again (as a worker's resume is the
  // same step): it joins that task's tries instead of standing on its own.
  const answer: LeadStep = { tries: [reply] };
  const later: LeadStep[] = [];
  const stepOf = new Map<string, LeadStep>([[reply.id, answer]]);
  for (const task of lead) {
    const continued = task.parentTaskId ? stepOf.get(task.parentTaskId) : undefined;
    if (continued && task.taskType === "resume" && NOT_PASSED.has(shownTry(continued).status)) {
      continued.tries.push(task);
      stepOf.set(task.id, continued);
      continue;
    }
    const step = { tries: [task] };
    later.push(step);
    stepOf.set(task.id, step);
  }
  return { answer, later };
}

/** Every step of a part, oldest first by its first try (the expanded block's order). */
export function partSteps(part: TurnPart): Array<WorkerStep & { agentId: string | null }> {
  return part.workers
    .flatMap((worker) => worker.steps.map((step) => ({ ...step, agentId: worker.agentId })))
    .sort((a, b) => a.tries[0].createdAt.localeCompare(b.tries[0].createdAt));
}

const endOf = (task: AgentTask) => Date.parse(task.finishedAt ?? task.lastUpdatedAt);

export interface WorkerSummary {
  /** Distinct agents, in order of first work. Retries of one agent count once. */
  agentIds: Array<string | null>;
  /**
   * `working`: a step runs now. `waiting`: a step is open but not running
   * (queued, offered, paused). `failed`: the last try of a step failed.
   * `cancelled`: the last try of a step was cancelled or superseded.
   */
  state: "working" | "waiting" | "done" | "failed" | "cancelled";
  /** Wall clock: the first try's start to the last try's end, or to now while work runs. */
  durationMs: number;
  /** Earlier tries of the steps that passed. */
  retries: number;
  /** Steps whose last try failed. */
  failed: number;
  /** Steps whose last try was cancelled or superseded. */
  cancelled: number;
}

/** The folded worker line of a part (SPEC R8.3). Null when the part has no workers. */
export function workerSummary(part: TurnPart, now: number): WorkerSummary | null {
  const steps = partSteps(part);
  if (steps.length === 0) return null;
  const agentIds = [...new Set(steps.map((step) => step.agentId))];
  const lastOf = (step: WorkerStep) => step.tries[step.tries.length - 1];
  const count = (status: string) => steps.filter((step) => lastOf(step).status === status).length;
  const openSteps = steps.filter((step) => !TERMINAL_STATUSES.has(lastOf(step).status));
  const running = openSteps.filter((step) => lastOf(step).status === "in_progress");
  const failed = count("failed");
  const cancelled = count("cancelled") + count("superseded");
  const retries = steps
    .filter((step) => lastOf(step).status === "completed")
    .reduce((n, step) => n + step.tries.length - 1, 0);

  if (openSteps.length > 0) {
    const active = running.length > 0 ? running : openSteps;
    const since = Math.min(...active.map((step) => Date.parse(step.tries[0].createdAt)));
    return {
      agentIds,
      state: running.length > 0 ? "working" : "waiting",
      durationMs: Math.max(0, now - since),
      retries,
      failed,
      cancelled,
    };
  }
  const start = Math.min(...steps.map((step) => Date.parse(step.tries[0].createdAt)));
  const end = Math.max(...steps.flatMap((step) => step.tries.map(endOf)));
  return {
    agentIds,
    state: failed > 0 ? "failed" : cancelled > 0 ? "cancelled" : "done",
    durationMs: Math.max(0, end - start),
    retries,
    failed,
    cancelled,
  };
}

/** The task ids a part shows or folds, so a lookup can find a task's part. */
function partTaskIds(part: TurnPart): string[] {
  return [
    ...part.answer.tries.map((task) => task.id),
    ...partSteps(part).flatMap((step) => step.tries.map((task) => task.id)),
    ...part.internal.map((task) => task.id),
    ...(part.live ? [part.live.id] : []),
  ];
}

/**
 * Pending approvals by the part that asked (the part that holds
 * `sourceTaskId`). An approval whose task is in no part goes under `null`:
 * after the turns.
 */
export function approvalsByPart(
  turns: Turn[],
  approvals: SessionApproval[],
): Map<string | null, SessionApproval[]> {
  const owner = new Map<string, string>();
  for (const turn of turns) {
    for (const part of turn.parts) for (const id of partTaskIds(part)) owner.set(id, part.id);
  }
  const out = new Map<string | null, SessionApproval[]>();
  for (const approval of approvals) {
    const key = owner.get(approval.sourceTaskId) ?? null;
    out.set(key, [...(out.get(key) ?? []), approval]);
  }
  return out;
}

/**
 * The approvals to show: every one seen in this view, in first-seen order.
 * The session detail lists only pending approvals, so one resolved meanwhile
 * would vanish; kept, its card shows the resolved state.
 */
export function keepSeenApprovals(
  seen: SessionApproval[],
  current: SessionApproval[],
): SessionApproval[] {
  const byId = new Map(current.map((approval) => [approval.id, approval]));
  const seenIds = new Set(seen.map((approval) => approval.id));
  return [
    ...seen.map((approval) => byId.get(approval.id) ?? approval),
    ...current.filter((approval) => !seenIds.has(approval.id)),
  ];
}

/** `true` when the Handoffs toggle has rows to show. */
export function hasHandoffs(turns: Turn[]): boolean {
  return turns.some((turn) => turn.parts.some((part) => part.internal.length > 0));
}

/**
 * A task that ended in a deferral: `defer-task` sets `deferredAt`, and its
 * output only says what the swarm waits for. With an output schema the output
 * is the agent's JSON instead, so that reply is not folded into a wait line.
 */
export function isDeferral(task: AgentTask): boolean {
  if (typeof task.deferredAt !== "string") return false;
  const { who, by } = deferralText(task.output);
  return who !== null || by !== null;
}

export interface DeferralText {
  /** Who the swarm waits on. Null for a wake-up at a time only. */
  who: string | null;
  /** When it checks back at the latest: "17:50", "tomorrow 09:00", "Nov 2 09:00". */
  by: string | null;
}

// `defer-task` writes "Waiting on <who>, or <when> at the latest" (with an em dash, U+2014,
// where this comment has a comma) or "Checking back <when>".
const WAITING_ON = /^Waiting on (.+?) \u2014 or (.+) at the latest$/;
const CHECKING_BACK = /^Checking back (.+)$/;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "17:50", "tomorrow 09:00" or "11-02 09:00", in the viewer's local timezone. */
export function localResumeTime(iso: string, now: Date = new Date()): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  return `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${time}`;
}

/**
 * The parts of a deferral's text. Both null for an output in another shape (an outputSchema).
 * With `deferredUntil`, `by` is that ceiling in the viewer's timezone; the text's own time
 * is in the requester's.
 */
export function deferralText(
  output: string | undefined,
  deferredUntil?: string,
  now?: Date,
): DeferralText {
  const text = output?.trim() ?? "";
  const waiting = WAITING_ON.exec(text);
  const when = waiting?.[2] ?? CHECKING_BACK.exec(text)?.[1] ?? null;
  const local = when && deferredUntil ? localResumeTime(deferredUntil, now) : null;
  return {
    who: waiting?.[1] ?? null,
    by:
      local ??
      when
        ?.replace(/^today at /, "")
        .replace(/^on /, "")
        .replace(" at ", " ") ??
      null,
  };
}

/** A part that only waits: its reply deferred, with no steps or live work. */
export function onlyWaits(part: TurnPart): boolean {
  return isDeferral(shownTry(part.answer)) && part.workers.length === 0 && !part.live;
}

export type PartRun = { kind: "part"; part: TurnPart } | { kind: "waits"; parts: TurnPart[] };

/** A turn's parts in order, each run of two or more consecutive waiting parts folded into one. */
export function foldWaits(
  parts: TurnPart[],
  waits: (part: TurnPart) => boolean = onlyWaits,
): PartRun[] {
  const runs: PartRun[] = [];
  let run: TurnPart[] = [];
  const flush = () => {
    if (run.length > 1) runs.push({ kind: "waits", parts: run });
    else for (const part of run) runs.push({ kind: "part", part });
    run = [];
  };
  for (const part of parts) {
    if (waits(part)) {
      run.push(part);
      continue;
    }
    flush();
    runs.push({ kind: "part", part });
  }
  flush();
  return runs;
}

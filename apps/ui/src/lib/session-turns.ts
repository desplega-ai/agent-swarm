// The turn model of a session timeline (SPEC R8.3, R8.4, mockup sB1). A turn
// starts at a person's message: a `ui` task (a dashboard message), a Slack or
// chat message, or the root. In the swarm that one task is also the lead's
// first reply: the lead owns it, and its output is the reply.
//
// A turn has one part, plus one more part per deferred wake-up: the lead
// waits, then a `deferred` task runs and its output is the resumed answer.
// Tasks belong to the part of their nearest opener above them (the person's
// message or a wake-up). Each part shows:
//   - reply: the opener's answer.
//   - workers: tasks of other agents, by agent, then by task type. A try that
//     did not pass (failed, cancelled, superseded) and a later try of the same
//     agent and type form one step.
//   - result: the lead's latest completed answer after the reply. The lead
//     answers after its workers in a `system` follow-up.
//   - live: a lead task that runs now, after the latest shown answer. It never
//     replaces an answer.
//   - internal: everything else of the lead or the system (follow-ups that only
//     sent more work, reroutes, the lead's resume), for the Handoffs toggle.
// Tasks with no path to the root land in `rest`, which the timeline renders
// as plain task cards in chain order.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { AgentTask, SessionApproval } from "../api/types";
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

export interface TurnPart {
  /** The task that opened the part: the person's message, the root, or a wake-up. */
  id: string;
  /** The opener's answer. */
  reply: AgentTask;
  workers: TurnWorker[];
  /** Oldest first. Excludes `result` and `live`. */
  internal: AgentTask[];
  /** The lead's latest completed answer after the reply. */
  result?: AgentTask;
  /** A lead task that runs now, after the latest shown answer. */
  live?: AgentTask;
}

export interface Turn {
  /** The task that opened the turn. */
  id: string;
  /** The person's message. Missing when the root did not come from a person (a schedule, a workflow). */
  person?: AgentTask;
  /** The first part, then one per deferred wake-up, oldest first. */
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

function kindOf(task: AgentTask, parent: AgentTask | undefined, isLead: boolean): Kind {
  if (isRetryOf(task, parent)) return "continue";
  // A dashboard message with no picked user is still a person writing.
  if (PERSON_SOURCES.has(task.source)) return "person";
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

export function buildTurns(chain: AgentTask[]): SessionTurns {
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
    kinds.set(task.id, task === root ? "person" : kindOf(task, parent, isLead(task)));
  }

  const turns: DraftTurn[] = [];
  const parts = new Map<string, Draft>();
  const newPart = (opener: AgentTask, turn: DraftTurn): Draft => {
    const part: Draft = {
      id: opener.id,
      reply: opener,
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
      ...(task !== root || PERSON_SOURCES.has(task.source) ? { person: task } : {}),
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
      node = node.parentTaskId ? byId.get(node.parentTaskId) : undefined;
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

  for (const turn of turns)
    turn.parts.sort((a, b) => a.reply.createdAt.localeCompare(b.reply.createdAt));
  return { turns: turns.map((turn) => ({ ...turn, parts: turn.parts.map(finish) })), rest };
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

function finish({ id, reply, workers, internal, lead }: Draft): TurnPart {
  // Lead tasks arrive oldest first.
  const result = lead.filter((task) => task.status === "completed" && !!task.output?.trim()).at(-1);
  const shownAt = (result ?? reply).createdAt;
  const live = lead
    .filter((task) => !TERMINAL_STATUSES.has(task.status) && task.createdAt >= shownAt)
    .at(-1);
  const all = new Set(internal);
  for (const task of lead) all.add(task);
  all.delete(result as AgentTask);
  all.delete(live as AgentTask);
  return {
    id,
    reply,
    workers,
    internal: [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    ...(result ? { result } : {}),
    ...(live ? { live } : {}),
  };
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
  /** The agents of the open steps (`working` and `waiting`). */
  activeAgentIds: Array<string | null>;
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
      activeAgentIds: [...new Set(active.map((step) => step.agentId))],
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
    activeAgentIds: [],
    durationMs: Math.max(0, end - start),
    retries,
    failed,
    cancelled,
  };
}

/** The task ids a part shows or folds, so a lookup can find a task's part. */
function partTaskIds(part: TurnPart): string[] {
  return [
    part.reply.id,
    ...partSteps(part).flatMap((step) => step.tries.map((task) => task.id)),
    ...part.internal.map((task) => task.id),
    ...(part.result ? [part.result.id] : []),
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

/** `true` when the Handoffs toggle has rows to show. */
export function hasHandoffs(turns: Turn[]): boolean {
  return turns.some((turn) => turn.parts.some((part) => part.internal.length > 0));
}

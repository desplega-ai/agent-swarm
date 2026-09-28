import {
  autoCancelStaleApprovalRequests,
  timeoutExpiredApprovalRequests,
} from "../be/approval-sweeps";
import {
  assignUnassignedTaskPending,
  buildRoutingAffinityFromAgent,
  cleanupStaleSessions,
  createTaskExtended,
  deleteActiveSession,
  failTask,
  getActiveSessionForTask,
  getActiveTaskCount,
  getAllAgents,
  getDbClient,
  getIdleWorkersWithCapacity,
  getLeadAgent,
  getPendingSteeringForTask,
  getRecentCompletedCount,
  getRecentFailedCount,
  getRecentFailedTasks,
  getStaleUnassignedAffinityTasks,
  getStalledInProgressTasks,
  getTaskStats,
  getTasksByStatus,
  getUnassignedPoolTasks,
  getUnclaimedPins,
  hasPendingSteering,
  isAgentEligibleForTask,
  isPoolAffinityEnforcementEnabled,
  MAX_EMPTY_POLLS,
  promoteAbandonedDraftTasks,
  reclaimTask,
  releaseStaleMentionProcessing,
  releaseStaleOfferedTasksForOfflineAgents,
  releaseStaleProcessingInbox,
  releaseStaleReviewingTasks,
  unpinTask,
  updateAgentStatus,
} from "../be/db";
import {
  agentsWithLiveRuntime,
  countActiveRuntimeInstancesForAgent,
  expireStaleRuntimeInstances,
} from "../be/multi-runtime";
import type { HeartbeatAction, HeartbeatClassification } from "../extensions/contract";
import { dispatchPre, extensionIdForAgent } from "../extensions/dispatcher";
import { resolveTemplate } from "../prompts/resolver";
import { createPoolStarvationDecisionTask } from "../tasks/worker-follow-up";
import type { AgentTask } from "../types";
import { isMultiRuntimeEnabled } from "../utils/multi-runtime";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getExecutorRegistry } from "../workflows";
import { recoverIncompleteRuns } from "../workflows/recovery";
// Side-effect import: registers heartbeat event templates in the in-memory registry
import "./templates";

/**
 * Stall recovery follows specs/tla/heartbeat/HeartbeatSimple.tla: two
 * compare-and-swap writes on the task's own row.
 *  - Reclaim: a stalled `in_progress` task goes back to `pending` on the same
 *    row, pinned to its agent, `attempt + 1` (`reclaimTask`).
 *  - Unpin: a pin its agent did not pick up within the grace window goes back
 *    to the affinity-gated pool (`unpinTask`).
 * No resume rows, no reboot sweep: an API restart leaves nothing half-written,
 * so the first regular sweep after boot is the only recovery pass.
 */

/**
 * Control-plane task types the heartbeat fails instead of reclaiming, so the
 * heartbeat/triage tasks themselves never loop. `reroute-decision` (DES-523)
 * is a Lead decision about other work; re-running a crashed one would repeat
 * the decision, not recover the work.
 */
const SKIP_RECLAIM_TYPES = new Set([
  "heartbeat-checklist",
  "boot-triage",
  "heartbeat",
  "reroute-decision",
]);

// ============================================================================
// Configuration (env var overrides)
// ============================================================================

/**
 * Default heartbeat interval: 90 seconds.
 *
 * Every value in this block is read DYNAMICALLY (a getter, not a module-load
 * const). Module-level capture happened before `loadGlobalConfigsIntoEnv()`
 * hydrated `swarm_config` into `process.env`, so DB-saved thresholds were
 * silently ignored — even across a restart. Keep these as functions.
 */
function defaultIntervalMs(): number {
  return Number(process.env.HEARTBEAT_INTERVAL_MS) || 90_000;
}

/** Stall threshold: tasks with fresh worker heartbeat but no task update for this many minutes */
function stallThresholdMinutes(): number {
  return Number(process.env.HEARTBEAT_STALL_THRESHOLD_MIN) || 30;
}

/** Stall threshold: tasks with no active session (worker clearly dead) */
function stallThresholdNoSessionMin(): number {
  return Number(process.env.HEARTBEAT_STALL_NO_SESSION_MIN) || 5;
}

/** Stall threshold: tasks with stale worker heartbeat */
function stallThresholdStaleHeartbeatMin(): number {
  return Number(process.env.HEARTBEAT_STALL_STALE_HB_MIN) || 15;
}

/** Grace window for a fresh pending steering message before normal stall remediation resumes. */
export const STEERING_STALL_GRACE_MIN = Number(process.env.HEARTBEAT_STEERING_GRACE_MIN) || 5;

/** Stale resource cleanup threshold (minutes) */
const STALE_CLEANUP_THRESHOLD_MINUTES = Number(process.env.HEARTBEAT_STALE_CLEANUP_MIN) || 30;

/**
 * Abandoned-draft promotion threshold (minutes, #1240). Deliberately much
 * shorter than STALE_CLEANUP_THRESHOLD_MINUTES: a draft only exists while a
 * UI-composer attachment batch uploads, which even against slow storage
 * (#1226) took tens of seconds — 5 minutes is generous headroom above that
 * worst case while still surfacing an abandoned session (tab closed
 * mid-upload) to its owner within one coffee break, not half an hour.
 */
const DRAFT_TASK_TIMEOUT_MINUTES = Number(process.env.HEARTBEAT_DRAFT_TASK_TIMEOUT_MIN) || 5;

/** Max pool tasks to auto-assign per sweep */
function maxAutoAssignPerSweep(): number {
  const raw = process.env.HEARTBEAT_MAX_AUTO_ASSIGN?.trim();
  if (!raw) return 5;
  const n = Number(raw);
  // 0 is a valid operator choice ("assign nothing this sweep") and the config
  // validator accepts it — the usual `Number(...) || 5` idiom would silently
  // turn it back into the default.
  return Number.isInteger(n) && n >= 0 ? n : 5;
}

/**
 * Page size for `autoAssignPoolTasks`' paginated pool scan and the hard cap on
 * total rows scanned per sweep. A single bounded fetch used to mean N
 * ineligible affinity-tagged tasks at the head of the priority order could
 * hide all eligible work behind them indefinitely (see PR #954 review) — the
 * scan now pages through the pool until it has assigned `MAX_AUTO_ASSIGN_PER_SWEEP`
 * tasks or exhausted the pool, capped so a pool full of ineligible tasks can't
 * turn every sweep into an unbounded scan.
 */
const POOL_SCAN_BATCH_SIZE = Number(process.env.HEARTBEAT_POOL_SCAN_BATCH_SIZE) || 50;
const POOL_SCAN_CAP = Number(process.env.HEARTBEAT_POOL_SCAN_CAP) || 500;

/**
 * Max times the heartbeat reclaims one task before failing it for Lead triage.
 * The env var keeps its pre-Reclaim name so existing deployments keep their
 * budget: one reclaim used to be one resume generation.
 */
export function maxResumeGenerations(): number {
  return Number(process.env.HEARTBEAT_MAX_RESUME_GENERATIONS) || 3;
}

export const RESUME_BUDGET_EXHAUSTED_REASON = "resume_budget_exhausted";

type StallClassification = HeartbeatClassification;
type RemediationAction = HeartbeatAction;

type RemediationDecision = { action: RemediationAction; reason: string };

const REMEDIATION_ACTIONS = new Set<RemediationAction>(["supersede-resume", "fail", "record"]);

/**
 * Unpin grace (minutes): how long a pinned task may wait for its agent to
 * start it before it goes back to the pool. Covers rows the heartbeat
 * reclaimed and resume pins from the runner's graceful-shutdown supersede.
 * Generous enough for a slow container restart / image pull. Measured from the
 * time the row became `pending`. Set to `0` to disable Unpin.
 *
 * Uses `??` (not `|| 10`) so an explicit `0` is honored as "Unpin off" rather
 * than coerced back to the default.
 */
export const HEARTBEAT_RESUME_PIN_GRACE_MIN = (() => {
  const raw = process.env.HEARTBEAT_RESUME_PIN_GRACE_MIN;
  if (raw === undefined) return 10;
  const parsed = Number(raw);
  // Honor an explicit `0` (Unpin off), but fall back to the default on a
  // non-finite value (e.g. a typo'd `abc` → NaN). Without this guard, NaN passes
  // the `<= 0` disable check, reaches getUnclaimedPins(NaN), and throws in
  // `new Date(NaN).toISOString()` — breaking cleanup on every sweep.
  return Number.isFinite(parsed) ? parsed : 10;
})();

/**
 * Grace window (minutes) an `unassigned` pool task carrying a `routingAffinity`
 * snapshot waits before the starvation escalation (`escalateStarvedPoolTasks`)
 * hands it to the Lead — but ONLY when zero registered agents (any status)
 * satisfy `isAgentEligibleForTask` for it. A task with at least one matching
 * (even offline/busy) agent never escalates on this path; it waits for
 * `autoAssignPoolTasks` / the poll auto-claim instead. Enforcement is gated by
 * `POOL_AFFINITY_ENFORCEMENT` — the escalation is a no-op when that's off.
 */
const POOL_AFFINITY_ESCALATION_MIN = Number(process.env.POOL_AFFINITY_ESCALATION_MIN) || 15;

/** Heartbeat checklist interval: how often to check HEARTBEAT.md (default: 30 min) */
const HEARTBEAT_CHECKLIST_INTERVAL_MS =
  Number(process.env.HEARTBEAT_CHECKLIST_INTERVAL_MS) || 30 * 60 * 1000;

/** Whether to disable the heartbeat checklist entirely */
const HEARTBEAT_CHECKLIST_DISABLE = Boolean(process.env.HEARTBEAT_CHECKLIST_DISABLE);

// ============================================================================
// Types
// ============================================================================

export interface HeartbeatFindings {
  stalledTasks: AgentTask[];
  extensionSkipped: Array<{
    taskId: string;
    extension: { id: string; name: string };
    reason: string;
  }>;
  autoFailedTasks: Array<{ taskId: string; agentId: string; reason: string }>;
  /** Stalled tasks put back to `pending` on the same row (`reclaimTask`). */
  reclaimedTasks: Array<{ taskId: string; agentId: string; attempt: number; reason: string }>;
  /** Pins nobody picked up, returned to the pool (`unpinTask`). */
  unpinnedTasks: Array<{ taskId: string; previousAgentId: string }>;
  /** Starved affinity-tagged pool tasks escalated to a Lead reroute-decision. */
  escalatedReroutes: Array<{ originalTaskId: string; decisionTaskId: string }>;
  workerHealthFixes: Array<{ agentId: string; oldStatus: string; newStatus: string }>;
  autoAssigned: Array<{ taskId: string; agentId: string }>;
  staleCleanup: {
    sessions: number;
    reviewingTasks: number;
    mentionProcessing: number;
    inboxProcessing: number;
    workflowRuns: number;
    staleRuntimes: number;
    staleOfferedTasks: number;
    abandonedDraftTasks: number;
    approvalAutoCancelled: number;
    approvalTimedOut: number;
  };
}

export function emptyFindings(): HeartbeatFindings {
  return {
    stalledTasks: [],
    extensionSkipped: [],
    autoFailedTasks: [],
    reclaimedTasks: [],
    unpinnedTasks: [],
    escalatedReroutes: [],
    workerHealthFixes: [],
    autoAssigned: [],
    staleCleanup: {
      sessions: 0,
      reviewingTasks: 0,
      mentionProcessing: 0,
      inboxProcessing: 0,
      workflowRuns: 0,
      staleRuntimes: 0,
      staleOfferedTasks: 0,
      abandonedDraftTasks: 0,
      approvalAutoCancelled: 0,
      approvalTimedOut: 0,
    },
  };
}

// ============================================================================
// State
// ============================================================================

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let checklistInterval: ReturnType<typeof setInterval> | null = null;
let isSweeping = false;
let beforeHeartbeatWriteForTests: ((task: AgentTask) => void | Promise<void>) | null = null;

/** Runs between the classifier read and the Reclaim/fail write (race tests). */
export function setBeforeHeartbeatReclaimForTests(
  hook: ((task: AgentTask) => void | Promise<void>) | null,
): void {
  beforeHeartbeatWriteForTests = hook;
}

// ============================================================================
// Tier 1: Preflight Gate
// ============================================================================

/**
 * Quick check to determine if a full triage sweep is needed.
 * Returns true if something looks actionable, false to bail early.
 */
export async function preflightGate(): Promise<boolean> {
  const stats = await getTaskStats();
  const agents = await getAllAgents();

  const hasInProgressTasks = stats.in_progress > 0;
  const hasUnassignedTasks = stats.unassigned > 0;
  const hasOfferedTasks = stats.offered > 0;
  const hasReviewingTasks = stats.reviewing > 0;

  const onlineAgents = agents.filter((a) => a.status !== "offline");
  const idleWorkers = onlineAgents.filter((a) => !a.isLead && a.status === "idle");
  const busyWorkers = onlineAgents.filter((a) => !a.isLead && a.status === "busy");

  // Gate conditions — if any are true, proceed with triage
  if (hasUnassignedTasks && idleWorkers.length > 0) return true; // Pool tasks + idle workers → auto-assign
  if (hasInProgressTasks) return true; // Could have stalls
  if (hasOfferedTasks || hasReviewingTasks) return true; // Could have stale offers/reviews
  if (busyWorkers.length > 0) return true; // Need to verify worker health

  return false;
}

// ============================================================================
// Tier 2: Code-Level Triage
// ============================================================================
/**
 * Run all code-level triage checks. Returns findings for logging/escalation.
 */
export async function codeLevelTriage(): Promise<HeartbeatFindings> {
  const findings = emptyFindings();

  // 0. Retire runtimes that stopped pinging, before anything reasons about
  // which workers are alive — otherwise auto-assignment below can hand a task
  // to an agent this same sweep is about to mark offline, stranding it.
  findings.staleCleanup.staleRuntimes = (await expireStaleRuntimeInstances()).expired;

  // 0.5. Release offers pinned to an agent that just went offline (or was
  // already deleted) back to the pool, before auto-assignment runs — an
  // offer stuck on a dead offeree is otherwise invisible to
  // autoAssignPoolTasks (unassigned-only) and to the offeree's own
  // accept/reject path (nobody left to reach it). See #1190.
  findings.staleCleanup.staleOfferedTasks = await releaseStaleOfferedTasksForOfflineAgents();

  // 1. Reclaim stalled tasks in place (or fail them once the budget is spent)
  await reclaimStalledTasks(findings);

  // 2. Check and fix worker health
  await checkWorkerHealth(findings);

  // 3. Auto-assign pool tasks to idle workers
  await autoAssignPoolTasks(findings);

  // 4. Cleanup stale resources (Unpin, workflow run recovery, ...)
  await cleanupStaleResources(findings);

  return findings;
}

interface RemediationOptions {
  reclaimReason: string;
  failReason: string;
  shortLabel: string;
}

const REMEDIATION_OPTIONS: Record<"no-session" | "stale-session", RemediationOptions> = {
  "no-session": {
    reclaimReason: "Reclaimed by heartbeat: worker session not found (no active session for task)",
    failReason: "Auto-failed by heartbeat: worker session not found (no active session for task)",
    shortLabel: "no active session",
  },
  "stale-session": {
    reclaimReason: "Reclaimed by heartbeat: worker session heartbeat is stale (likely crashed)",
    failReason: "Auto-failed by heartbeat: worker session heartbeat is stale (likely crashed)",
    shortLabel: "stale session heartbeat",
  },
};

/**
 * Tiered stall detection. Cross-checks stalled tasks with active_sessions:
 * - No active session (5 min) or a stale session heartbeat (15 min) → the
 *   worker is gone → Reclaim (or fail when reclaiming is not allowed).
 * - Fresh session heartbeat but no task update for 30 min → record only.
 *
 * The classifier's read (attempt, lastUpdatedAt, session heartbeat) is
 * re-checked inside the write, so a worker write in between wins.
 */
async function reclaimStalledTasks(findings: HeartbeatFindings): Promise<void> {
  // Use the shortest threshold to catch all potentially stalled tasks
  const candidates = await getStalledInProgressTasks(stallThresholdNoSessionMin());

  for (const task of candidates) {
    if (!task.agentId) continue; // Unassigned tasks can't be stalled

    const session = await getActiveSessionForTask(task.id);
    const taskAgeMs = Date.now() - new Date(task.lastUpdatedAt).getTime();
    const sessionHeartbeatAgeMs = session
      ? Date.now() - new Date(session.lastHeartbeatAt).getTime()
      : null;
    if (await inSteeringGrace(task.id)) continue;

    const classification = classifyStall(taskAgeMs, sessionHeartbeatAgeMs);
    if (!classification) continue;

    let proposed = defaultRemediationDecision(task, classification);

    const dispatched = await dispatchPre(
      "pre.heartbeat.remediate",
      {
        task,
        ...(session ? { session } : {}),
        classification,
        proposedAction: proposed.action,
        reason: proposed.reason,
        taskAgeMs,
        ...(sessionHeartbeatAgeMs === null ? {} : { sessionHeartbeatAgeMs }),
      },
      { skipExtensionId: extensionIdForAgent(task.creatorAgentId) },
    );

    if (dispatched.action === "block") {
      findings.stalledTasks.push(task);
      findings.extensionSkipped.push({
        taskId: task.id,
        extension: dispatched.extension,
        reason: dispatched.reason,
      });
      continue;
    }

    if (dispatched.action === "modify") {
      const action = dispatched.data.proposedAction;
      if (isRemediationAction(action)) {
        proposed = { ...proposed, action };
      } else {
        console.warn(
          "[Heartbeat] Extension returned an invalid remediation action:",
          scrubSecrets(String(action)),
        );
      }
    }

    if (proposed.action === "record") {
      findings.stalledTasks.push(task);
      continue;
    }

    // An extension may force a remediation on a fresh-stalled task; it then
    // gets the stale-session wording.
    const opts =
      REMEDIATION_OPTIONS[classification === "no-session" ? "no-session" : "stale-session"];
    await remediateStalledTask(findings, task, session?.lastHeartbeatAt ?? null, opts, proposed);
  }
}

/** A fresh pending steering message holds off remediation for a grace window. */
async function inSteeringGrace(taskId: string): Promise<boolean> {
  if (!(await hasPendingSteering(taskId))) return false;
  const newest = (await getPendingSteeringForTask(taskId)).reduce<number>(
    (latest, message) => Math.max(latest, new Date(message.createdAt).getTime()),
    0,
  );
  return newest > 0 && Date.now() - newest < STEERING_STALL_GRACE_MIN * 60 * 1000;
}

function classifyStall(
  taskAgeMs: number,
  sessionHeartbeatAgeMs: number | null,
): StallClassification | undefined {
  if (sessionHeartbeatAgeMs === null) {
    return taskAgeMs >= stallThresholdNoSessionMin() * 60 * 1000 ? "no-session" : undefined;
  }
  const staleMs = stallThresholdStaleHeartbeatMin() * 60 * 1000;
  if (sessionHeartbeatAgeMs >= staleMs) {
    return taskAgeMs >= staleMs ? "stale-session" : undefined;
  }
  return taskAgeMs >= stallThresholdMinutes() * 60 * 1000 ? "fresh-stalled" : undefined;
}

function isRemediationAction(value: unknown): value is RemediationAction {
  return typeof value === "string" && REMEDIATION_ACTIONS.has(value as RemediationAction);
}

/**
 * `supersede-resume` is the extension-contract name of Reclaim (it predates
 * Reclaim; the row is no longer superseded).
 */
function defaultRemediationDecision(
  task: AgentTask,
  classification: StallClassification,
): RemediationDecision {
  if (classification === "fresh-stalled") {
    return { action: "record", reason: "Task stalled despite a fresh session heartbeat" };
  }
  const opts = REMEDIATION_OPTIONS[classification];
  // Workflow steps fail so the engine's own retry policy owns them (unchanged).
  if (task.workflowRunStepId != null) {
    return { action: "fail", reason: "superseded_workflow_task" };
  }
  if (SKIP_RECLAIM_TYPES.has(task.taskType ?? "")) {
    return { action: "fail", reason: opts.failReason };
  }
  if ((task.attempt ?? 0) + 1 > maxResumeGenerations()) {
    return { action: "fail", reason: RESUME_BUDGET_EXHAUSTED_REASON };
  }
  return { action: "supersede-resume", reason: opts.reclaimReason };
}

/**
 * Applies the decision with one compare-and-swap write on the task row:
 * `reclaimTask` (HeartbeatSimple.tla `Reclaim`) or `failTask` with the same
 * guards. Either write is a no-op when the worker wrote after the read.
 */
async function remediateStalledTask(
  findings: HeartbeatFindings,
  task: AgentTask,
  observedSessionHeartbeatAt: string | null,
  opts: RemediationOptions,
  decision: RemediationDecision,
): Promise<void> {
  if (!task.agentId) return; // Type guard — caller already checked.

  await beforeHeartbeatWriteForTests?.(task);

  if (decision.action === "fail") {
    const failed = await failTask(task.id, decision.reason, {
      expectedLastUpdatedAt: task.lastUpdatedAt,
      observedSessionHeartbeatAt,
    });
    if (!failed) return;
    findings.autoFailedTasks.push({
      taskId: task.id,
      agentId: task.agentId,
      reason: decision.reason,
    });
    if (observedSessionHeartbeatAt !== null) await deleteActiveSession(task.id);
    const message = `[Heartbeat] Auto-failed task ${task.id.slice(0, 8)}: ${decision.reason} (${opts.shortLabel})`;
    if (decision.reason === RESUME_BUDGET_EXHAUSTED_REASON) console.warn(message);
    else console.log(message);
  } else {
    const reclaimed = await reclaimTask(task.id, {
      expectedAttempt: task.attempt ?? 0,
      expectedLastUpdatedAt: task.lastUpdatedAt,
      observedSessionHeartbeatAt,
      reason: decision.reason,
    });
    if (!reclaimed) return;
    const attempt = reclaimed.attempt ?? 1;
    findings.reclaimedTasks.push({
      taskId: task.id,
      agentId: task.agentId,
      attempt,
      reason: decision.reason,
    });
    console.log(
      `[Heartbeat] Reclaimed task ${task.id.slice(0, 8)} (attempt ${attempt}): pending again on agent ${task.agentId.slice(0, 8)} (${opts.shortLabel})`,
    );
  }

  if ((await getActiveTaskCount(task.agentId)) === 0) {
    await restoreAgentIdleAfterRemediation(task.agentId);
  }
}

/**
 * Check for agents with mismatched status vs active task count.
 * - busy with 0 active tasks → fix to idle
 * - idle with active tasks → fix to busy
 */
async function checkWorkerHealth(findings: HeartbeatFindings): Promise<void> {
  const agents = (await getAllAgents()).filter((a) => a.status !== "offline");

  for (const agent of agents) {
    const activeCount = await getActiveTaskCount(agent.id);

    if (agent.status === "busy" && activeCount === 0) {
      await updateAgentStatus(agent.id, "idle");
      findings.workerHealthFixes.push({
        agentId: agent.id,
        oldStatus: "busy",
        newStatus: "idle",
      });
    } else if (agent.status === "idle" && activeCount > 0) {
      await updateAgentStatus(agent.id, "busy");
      findings.workerHealthFixes.push({
        agentId: agent.id,
        oldStatus: "idle",
        newStatus: "busy",
      });
    }
  }
}

/**
 * Auto-assign unassigned pool tasks to idle workers with capacity.
 * Leaves tasks pending so the assigned worker's normal poll dispatches them.
 *
 * Routing affinity (Phase 3): per-task filtering, not blind round-robin — for
 * each pool task (in priority/creation order), pick the first idle worker
 * that both has remaining capacity AND satisfies `isAgentEligibleForTask`.
 * A task with no eligible worker this sweep is left `unassigned` (queued);
 * it either gets picked up on a later sweep once a matching worker frees up,
 * or is escalated to the Lead by `escalateStarvedPoolTasks` once it's been
 * stale long enough with zero eligible agents at all.
 *
 * The pool scan itself is paginated (Phase 3.1): a single bounded fetch of
 * `MAX_AUTO_ASSIGN_PER_SWEEP` tasks used to mean that if the highest-priority
 * rows were all affinity-tagged for a role with no idle match this sweep,
 * lower-priority eligible work behind them was never even looked at — it
 * would starve indefinitely regardless of how many sweeps ran, since the same
 * ineligible head-of-line rows were re-fetched every time. This now pages
 * through the pool in `POOL_SCAN_BATCH_SIZE` windows until it has assigned
 * `MAX_AUTO_ASSIGN_PER_SWEEP` tasks or exhausted the pool (capped at
 * `POOL_SCAN_CAP` rows scanned).
 */
async function autoAssignPoolTasks(findings: HeartbeatFindings): Promise<void> {
  await getDbClient().transaction(async () => {
    // Skip idle workers whose accumulated empty-poll count has hit the gate;
    // assigning to them would just have them exit on their next poll. Filter on
    // the rows already returned (emptyPollCount is populated) rather than
    // re-querying per worker via shouldBlockPolling().
    // A multi-runtime agent whose runtimes have all died still reads as idle
    // until its rows expire; assigning to it would strand the task, since
    // nothing is left to poll for it.
    // While the mode is on, only an agent with a live runtime can poll, so
    // anything else — dead runtimes, or a worker that has not re-registered
    // since the flag was enabled — would have the task stranded on it. With
    // the flag off this is inert: legacy workers stop refreshing their
    // retained rows, and filtering on them would park tasks on healthy agents.
    const multiRuntime = isMultiRuntimeEnabled();
    const withLiveRuntime = multiRuntime ? await agentsWithLiveRuntime() : null;
    const idleWorkers = (await getIdleWorkersWithCapacity()).filter(
      (w) =>
        (w.emptyPollCount ?? 0) < MAX_EMPTY_POLLS &&
        (withLiveRuntime === null || withLiveRuntime.has(w.id)),
    );
    if (idleWorkers.length === 0) return;

    const reservedByWorker = new Map<string, number>();
    const reservedForWorker = async (agentId: string): Promise<number> => {
      const cached = reservedByWorker.get(agentId);
      if (cached !== undefined) return cached;
      const row = await getDbClient().get<{ count: number }>(
        "SELECT COUNT(*) as count FROM agent_tasks WHERE agentId = ? AND status IN ('pending', 'in_progress')",
        [agentId],
      );
      const reserved = row?.count ?? 0;
      reservedByWorker.set(agentId, reserved);
      return reserved;
    };

    let assignedCount = 0;
    let offset = 0;

    while (assignedCount < maxAutoAssignPerSweep() && offset < POOL_SCAN_CAP) {
      const batch = await getUnassignedPoolTasks(POOL_SCAN_BATCH_SIZE, offset);
      if (batch.length === 0) break;

      for (const task of batch) {
        if (assignedCount >= maxAutoAssignPerSweep()) break;

        let worker: (typeof idleWorkers)[number] | undefined;
        for (const w of idleWorkers) {
          if (
            (await reservedForWorker(w.id)) < (w.maxTasks ?? 1) &&
            isAgentEligibleForTask(w, task)
          ) {
            worker = w;
            break;
          }
        }
        if (!worker) continue; // No eligible worker with capacity this sweep — leave queued.

        const assigned = await assignUnassignedTaskPending(task.id, worker.id);
        if (assigned) {
          findings.autoAssigned.push({ taskId: task.id, agentId: worker.id });
          reservedByWorker.set(worker.id, (await reservedForWorker(worker.id)) + 1);
          assignedCount++;
        }
      }

      offset += batch.length;
      if (batch.length < POOL_SCAN_BATCH_SIZE) break; // Exhausted the pool.
    }
  });
}

/**
 * Unpin (HeartbeatSimple.tla `Unpin`): a pinned task its agent did not start
 * within `HEARTBEAT_RESUME_PIN_GRACE_MIN` goes back to the pool, carrying a
 * routing-affinity snapshot of that agent so only a same-role worker can claim
 * it. Time-based, so it also covers a hard-crashed agent that never goes
 * `offline`. A Lead-held pin is left alone: the pool has no one else who could
 * run Lead work. Starved pool tasks still reach the Lead through
 * `escalateStarvedPoolTasks`.
 *
 * Wired into `cleanupStaleResources`, so it runs on every sweep — including the
 * cleanup-only preflight-bail path and the first sweep after boot.
 */
async function unpinUnclaimedTasks(findings: HeartbeatFindings): Promise<void> {
  // Grace 0 = Unpin disabled (rollback switch).
  if (HEARTBEAT_RESUME_PIN_GRACE_MIN <= 0) return;

  const pins = await getUnclaimedPins(HEARTBEAT_RESUME_PIN_GRACE_MIN);
  if (pins.length === 0) return;
  const agents = new Map((await getAllAgents()).map((agent) => [agent.id, agent]));

  for (const task of pins) {
    const holderId = task.agentId;
    if (!holderId || agents.get(holderId)?.isLead) continue;

    const affinity =
      task.routingAffinity || task.routingAffinityInvalid
        ? null
        : await buildRoutingAffinityFromAgent(holderId);
    const unpinned = await unpinTask(task.id, {
      expectedLastUpdatedAt: task.lastUpdatedAt,
      routingAffinity: affinity ? JSON.stringify(affinity) : null,
    });
    if (!unpinned) continue; // started (or otherwise touched) since the read

    findings.unpinnedTasks.push({ taskId: task.id, previousAgentId: holderId });
    console.log(
      `[Heartbeat] Unpinned task ${task.id.slice(0, 8)}: agent ${holderId.slice(0, 8)} did not start it within ${HEARTBEAT_RESUME_PIN_GRACE_MIN} min; back in the pool`,
    );
  }
}

/**
 * Routing-affinity Phase 3: escalate `unassigned` pool tasks that carry a
 * `routingAffinity` snapshot, have sat queued past
 * `POOL_AFFINITY_ESCALATION_MIN`, AND have ZERO eligible registered agents —
 * "nobody of that role exists", not "everyone's busy right now" (`getAllAgents`
 * is intentionally unfiltered by status; an offline-but-matching agent still
 * counts as "not starved", since it'll be picked up once that agent returns).
 * A task with at least one matching agent (any status) is left queued for
 * `autoAssignPoolTasks` / the poll auto-claim instead of escalating early.
 *
 * No-op when `POOL_AFFINITY_ENFORCEMENT` is off (nothing can be starved if
 * the gate itself is disabled). Idempotent via the non-terminal
 * `reroute-decision`-child check in `createPoolStarvationDecisionTask`.
 */
async function escalateStarvedPoolTasks(findings: HeartbeatFindings): Promise<void> {
  if (!isPoolAffinityEnforcementEnabled()) return;

  const cutoff = new Date(Date.now() - POOL_AFFINITY_ESCALATION_MIN * 60 * 1000).toISOString();
  const candidates = await getStaleUnassignedAffinityTasks(cutoff);
  if (candidates.length === 0) return;

  // Lead-owned targets never actually claim pool work (getIdleWorkersWithCapacity
  // already excludes them), so exclude them here too — otherwise a Lead whose
  // role happens to match would falsely suppress escalation forever.
  const registeredAgents = (await getAllAgents()).filter((a) => !a.isLead);

  for (const task of candidates) {
    const hasEligibleAgent = registeredAgents.some((agent) => isAgentEligibleForTask(agent, task));
    if (hasEligibleAgent) continue; // Someone (any status) matches — keep queued.

    const decision = await createPoolStarvationDecisionTask({ original: task });
    if (decision.kind === "created") {
      findings.escalatedReroutes.push({
        originalTaskId: task.id,
        decisionTaskId: decision.task.id,
      });
      console.log(
        `[Heartbeat] Escalated starved pool task ${task.id.slice(0, 8)} → Lead reroute-decision ${decision.task.id.slice(0, 8)} (zero eligible agents)`,
      );
    }
  }
}

/**
 * Return a remediated agent to idle — unless multi-runtime liveness says no
 * process is serving it. Recovery still runs for the task; the agent just
 * must not be advertised as available when nothing can poll for it.
 */
async function restoreAgentIdleAfterRemediation(agentId: string): Promise<void> {
  if (isMultiRuntimeEnabled() && (await countActiveRuntimeInstancesForAgent(agentId)) === 0) return;
  await updateAgentStatus(agentId, "idle");
}

/**
 * Call existing stale resource cleanup functions.
 */
async function cleanupStaleResources(findings: HeartbeatFindings): Promise<void> {
  findings.staleCleanup.sessions = await cleanupStaleSessions(STALE_CLEANUP_THRESHOLD_MINUTES);
  findings.staleCleanup.reviewingTasks = await releaseStaleReviewingTasks(
    STALE_CLEANUP_THRESHOLD_MINUTES,
  );
  findings.staleCleanup.mentionProcessing = await releaseStaleMentionProcessing(
    STALE_CLEANUP_THRESHOLD_MINUTES,
  );
  findings.staleCleanup.inboxProcessing = await releaseStaleProcessingInbox(
    STALE_CLEANUP_THRESHOLD_MINUTES,
  );
  findings.staleCleanup.abandonedDraftTasks = await promoteAbandonedDraftTasks(
    DRAFT_TASK_TIMEOUT_MINUTES,
  );
  // Unpin: pins nobody picked up within the grace window go back to the pool.
  await unpinUnclaimedTasks(findings);
  // Routing-affinity Phase 3: escalate affinity-tagged pool tasks that have
  // zero eligible registered agents to a Lead re-delegation decision.
  await escalateStarvedPoolTasks(findings);
  try {
    findings.staleCleanup.workflowRuns = await recoverIncompleteRuns(getExecutorRegistry());
  } catch {
    // Workflow engine may not be initialized yet — skip recovery
    findings.staleCleanup.workflowRuns = 0;
  }
  // Approval sweeps run after the recovery pass, so a waiting run past its
  // expiresAt is routed on its timeout port before the timeout sweep reads it.
  try {
    findings.staleCleanup.approvalTimedOut = (
      await timeoutExpiredApprovalRequests()
    ).timedOut.length;
  } catch (err) {
    console.error("[heartbeat] approval timeout sweep failed:", err);
    findings.staleCleanup.approvalTimedOut = 0;
  }
  try {
    findings.staleCleanup.approvalAutoCancelled = (
      await autoCancelStaleApprovalRequests()
    ).cancelled.length;
  } catch (err) {
    console.error("[heartbeat] approval auto-cancel sweep failed:", err);
    findings.staleCleanup.approvalAutoCancelled = 0;
  }
}

// ============================================================================
// Heartbeat Checklist (HEARTBEAT.md-based periodic check)
// ============================================================================

/**
 * Check if content is effectively empty (only headers, comments, empty items).
 * Returns true if there are no actionable items — the checklist should be skipped.
 */
export function isEffectivelyEmpty(content: string): boolean {
  const lines = content.split("\n");
  let inComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track multi-line HTML comments
    if (inComment) {
      if (trimmed.includes("-->")) {
        inComment = false;
      }
      continue;
    }

    if (trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) {
        inComment = true;
      }
      continue;
    }

    // Skip blank lines
    if (trimmed === "") continue;

    // Skip markdown headers
    if (/^#{1,6}\s/.test(trimmed)) continue;

    // Skip empty list items (just a marker with no text)
    if (/^[-*+]\s*\[\s*\]\s*$/.test(trimmed)) continue;
    if (/^[-*+]\s*$/.test(trimmed)) continue;

    // If we get here, there's real content
    return false;
  }

  return true;
}

/**
 * Gather current system status as a markdown string for the lead's checklist task.
 */
export async function gatherSystemStatus(options?: { isBootTriage?: boolean }): Promise<string> {
  const stats = await getTaskStats();
  const stalledTasks = await getStalledInProgressTasks(stallThresholdMinutes());
  const agents = await getAllAgents();
  const idleWorkers = await getIdleWorkersWithCapacity();
  const poolTasks = await getUnassignedPoolTasks(10);
  const recentCompleted = await getRecentCompletedCount(24);
  const recentFailedCount = await getRecentFailedCount(24);

  const sections: string[] = [];

  // Task overview (with real 24h filtering)
  sections.push("## Task Overview [auto-generated]");
  sections.push(`- In Progress: ${stats.in_progress ?? 0}`);
  sections.push(`- Pending: ${stats.pending ?? 0}`);
  sections.push(`- Unassigned: ${stats.unassigned ?? 0}`);
  sections.push(`- Completed (24h): ${recentCompleted}`);
  sections.push(`- Failed (24h): ${recentFailedCount}`);

  // Stalled tasks
  if (stalledTasks.length > 0) {
    sections.push("");
    sections.push("## Stalled Tasks [auto-generated]");
    for (const task of stalledTasks) {
      const agentSlice = task.agentId?.slice(0, 8) ?? "unassigned";
      sections.push(
        `- [${task.id.slice(0, 8)}] "${task.task.slice(0, 60)}" — assigned to ${agentSlice}, last update: ${task.lastUpdatedAt}`,
      );
    }
  }

  // Recent failures with reasons and pattern detection (last 6 hours)
  const recentFailures = await getRecentFailedTasks(6);
  if (recentFailures.length > 0) {
    sections.push("");
    sections.push("## Recent Failures (last 6h) [auto-generated]");

    // Group by similar failure reasons for pattern detection
    const reasonGroups = new Map<string, typeof recentFailures>();
    for (const task of recentFailures) {
      const key = (task.failureReason ?? "unknown").slice(0, 80).toLowerCase().trim();
      const group = reasonGroups.get(key) ?? [];
      group.push(task);
      reasonGroups.set(key, group);
    }

    // Show patterns first (groups with 2+ failures)
    const patterns = [...reasonGroups.entries()].filter(([, tasks]) => tasks.length >= 2);
    if (patterns.length > 0) {
      sections.push("");
      sections.push("**Failure patterns detected:**");
      for (const [reason, tasks] of patterns) {
        const agentIds = [...new Set(tasks.map((t) => t.agentId?.slice(0, 8) ?? "?"))].join(", ");
        sections.push(`- ${tasks.length}x: "${reason}" (agents: ${agentIds})`);
      }
    }

    // List individual failures (max 10)
    sections.push("");
    for (const task of recentFailures.slice(0, 10)) {
      const agentSlice = task.agentId?.slice(0, 8) ?? "unassigned";
      const reason = task.failureReason?.slice(0, 100) ?? "no reason";
      sections.push(
        `- [${task.id.slice(0, 8)}] "${task.task.slice(0, 50)}" — agent: ${agentSlice}, reason: ${reason}, at: ${task.finishedAt}`,
      );
    }
    if (recentFailures.length > 10) {
      sections.push(`- ... and ${recentFailures.length - 10} more`);
    }
  }

  // Agent status
  const idle = agents.filter((a) => a.status === "idle");
  const busy = agents.filter((a) => a.status === "busy");
  const offline = agents.filter((a) => a.status === "offline");
  sections.push("");
  sections.push("## Agent Status [auto-generated]");
  sections.push(
    `- Online: ${idle.length + busy.length} (${idle.length} idle, ${busy.length} busy), Offline: ${offline.length}`,
  );

  // Available work
  if (poolTasks.length > 0 || idleWorkers.length > 0) {
    sections.push("");
    sections.push("## Available Work [auto-generated]");
    if (poolTasks.length > 0) {
      sections.push(`- ${poolTasks.length} unassigned pool task(s) waiting`);
    }
    if (idleWorkers.length > 0) {
      sections.push(`- ${idleWorkers.length} idle worker(s) with capacity`);
    }
  }

  // Reboot-interrupted work (boot triage only)
  if (options?.isBootTriage) {
    // Tasks the first sweep after boot reclaimed are back in their agent's
    // queue on the same row; list them so triage can watch they restart.
    const reclaimed = (await getTasksByStatus("pending")).filter((t) => (t.attempt ?? 0) > 0);
    if (reclaimed.length > 0) {
      sections.push("");
      sections.push("## Reclaimed Work [auto-generated]");
      sections.push(
        "These tasks stalled (their worker session is gone) and were put back to pending on the same task, pinned to their agent. They restart when the agent polls, or return to the pool after the unpin grace window.",
      );
      for (const task of reclaimed) {
        const agentName = task.agentId
          ? (agents.find((a) => a.id === task.agentId)?.name ?? task.agentId)
          : "unassigned";
        sections.push(
          `- [${task.id}] "${task.task.slice(0, 100)}" — attempt ${task.attempt}, pinned to ${agentName}`,
        );
      }
    }

    // Orphaned pending/offered tasks (assigned to workers with no active session)
    const orphanedTasks: AgentTask[] = [];

    for (const status of ["pending", "offered"] as const) {
      const tasks = await getTasksByStatus(status);

      for (const task of tasks) {
        // 'pending' tasks carry their holder in agentId; 'offered' tasks have
        // not been accepted yet, so agentId is still NULL and the offeree
        // lives in offeredTo instead (#1190) — `!task.agentId` alone used to
        // skip every offered row here, hiding this whole class of orphan.
        const holderId = status === "offered" ? task.offeredTo : task.agentId;
        if (!holderId) continue;
        const agent = agents.find((a) => a.id === holderId);
        if (!agent || agent.status === "offline") {
          orphanedTasks.push(task);
        }
      }
    }

    if (orphanedTasks.length > 0) {
      sections.push("");
      sections.push("## Orphaned Tasks [auto-generated, NEEDS ATTENTION]");
      sections.push("These tasks are pending/offered but assigned to workers that are offline:");
      for (const task of orphanedTasks) {
        const holderId = task.status === "offered" ? task.offeredTo : task.agentId;
        const agentName = agents.find((a) => a.id === holderId)?.name ?? holderId ?? "?";
        sections.push(
          `- [${task.id}] "${task.task.slice(0, 100)}" — status: ${task.status}, assigned to: ${agentName}`,
        );
      }
      sections.push("");
      sections.push("Consider re-assigning or cancelling these tasks.");
      sections.push(
        "Note: Some workers may appear offline briefly while re-registering after the restart. Wait a few minutes before acting on these — auto-assign will handle re-routing once workers come online.",
      );
    }
  }

  return sections.join("\n");
}

/**
 * Check HEARTBEAT.md content and create a checklist task for the lead if needed.
 */
export async function checkHeartbeatChecklist(): Promise<void> {
  const lead = await getLeadAgent();
  if (!lead) return;

  const heartbeatMd = lead.heartbeatMd;
  if (!heartbeatMd) return;

  if (isEffectivelyEmpty(heartbeatMd)) return;

  // Dedup: skip if lead already has an active heartbeat-checklist task
  const existing = await getDbClient().get<{ id: string }>(
    `SELECT id FROM agent_tasks
       WHERE agentId = ?
         AND taskType = 'heartbeat-checklist'
         AND status NOT IN ('completed', 'failed', 'cancelled')
       LIMIT 1`,
    [lead.id],
  );
  if (existing) return;

  const systemStatus = await gatherSystemStatus();

  const result = resolveTemplate("heartbeat.checklist", {
    system_status: systemStatus,
    heartbeat_content: heartbeatMd,
  });

  if (result.skipped) return;

  await createTaskExtended(result.text, {
    agentId: lead.id,
    routingReason: "skill",
    routingSource: "engine_default",
    taskType: "heartbeat-checklist",
    tags: ["checklist", "auto-generated"],
    priority: 60,
  });

  console.log(`[Heartbeat] Checklist task created for lead ${lead.name}`);
}

// ============================================================================
// Sweep Orchestrator
// ============================================================================

/**
 * Run a single heartbeat sweep (Tier 1 → Tier 2).
 */
export async function runHeartbeatSweep(): Promise<void> {
  if (isSweeping) {
    return; // Concurrency guard — skip if previous sweep is still running
  }
  isSweeping = true;

  try {
    // Tier 1: Preflight gate
    if (!(await preflightGate())) {
      const cleanupOnlyFindings = emptyFindings();
      // Expiry runs even on a cleanup-only tick: an idle agent whose runtime
      // stopped pinging is exactly the case the preflight gate sees as
      // "nothing actionable", and it would otherwise stay available forever.
      cleanupOnlyFindings.staleCleanup.staleRuntimes = (
        await expireStaleRuntimeInstances()
      ).expired;
      // preflightGate() already sends any tick with `stats.offered > 0` down
      // the full codeLevelTriage() path, so this cleanup-only branch only
      // runs with zero offered tasks in play — call it anyway so a task
      // offered and its offeree deleted/closed in the same idle window isn't
      // left waiting for the next actionable tick.
      cleanupOnlyFindings.staleCleanup.staleOfferedTasks =
        await releaseStaleOfferedTasksForOfflineAgents();
      await cleanupStaleResources(cleanupOnlyFindings);
      logFindings(cleanupOnlyFindings);
      return; // Nothing actionable — bail early
    }

    // Tier 2: Code-level triage
    const findings = await codeLevelTriage();

    // Log findings summary
    logFindings(findings);
  } finally {
    isSweeping = false;
  }
}

/**
 * Log a summary of heartbeat findings to console.
 */
function logFindings(findings: HeartbeatFindings): void {
  const parts: string[] = [];

  if (findings.autoFailedTasks.length > 0) {
    parts.push(`auto_failed=${findings.autoFailedTasks.length}`);
  }
  if (findings.reclaimedTasks.length > 0) {
    parts.push(`reclaimed=${findings.reclaimedTasks.length}`);
  }
  if (findings.unpinnedTasks.length > 0) {
    parts.push(`unpinned=${findings.unpinnedTasks.length}`);
  }
  if (findings.escalatedReroutes.length > 0) {
    parts.push(`escalated_reroutes=${findings.escalatedReroutes.length}`);
  }
  if (findings.stalledTasks.length > 0) {
    parts.push(`stalled=${findings.stalledTasks.length}`);
  }
  if (findings.extensionSkipped.length > 0) {
    parts.push(`extension_skipped=${findings.extensionSkipped.length}`);
  }
  if (findings.workerHealthFixes.length > 0) {
    parts.push(`health_fixes=${findings.workerHealthFixes.length}`);
  }
  if (findings.autoAssigned.length > 0) {
    parts.push(`auto_assigned=${findings.autoAssigned.length}`);
  }

  const {
    sessions,
    reviewingTasks,
    mentionProcessing,
    inboxProcessing,
    workflowRuns,
    staleOfferedTasks,
    abandonedDraftTasks,
    approvalAutoCancelled,
    approvalTimedOut,
  } = findings.staleCleanup;
  const totalCleanup =
    sessions +
    reviewingTasks +
    mentionProcessing +
    inboxProcessing +
    workflowRuns +
    approvalAutoCancelled +
    approvalTimedOut;
  if (totalCleanup > 0) {
    parts.push(`stale_cleanup=${totalCleanup}`);
  }
  if (staleOfferedTasks > 0) {
    parts.push(`stale_offers_released=${staleOfferedTasks}`);
  }
  if (abandonedDraftTasks > 0) {
    parts.push(`abandoned_drafts_promoted=${abandonedDraftTasks}`);
  }

  if (parts.length > 0) {
    console.log(`[Heartbeat] Sweep complete: ${parts.join(", ")}`);
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Start the heartbeat polling loop.
 * @param intervalMs Polling interval in milliseconds (default: 90000)
 */
export function startHeartbeat(intervalMs = defaultIntervalMs()): void {
  if (heartbeatInterval) {
    console.log("[Heartbeat] Already running");
    return;
  }

  console.log(`[Heartbeat] Starting with ${intervalMs}ms interval`);

  // First sweep shortly after boot. There is no separate reboot sweep: an API
  // restart leaves no half-written recovery state, and the regular thresholds
  // already tell a dead worker from one in a long model call. Best-effort:
  // `runHeartbeatSweep` resets `isSweeping` in a `finally` but has no `catch`,
  // so a throw anywhere inside it escapes as an unhandled rejection unless it
  // is caught here.
  setTimeout(() => {
    runHeartbeatSweep().catch((err) =>
      console.error(
        "[Heartbeat] boot sweep failed:",
        scrubSecrets(err instanceof Error ? err.message : String(err)),
      ),
    );
  }, 5000);

  heartbeatInterval = setInterval(() => {
    runHeartbeatSweep().catch((err) =>
      console.error(
        "[Heartbeat] sweep failed:",
        scrubSecrets(err instanceof Error ? err.message : String(err)),
      ),
    );
  }, intervalMs);

  // Also start the checklist interval
  startHeartbeatChecklist();
}

/**
 * Stop the heartbeat polling loop.
 */
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    isSweeping = false;
    console.log("[Heartbeat] Stopped");
  }
  stopHeartbeatChecklist();
}

/**
 * Create a one-off boot triage task for the lead after a server restart.
 * Uses the same HEARTBEAT.md content but with reboot-specific context prepended.
 */
export async function createBootTriageTask(): Promise<void> {
  const lead = await getLeadAgent();
  if (!lead) return;

  const heartbeatMd = lead.heartbeatMd ?? "";

  // Dedup: skip if lead already has an active boot-triage task
  const existing = await getDbClient().get<{ id: string }>(
    `SELECT id FROM agent_tasks
       WHERE agentId = ?
         AND taskType = 'boot-triage'
         AND status NOT IN ('completed', 'failed', 'cancelled')
       LIMIT 1`,
    [lead.id],
  );
  if (existing) return;

  const systemStatus = await gatherSystemStatus({ isBootTriage: true });

  const result = resolveTemplate("heartbeat.boot-triage", {
    system_status: systemStatus,
    heartbeat_content: isEffectivelyEmpty(heartbeatMd)
      ? "_No standing orders configured._"
      : heartbeatMd,
  });

  if (result.skipped) return;

  await createTaskExtended(result.text, {
    agentId: lead.id,
    routingReason: "skill",
    routingSource: "engine_default",
    taskType: "boot-triage",
    tags: ["boot", "triage", "auto-generated"],
    priority: 70, // Higher than regular checklist (60)
  });

  console.log(`[Heartbeat] Boot triage task created for lead ${lead.name}`);
}

/**
 * Start the heartbeat checklist polling loop (separate from the infrastructure sweep).
 */
export function startHeartbeatChecklist(intervalMs = HEARTBEAT_CHECKLIST_INTERVAL_MS): void {
  if (HEARTBEAT_CHECKLIST_DISABLE) {
    console.log("[Heartbeat] Checklist disabled via HEARTBEAT_CHECKLIST_DISABLE");
    return;
  }
  if (checklistInterval) {
    return; // Already running
  }

  console.log(`[Heartbeat] Checklist starting with ${intervalMs}ms interval`);

  // Boot triage at T+90s — after the first sweep (T+5s) has reclaimed any orphaned work
  setTimeout(() => createBootTriageTask(), 90_000);

  // Recurring checklist starts from the second interval onward
  checklistInterval = setInterval(() => {
    checkHeartbeatChecklist().catch((err) =>
      console.error(
        "[Heartbeat] checklist check failed:",
        scrubSecrets(err instanceof Error ? err.message : String(err)),
      ),
    );
  }, intervalMs);
}

/**
 * Stop the heartbeat checklist polling loop.
 */
export function stopHeartbeatChecklist(): void {
  if (checklistInterval) {
    clearInterval(checklistInterval);
    checklistInterval = null;
    console.log("[Heartbeat] Checklist stopped");
  }
}

import {
  assignUnassignedTaskPending,
  backfillSupersedeTaskResumeTaskId,
  buildRoutingAffinityFromAgent,
  cleanupStaleSessions,
  createTaskExtended,
  deleteActiveSession,
  failPendingResumeIfUnclaimed,
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
  getStalePinnedResumes,
  getStaleUnassignedAffinityTasks,
  getStalledInProgressTasks,
  getTaskById,
  getTaskStats,
  getTasksByStatus,
  getUnassignedPoolTasks,
  hasNonTerminalResumeChild,
  hasPendingSteering,
  isAgentEligibleForTask,
  isPoolAffinityEnforcementEnabled,
  MAX_EMPTY_POLLS,
  releaseStaleMentionProcessing,
  releaseStaleOfferedTasksForOfflineAgents,
  releaseStaleProcessingInbox,
  releaseStaleReviewingTasks,
  supersedeTask,
  updateAgentStatus,
} from "../be/db";
import { repointTrackerSyncBySwarmId } from "../be/db-queries/tracker";
import {
  agentsWithLiveRuntime,
  countActiveRuntimeInstancesForAgent,
  expireStaleRuntimeInstances,
} from "../be/multi-runtime";
import { promotePendingSteeringForTask } from "../be/steering";
import { resolveTemplate } from "../prompts/resolver";
import {
  createPoolStarvationDecisionTask,
  createRerouteDecisionTask,
  createResumeFollowUp,
  getNextResumeGeneration,
  getPinCandidateAgent,
  getResumeGeneration,
  REBOOT_RETRY_PIN_TAG,
} from "../tasks/worker-follow-up";
import type { AgentTask } from "../types";
import { isMultiRuntimeEnabled } from "../utils/multi-runtime";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getExecutorRegistry } from "../workflows";
import { recoverIncompleteRuns } from "../workflows/recovery";
// Side-effect import: registers heartbeat event templates in the in-memory registry
import "./templates";

/**
 * System tasks that must NOT be auto-resumed — mirrors `runRebootSweep`'s exclusion list
 * to prevent infinite retry loops on the heartbeat/triage system tasks themselves.
 *
 * `reroute-decision` is included (DES-523): it is a control-plane Lead task, not
 * user work. If a Lead crashed while holding one, auto-resuming it would create a
 * crash-recovery pin for the decision; reaping that pin would then treat the
 * decision as the `original`, producing nested reroute-decisions ABOUT the control
 * prompt instead of recovering the real work. So a crashed decision is failed, not
 * resumed (the original work was already superseded; its recovery chain is separate).
 */
const SKIP_AUTO_RESUME_TYPES = new Set([
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

/** Max crash-recovery resume generations before failing for lead triage */
export function maxResumeGenerations(): number {
  return Number(process.env.HEARTBEAT_MAX_RESUME_GENERATIONS) || 3;
}

export const RESUME_BUDGET_EXHAUSTED_REASON = "resume_budget_exhausted";

/**
 * Grace window (minutes) a crash-recovery resume pinned to its original agent
 * (DES-523 Phase 1) waits to be reclaimed before the reaper concludes the agent
 * is gone and escalates to a Lead re-delegation decision. Generous enough for a
 * slow container restart / image pull, short enough that a genuinely-gone
 * agent's work reaches the Lead promptly. Measured from the resume's `createdAt`
 * (= crash-detection time), so worst-case crash→escalation latency is
 * ~`STALL_THRESHOLD_NO_SESSION_MIN` + this. Set to `0` to disable the reaper.
 *
 * Uses `??` (not `|| 10`) so an explicit `0` is honored as "reaper off" rather
 * than coerced back to the default.
 */
export const HEARTBEAT_RESUME_PIN_GRACE_MIN = (() => {
  const raw = process.env.HEARTBEAT_RESUME_PIN_GRACE_MIN;
  if (raw === undefined) return 10;
  const parsed = Number(raw);
  // Honor an explicit `0` (reaper off), but fall back to the default on a
  // non-finite value (e.g. a typo'd `abc` → NaN). Without this guard, NaN passes
  // the `<= 0` disable check, reaches getStalePinnedResumes(NaN), and throws in
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
  autoFailedTasks: Array<{ taskId: string; agentId: string; reason: string }>;
  autoResumedTasks: Array<{
    taskId: string;
    resumeTaskId: string;
    agentId: string;
    reason: string;
  }>;
  /**
   * Crash-recovery resumes pinned back to their original (stable-ID) agent
   * instead of being released to the role-blind unassigned pool (DES-523). A
   * subset of `autoResumedTasks`: the resume `taskId` + the agent it pinned to.
   */
  pinnedResumes: Array<{ taskId: string; agentId: string }>;
  /**
   * Pinned crash-recovery resumes that were never reclaimed within the grace
   * window and were escalated to a Lead re-delegation decision (DES-523 Phase 3).
   */
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
  };
}

// ============================================================================
// State
// ============================================================================

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let checklistInterval: ReturnType<typeof setInterval> | null = null;
let isSweeping = false;
let beforeHeartbeatSupersedeForTests: ((task: AgentTask) => void | Promise<void>) | null = null;

/** Tasks auto-failed during the reboot sweep, consumed by boot triage */
let rebootAffectedTasks: Array<{ original: AgentTask; retryTaskId: string | null }> = [];

export function setBeforeHeartbeatSupersedeForTests(
  hook: ((task: AgentTask) => void | Promise<void>) | null,
): void {
  beforeHeartbeatSupersedeForTests = hook;
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
  const findings: HeartbeatFindings = {
    stalledTasks: [],
    autoFailedTasks: [],
    autoResumedTasks: [],
    pinnedResumes: [],
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
    },
  };

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

  // 1. Detect and remediate stalled tasks (tiered: auto-fail dead workers)
  await detectAndRemediateStalledTasks(findings);

  // 2. Check and fix worker health
  await checkWorkerHealth(findings);

  // 3. Auto-assign pool tasks to idle workers
  await autoAssignPoolTasks(findings);

  // 4. Cleanup stale resources (including workflow run recovery)
  await cleanupStaleResources(findings);

  return findings;
}

/**
 * Tiered stall detection and auto-remediation.
 *
 * Cross-checks stalled tasks with active_sessions to determine severity:
 * - No active session → worker is dead → auto-fail (5 min threshold)
 * - Stale session heartbeat → worker likely crashed → auto-fail (15 min threshold)
 * - Fresh session heartbeat → worker alive but task stale → escalate to lead (30 min threshold)
 */
async function detectAndRemediateStalledTasks(findings: HeartbeatFindings): Promise<void> {
  // Use the shortest threshold to catch all potentially stalled tasks
  const candidates = await getStalledInProgressTasks(stallThresholdNoSessionMin());

  for (const task of candidates) {
    if (!task.agentId) continue; // Unassigned tasks can't be stalled

    const session = await getActiveSessionForTask(task.id);
    const taskAgeMs = Date.now() - new Date(task.lastUpdatedAt).getTime();
    const sessionHeartbeatAgeMs = session
      ? Date.now() - new Date(session.lastHeartbeatAt).getTime()
      : null;
    const pendingSteering = (await hasPendingSteering(task.id))
      ? await getPendingSteeringForTask(task.id)
      : [];
    const newestPendingSteeringAt = pendingSteering.reduce<number>(
      (latest, message) => Math.max(latest, new Date(message.createdAt).getTime()),
      0,
    );
    const pendingSteeringAgeMs = Date.now() - newestPendingSteeringAt;

    if (
      newestPendingSteeringAt > 0 &&
      pendingSteeringAgeMs < STEERING_STALL_GRACE_MIN * 60 * 1000
    ) {
      continue;
    }

    if (!session) {
      // Case A: No active session — worker is dead
      if (taskAgeMs >= stallThresholdNoSessionMin() * 60 * 1000) {
        await remediateCrashedWorkerTask(findings, task, {
          supersedeReason:
            "Auto-superseded by heartbeat: worker session not found (no active session for task)",
          legacyFailReason:
            "Auto-failed by heartbeat: worker session not found (no active session for task)",
          shortLabel: "no active session",
        });
      }
    } else {
      const isStaleHeartbeat =
        sessionHeartbeatAgeMs! >= stallThresholdStaleHeartbeatMin() * 60 * 1000;

      if (isStaleHeartbeat) {
        // Case B: Session exists but heartbeat is stale — worker likely crashed
        if (taskAgeMs >= stallThresholdStaleHeartbeatMin() * 60 * 1000) {
          await remediateCrashedWorkerTask(findings, task, {
            supersedeReason:
              "Auto-superseded by heartbeat: worker session heartbeat is stale (likely crashed)",
            legacyFailReason:
              "Auto-failed by heartbeat: worker session heartbeat is stale (likely crashed)",
            shortLabel: "stale session heartbeat",
            cleanupActiveSession: true,
          });
        }
      } else {
        // Case C: Session exists and heartbeat is fresh — ambiguous
        if (taskAgeMs >= stallThresholdMinutes() * 60 * 1000) {
          findings.stalledTasks.push(task);
        }
      }
    }
  }
}

/**
 * Shared remediation for Cases A (no active session) and B (stale heartbeat) of the
 * stalled-task detector. Prefers the supersede → resume follow-up path (DES-523) so a
 * crashed worker's task gets a fresh "resume" sibling instead of being silently dropped.
 *
 * Falls back to the legacy `failTask` path when:
 *   - the task is a system task (heartbeat / boot-triage) — would loop forever,
 *   - a non-terminal child already exists — a prior sweep already created a resume,
 *   - `createResumeFollowUp` returns `workflow-skip` — workflow engine owns retries.
 */
async function remediateCrashedWorkerTask(
  findings: HeartbeatFindings,
  task: AgentTask,
  opts: {
    supersedeReason: string;
    legacyFailReason: string;
    shortLabel: string;
    cleanupActiveSession?: boolean;
  },
): Promise<void> {
  if (!task.agentId) return; // Type guard — caller already checked.

  const skipAutoResume = SKIP_AUTO_RESUME_TYPES.has(task.taskType ?? "");
  // Workflow-step tasks: skip supersede entirely so the engine's retry policy
  // owns recovery. `createResumeFollowUp` would also bail with `workflow-skip`,
  // but checking here avoids leaving the parent in `superseded` with a dangling
  // dedicated-reason `failTask` no-op chasing it.
  const isWorkflowStep = task.workflowRunStepId != null;
  // Idempotency: if a non-terminal `resume` child already exists for this
  // parent, a prior sweep already created the resume — fall back to the
  // legacy fail path. We filter on `taskType = 'resume'` specifically (not
  // any child task) because `send-task` auto-defaults `parentTaskId` to the
  // caller's current task, so a crashed worker with delegated subtasks
  // would otherwise be incorrectly skipped (PR #594 review).
  const alreadyResumed =
    !skipAutoResume && !isWorkflowStep && (await hasNonTerminalResumeChild(task.id));

  if (isWorkflowStep) {
    const failed = await failTask(task.id, "superseded_workflow_task");
    if (failed) {
      findings.autoFailedTasks.push({
        taskId: task.id,
        agentId: task.agentId,
        reason: "superseded_workflow_task",
      });
      if (opts.cleanupActiveSession) await deleteActiveSession(task.id);
      console.log(
        `[Heartbeat] Workflow-step task ${task.id.slice(0, 8)} failed — engine will handle retry (${opts.shortLabel})`,
      );
      const remaining = await getActiveTaskCount(task.agentId);
      if (remaining === 0) await restoreAgentIdleAfterRemediation(task.agentId);
    }
    return;
  }

  if (skipAutoResume || alreadyResumed) {
    const failed = await failTask(task.id, opts.legacyFailReason);
    if (failed) {
      findings.autoFailedTasks.push({
        taskId: task.id,
        agentId: task.agentId,
        reason: opts.legacyFailReason,
      });
      if (opts.cleanupActiveSession) await deleteActiveSession(task.id);
      console.log(
        `[Heartbeat] Auto-failed task ${task.id.slice(0, 8)} — ${opts.shortLabel} (${
          skipAutoResume ? "skipRetry taskType" : "resume already exists"
        })`,
      );
      const remaining = await getActiveTaskCount(task.agentId);
      if (remaining === 0) await restoreAgentIdleAfterRemediation(task.agentId);
    }
    return;
  }

  const nextResumeGeneration = getNextResumeGeneration(task);
  if (nextResumeGeneration > maxResumeGenerations()) {
    const failed = await failTask(task.id, RESUME_BUDGET_EXHAUSTED_REASON);
    if (failed) {
      findings.autoFailedTasks.push({
        taskId: task.id,
        agentId: task.agentId,
        reason: RESUME_BUDGET_EXHAUSTED_REASON,
      });
      if (opts.cleanupActiveSession) await deleteActiveSession(task.id);
      console.warn(
        `[Heartbeat] Auto-failed task ${task.id.slice(0, 8)} — ${RESUME_BUDGET_EXHAUSTED_REASON} (${opts.shortLabel})`,
      );
      const remaining = await getActiveTaskCount(task.agentId);
      if (remaining === 0) await restoreAgentIdleAfterRemediation(task.agentId);
    }
    return;
  }

  await beforeHeartbeatSupersedeForTests?.(task);

  const superseded = await supersedeTask(task.id, {
    reason: opts.supersedeReason,
    resumeTaskId: null,
  });
  if (!superseded) {
    return;
  }

  try {
    await promotePendingSteeringForTask(
      task.id,
      "Task was crash-recovered before steering was delivered",
    );
  } catch (error) {
    console.error(
      "[Heartbeat] pending steering promotion error:",
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
  }

  const resume = await createResumeFollowUp({ parentId: task.id, reason: "crash_recovery" });

  if (resume.kind === "created") {
    await backfillSupersedeTaskResumeTaskId(task.id, resume.task.id);

    findings.autoResumedTasks.push({
      taskId: task.id,
      resumeTaskId: resume.task.id,
      agentId: task.agentId,
      reason: opts.supersedeReason,
    });
    // Phase 1 (DES-523): when the resume pinned back to the original
    // (stable-ID) agent, record it so the sweep summary surfaces the pin
    // rather than a silent pool fallback. `createResumeFollowUp` sets the
    // resume's `agentId` to the original only on the crash_recovery pin path.
    if (resume.task.agentId === task.agentId) {
      findings.pinnedResumes.push({ taskId: resume.task.id, agentId: task.agentId });
      console.log(
        `[Heartbeat] Auto-superseded task ${task.id.slice(0, 8)} — pinned resume ${resume.task.id.slice(0, 8)} to original agent ${task.agentId.slice(0, 8)} (${opts.shortLabel})`,
      );
    } else {
      console.log(
        `[Heartbeat] Auto-superseded task ${task.id.slice(0, 8)} — created resume ${resume.task.id.slice(0, 8)} in unassigned pool (${opts.shortLabel})`,
      );
    }
  } else {
    const reason =
      resume.kind === "skipped"
        ? `resume_creation_skipped_${resume.reason}`
        : "resume_creation_skipped_workflow";
    const failed = await failTask(task.id, reason);
    if (failed) {
      findings.autoFailedTasks.push({
        taskId: task.id,
        agentId: task.agentId,
        reason,
      });
    }
    console.warn(
      `[Heartbeat] Task ${task.id.slice(0, 8)} failed because no resume was created (${
        resume.kind === "skipped" ? resume.reason : "workflow-skip"
      })`,
    );
  }

  if (opts.cleanupActiveSession) await deleteActiveSession(task.id);

  const remaining = await getActiveTaskCount(task.agentId);
  if (remaining === 0) await restoreAgentIdleAfterRemediation(task.agentId);
}

/**
 * Parse the API boot epoch from `globalThis.__runId` (format: `run_<epochMs>`).
 * Returns the epoch in ms, or null if missing/unparseable.
 */
export function getBootEpochMs(): number | null {
  const gs = globalThis as typeof globalThis & { __runId?: string };
  const runId = gs.__runId;
  if (!runId || typeof runId !== "string") return null;
  const match = runId.match(/^run_(\d+)$/);
  if (!match) return null;
  const epoch = Number(match[1]);
  return Number.isFinite(epoch) ? epoch : null;
}

// API and workers share the same host clock, so skew is minimal.
// 5s tolerance errs toward NOT failing a borderline-live session.
const BOOT_EPOCH_SKEW_MS = 5_000;

/**
 * Aggressive sweep that runs once after server restart.
 * Ignores age thresholds — any in_progress task with no active session is auto-failed.
 * A session is only considered "live" if it heartbeated AFTER the current API boot
 * (concurrency-safe: workers with multiple tasks keep fresh heartbeats on live ones).
 * Creates exactly one retry task per failed task via parentTaskId.
 */
export async function runRebootSweep(): Promise<void> {
  if (isSweeping) {
    console.log("[Heartbeat] Reboot sweep skipped — another sweep is running");
    return;
  }
  isSweeping = true;

  try {
    // Always reset — previous sweep data is stale after a new sweep starts
    rebootAffectedTasks = [];

    // Get ALL in_progress tasks (threshold=0 means cutoff=now, effectively all)
    const allInProgress = await getStalledInProgressTasks(0);
    if (allInProgress.length === 0) {
      console.log("[Heartbeat] Reboot sweep: no in-progress tasks found");
      return;
    }
    const reason = "Auto-failed by reboot sweep: worker session not found after server restart";

    const bootEpoch = getBootEpochMs();
    if (bootEpoch === null) {
      console.warn(
        "[Heartbeat] Reboot sweep: could not parse boot epoch from __runId — falling back to legacy session-exists check",
      );
    }

    for (const task of allInProgress) {
      if (!task.agentId) {
        console.warn(
          `[Heartbeat] Reboot sweep: skipping task ${task.id} — in_progress with no agentId`,
        );
        continue;
      }

      const session = await getActiveSessionForTask(task.id);
      if (session) {
        if (bootEpoch === null) {
          // Legacy fallback: session exists → skip (pre-fix behavior, never more aggressive)
          continue;
        }
        const sessionLastSeen = new Date(session.lastHeartbeatAt).getTime();
        if (sessionLastSeen >= bootEpoch - BOOT_EPOCH_SKEW_MS) {
          // Heartbeated after (or within skew of) this boot → genuinely live, skip
          continue;
        }
        // Pre-boot stale session → fall through to auto-fail + reboot-retry child
      }

      // Clean up pre-boot stale session before failing (if it existed)
      if (session) await deleteActiveSession(task.id);

      // Auto-fail the task
      const failed = await failTask(task.id, reason);
      if (!failed) continue;

      // Fix agent status
      if ((await getActiveTaskCount(task.agentId)) === 0) {
        await restoreAgentIdleAfterRemediation(task.agentId);
      }

      // Don't retry system-generated heartbeat tasks
      if (SKIP_AUTO_RESUME_TYPES.has(task.taskType ?? "")) {
        rebootAffectedTasks.push({ original: failed, retryTaskId: null });
        continue;
      }

      // Auto-retry: create a replacement task with parentTaskId
      let retryTaskId: string | null = null;

      // Guard: only retry if parent doesn't already have a retry child
      const existingRetry = await getDbClient().get<{ id: string }>(
        `SELECT id FROM agent_tasks
           WHERE parentTaskId = ?
             AND status NOT IN ('completed', 'failed', 'cancelled')
           LIMIT 1`,
        [task.id],
      );

      if (!existingRetry) {
        try {
          // Routing affinity (Phase 3): pin the retry child to the original
          // agent when it still looks recoverable (row exists, not offline,
          // has capacity) — the same gate `createResumeFollowUp` uses for its
          // same-agent pin. This keeps the retry off the role-blind pool
          // whenever the original worker is merely restarting. Always stamp
          // a `routingAffinity` snapshot from the original agent — even on
          // the pool-fallback leg (agent gone/offline/at-capacity) — so that
          // leg is still role/capability-gated instead of role-blind.
          let preferredAgentId: string | undefined;
          const candidate = await getPinCandidateAgent(task.agentId);
          if (candidate) {
            const activeCount = await getActiveTaskCount(candidate.id);
            const hasCap = activeCount < (candidate.maxTasks ?? 1);
            if (hasCap) {
              preferredAgentId = candidate.id;
            } else {
              console.warn(
                `[Heartbeat] Reboot retry for task ${task.id.slice(0, 8)} NOT pinned: agent ${candidate.id.slice(0, 8)} at capacity (${activeCount}/${candidate.maxTasks ?? 1}); falling back to affinity-gated pool`,
              );
            }
          }

          const tags = ["reboot-retry", "auto-generated"];
          if (preferredAgentId !== undefined) tags.push(REBOOT_RETRY_PIN_TAG);

          const retryTask = await createTaskExtended(task.task, {
            parentTaskId: task.id,
            agentId: preferredAgentId,
            tags,
            priority: task.priority,
            source: task.source,
            taskType: task.taskType ?? undefined,
            routingAffinity: (await buildRoutingAffinityFromAgent(task.agentId)) ?? undefined,
          });
          retryTaskId = retryTask.id;
          console.log(`[Heartbeat] Reboot retry created: ${retryTaskId} (parent: ${task.id})`);
        } catch (err) {
          console.error(`[Heartbeat] Failed to create retry task for ${task.id}:`, err);
        }
      }

      rebootAffectedTasks.push({ original: failed, retryTaskId });
    }

    console.log(
      `[Heartbeat] Reboot sweep complete: ${rebootAffectedTasks.length} task(s) auto-failed and retried`,
    );
  } finally {
    isSweeping = false;
  }
}

/** Get tasks affected by the most recent reboot sweep */
export function getRebootAffectedTasks() {
  return rebootAffectedTasks;
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
 * Reaper (DES-523 Phase 3): escalate crash-recovery resumes that were pinned to
 * their original agent (Phase 1) but never reclaimed within
 * `HEARTBEAT_RESUME_PIN_GRACE_MIN`. This is the ONLY path to the Lead decision —
 * "gone" can't be told from "restarting" at crash-detection time, so Phase 1
 * pins optimistically and this reaper decides "gone" once a pin demonstrably
 * fails to be reclaimed. After this runs, the heartbeat crash path never touches
 * the unassigned pool.
 *
 * Wired into `cleanupStaleResources`, so it runs on every sweep — including the
 * cleanup-only preflight-bail path and the first post-reboot sweep — and a
 * pending pin is reaped even when the system otherwise looks idle.
 */
async function escalateUnreclaimedResumes(findings: HeartbeatFindings): Promise<void> {
  // Grace 0 = reaper disabled (rollback switch).
  if (HEARTBEAT_RESUME_PIN_GRACE_MIN <= 0) return;

  const stale = await getStalePinnedResumes(HEARTBEAT_RESUME_PIN_GRACE_MIN);
  if (stale.length === 0) return;

  // A non-offline Lead is required to re-delegate. Without one (none registered,
  // or the only lead is `offline` after POST /close), leave escalation candidates
  // `pending` rather than cancel the pin and hand the decision to an agent that
  // can't poll it (which would strand the work). The budget-exhaustion path below
  // is independent of the Lead and still runs. `getLeadAgent` already prefers a
  // non-offline lead, so this also guards the createRerouteDecisionTask assignment.
  const lead = await getLeadAgent();
  const hasLead = lead != null && lead.status !== "offline";

  for (const resume of stale) {
    if (!resume.parentTaskId) continue; // Defensive — resumes always have a parent.

    // Budget guard: a resume already at the generation cap must NOT spawn another
    // Lead re-delegation (send-task does not enforce the generation tag, so a
    // flapping task could loop forever). Terminalize and stop. Atomic, so we
    // never kill a resume the agent just reclaimed in the gap.
    if (getResumeGeneration(resume) >= maxResumeGenerations()) {
      const failed = await failPendingResumeIfUnclaimed(
        resume.id,
        "failed",
        RESUME_BUDGET_EXHAUSTED_REASON,
      );
      if (failed) {
        console.warn(
          `[Heartbeat] Unreclaimed pinned resume ${resume.id.slice(0, 8)} hit the resume-generation cap — terminalized, no Lead decision`,
        );
      }
      continue;
    }

    if (!hasLead) continue; // No lead → leave the pin pending; nothing to escalate to.

    const original = await getTaskById(resume.parentTaskId);
    if (!original) continue; // Parent gone — nothing to escalate against.

    // Escalate atomically: terminalize the pin + repoint the tracker link
    // (original → R1 at pin time; R1 is now dead, so move it back so the Lead's
    // re-delegated resume inherits it via send-task) + create the Lead decision,
    // all in ONE transaction. A mid-sequence process death therefore can't leave
    // the pin cancelled with no Lead signal (which would orphan the work — it is
    // invisible to both the stall detector and this reaper afterward).
    //  - The conditional terminalize still returns null if the agent reclaimed
    //    the pin in the gap → abort with no writes and skip (TOCTOU guard).
    //  - If the decision can't be created (unexpected — hasLead is checked and a
    //    still-`pending` pin implies no prior decision), throw to roll back the
    //    cancel so the pin is retried next sweep instead of being stranded.
    let escalation: { decisionTaskId: string } | null = null;
    try {
      escalation = await getDbClient().transaction(async () => {
        const terminalized = await failPendingResumeIfUnclaimed(
          resume.id,
          "cancelled",
          "pin_unreclaimed_escalated",
        );
        if (!terminalized) return null; // reclaimed in the gap — no writes made
        await repointTrackerSyncBySwarmId(resume.id, original.id);
        const decision = await createRerouteDecisionTask({
          original,
          staleResume: resume,
          reason: "crash_recovery",
          maxGenerations: maxResumeGenerations(),
        });
        if (decision.kind !== "created") {
          throw new Error(`reroute-decision not created: ${decision.reason}`);
        }
        return { decisionTaskId: decision.task.id };
      });
    } catch (err) {
      console.warn(
        `[Heartbeat] Reroute escalation rolled back for resume ${resume.id.slice(0, 8)} — ${
          err instanceof Error ? err.message : String(err)
        }; pin left pending for the next sweep`,
      );
      continue;
    }
    if (!escalation) continue; // agent reclaimed the pin in the gap

    findings.escalatedReroutes.push({
      originalTaskId: original.id,
      decisionTaskId: escalation.decisionTaskId,
    });
    console.log(
      `[Heartbeat] Escalated unreclaimed pinned resume ${resume.id.slice(0, 8)} → Lead reroute-decision ${escalation.decisionTaskId.slice(0, 8)} (original ${original.id.slice(0, 8)})`,
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
 * the gate itself is disabled). Idempotent via the same
 * non-terminal-`reroute-decision`-child check `createPoolStarvationDecisionTask`
 * shares with `createRerouteDecisionTask`.
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
  // DES-523 Phase 3: escalate pinned crash-recovery resumes that were never
  // reclaimed within the grace window to a Lead re-delegation decision.
  await escalateUnreclaimedResumes(findings);
  // Routing-affinity Phase 3: escalate affinity-tagged pool tasks that have
  // zero eligible registered agents to a Lead re-delegation decision.
  await escalateStarvedPoolTasks(findings);
  try {
    findings.staleCleanup.workflowRuns = await recoverIncompleteRuns(getExecutorRegistry());
  } catch {
    // Workflow engine may not be initialized yet — skip recovery
    findings.staleCleanup.workflowRuns = 0;
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
    const rebootTasks = getRebootAffectedTasks();

    if (rebootTasks.length > 0) {
      sections.push("");
      sections.push("## Reboot-Interrupted Work [auto-generated, ACTION REQUIRED]");
      sections.push(
        "The following tasks were in-progress before the restart. Their workers are no longer active.",
      );
      sections.push("Each has been auto-failed and a retry task created where applicable.");
      sections.push("");

      for (const { original, retryTaskId } of rebootTasks) {
        const agentName = original.agentId
          ? (agents.find((a) => a.id === original.agentId)?.name ?? original.agentId)
          : "unassigned";
        const retryNote = retryTaskId
          ? `→ retry created: ${retryTaskId}`
          : "→ no retry (system task)";
        sections.push(
          `- [${original.id}] "${original.task.slice(0, 100)}" — was on ${agentName} ${retryNote}`,
        );
      }

      sections.push("");
      sections.push("**You MUST triage each task above:**");
      sections.push("- Verify the retry task is progressing (check via `get-task-details`)");
      sections.push("- If the retry failed or the work is no longer needed, cancel it");
      sections.push("- Do NOT mark this boot triage as complete until all items are triaged");
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
      const cleanupOnlyFindings: HeartbeatFindings = {
        stalledTasks: [],
        autoFailedTasks: [],
        autoResumedTasks: [],
        pinnedResumes: [],
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
        },
      };
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
  if (findings.autoResumedTasks.length > 0) {
    parts.push(`auto_resumed=${findings.autoResumedTasks.length}`);
  }
  if (findings.pinnedResumes.length > 0) {
    parts.push(`pinned_resumes=${findings.pinnedResumes.length}`);
  }
  if (findings.escalatedReroutes.length > 0) {
    parts.push(`escalated_reroutes=${findings.escalatedReroutes.length}`);
  }
  if (findings.stalledTasks.length > 0) {
    parts.push(`stalled=${findings.stalledTasks.length}`);
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
  } = findings.staleCleanup;
  const totalCleanup =
    sessions + reviewingTasks + mentionProcessing + inboxProcessing + workflowRuns;
  if (totalCleanup > 0) {
    parts.push(`stale_cleanup=${totalCleanup}`);
  }
  if (staleOfferedTasks > 0) {
    parts.push(`stale_offers_released=${staleOfferedTasks}`);
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

  // Run aggressive reboot sweep first (no thresholds), then normal sweep cycle.
  // Both sweeps are best-effort: `runHeartbeatSweep` resets `isSweeping` in a
  // `finally` but has no `catch`, so a throw anywhere inside it escapes as an
  // unhandled rejection unless it is caught here.
  setTimeout(() => {
    runRebootSweep()
      .then(() => runHeartbeatSweep())
      .catch((err) =>
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

  // Boot triage at T+90s — after reboot sweep (T+5s) has completed and results are available
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

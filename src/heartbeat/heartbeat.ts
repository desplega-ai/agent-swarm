import {
  claimTask,
  cleanupStaleSessions,
  createTaskExtended,
  deleteActiveSession,
  failTask,
  getActiveSessionForTask,
  getActiveTaskCount,
  getAllAgents,
  getDb,
  getIdleWorkersWithCapacity,
  getLeadAgent,
  getStalledInProgressTasks,
  getTaskStats,
  getUnassignedPoolTasks,
  releaseStaleMentionProcessing,
  releaseStaleProcessingInbox,
  releaseStaleReviewingTasks,
  updateAgentStatus,
} from "../be/db";
import { resolveTemplate } from "../prompts/resolver";
import type { AgentTask } from "../types";
import { getExecutorRegistry } from "../workflows";
import { recoverIncompleteRuns } from "../workflows/recovery";
// Side-effect import: registers heartbeat event templates in the in-memory registry
import "./templates";

// ============================================================================
// Configuration (env var overrides)
// ============================================================================

/** Default heartbeat interval: 90 seconds */
const DEFAULT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 90_000;

/** Stall threshold: tasks with fresh worker heartbeat but no task update for this many minutes */
const STALL_THRESHOLD_MINUTES = Number(process.env.HEARTBEAT_STALL_THRESHOLD_MIN) || 30;

/** Stall threshold: tasks with no active session (worker clearly dead) */
const STALL_THRESHOLD_NO_SESSION_MIN = Number(process.env.HEARTBEAT_STALL_NO_SESSION_MIN) || 5;

/** Stall threshold: tasks with stale worker heartbeat */
const STALL_THRESHOLD_STALE_HEARTBEAT_MIN = Number(process.env.HEARTBEAT_STALL_STALE_HB_MIN) || 15;

/** Stale resource cleanup threshold (minutes) */
const STALE_CLEANUP_THRESHOLD_MINUTES = Number(process.env.HEARTBEAT_STALE_CLEANUP_MIN) || 30;

/** Max pool tasks to auto-assign per sweep */
const MAX_AUTO_ASSIGN_PER_SWEEP = Number(process.env.HEARTBEAT_MAX_AUTO_ASSIGN) || 5;

/** Escalation cooldown: minimum time between escalations for the same task set (ms) */
const ESCALATION_COOLDOWN_MS =
  Number(process.env.HEARTBEAT_ESCALATION_COOLDOWN_MS) || 15 * 60 * 1000;

const HEARTBEAT_ESCALATION_MARKER = "[heartbeat-escalation]";

// ============================================================================
// Types
// ============================================================================

export interface HeartbeatFindings {
  stalledTasks: AgentTask[];
  autoFailedTasks: Array<{ taskId: string; agentId: string; reason: string }>;
  workerHealthFixes: Array<{ agentId: string; oldStatus: string; newStatus: string }>;
  autoAssigned: Array<{ taskId: string; agentId: string }>;
  staleCleanup: {
    sessions: number;
    reviewingTasks: number;
    mentionProcessing: number;
    inboxProcessing: number;
    workflowRuns: number;
  };
  escalationNeeded: boolean;
  escalationReason?: string;
}

// ============================================================================
// State
// ============================================================================

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let isSweeping = false;

/** Tracks last escalation time per escalation key to prevent spam */
const lastEscalationTime: Map<string, number> = new Map();

// ============================================================================
// Tier 1: Preflight Gate
// ============================================================================

/**
 * Quick check to determine if a full triage sweep is needed.
 * Returns true if something looks actionable, false to bail early.
 */
export function preflightGate(): boolean {
  const stats = getTaskStats();
  const agents = getAllAgents();

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
    workerHealthFixes: [],
    autoAssigned: [],
    staleCleanup: {
      sessions: 0,
      reviewingTasks: 0,
      mentionProcessing: 0,
      inboxProcessing: 0,
      workflowRuns: 0,
    },
    escalationNeeded: false,
  };

  // 1. Detect and remediate stalled tasks (tiered: auto-fail dead workers, escalate ambiguous)
  detectAndRemediateStalledTasks(findings);

  // 2. Check and fix worker health
  checkWorkerHealth(findings);

  // 3. Auto-assign pool tasks to idle workers
  autoAssignPoolTasks(findings);

  // 4. Cleanup stale resources (including workflow run recovery)
  await cleanupStaleResources(findings);

  // 5. Determine if escalation is needed
  evaluateEscalation(findings);

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
function detectAndRemediateStalledTasks(findings: HeartbeatFindings): void {
  // Use the shortest threshold to catch all potentially stalled tasks
  const candidates = getStalledInProgressTasks(STALL_THRESHOLD_NO_SESSION_MIN);

  for (const task of candidates) {
    if (!task.agentId) continue; // Unassigned tasks can't be stalled

    const session = getActiveSessionForTask(task.id);
    const taskAgeMs = Date.now() - new Date(task.lastUpdatedAt).getTime();

    if (!session) {
      // Case A: No active session — worker is dead
      if (taskAgeMs >= STALL_THRESHOLD_NO_SESSION_MIN * 60 * 1000) {
        const reason =
          "Auto-failed by heartbeat: worker session not found (no active session for task)";
        const failed = failTask(task.id, reason);
        if (failed) {
          findings.autoFailedTasks.push({ taskId: task.id, agentId: task.agentId, reason });
          console.log(`[Heartbeat] Auto-failed task ${task.id.slice(0, 8)} — no active session`);

          // Fix agent status if no other active tasks
          const remaining = getActiveTaskCount(task.agentId);
          if (remaining === 0) {
            updateAgentStatus(task.agentId, "idle");
          }
        }
      }
    } else {
      const sessionHeartbeatAgeMs = Date.now() - new Date(session.lastHeartbeatAt).getTime();
      const isStaleHeartbeat =
        sessionHeartbeatAgeMs >= STALL_THRESHOLD_STALE_HEARTBEAT_MIN * 60 * 1000;

      if (isStaleHeartbeat) {
        // Case B: Session exists but heartbeat is stale — worker likely crashed
        if (taskAgeMs >= STALL_THRESHOLD_STALE_HEARTBEAT_MIN * 60 * 1000) {
          const reason =
            "Auto-failed by heartbeat: worker session heartbeat is stale (likely crashed)";
          const failed = failTask(task.id, reason);
          if (failed) {
            findings.autoFailedTasks.push({ taskId: task.id, agentId: task.agentId, reason });
            deleteActiveSession(task.id);
            console.log(
              `[Heartbeat] Auto-failed task ${task.id.slice(0, 8)} — stale session heartbeat`,
            );

            const remaining = getActiveTaskCount(task.agentId);
            if (remaining === 0) {
              updateAgentStatus(task.agentId, "idle");
            }
          }
        }
      } else {
        // Case C: Session exists and heartbeat is fresh — ambiguous
        if (taskAgeMs >= STALL_THRESHOLD_MINUTES * 60 * 1000) {
          findings.stalledTasks.push(task);
        }
      }
    }
  }
}

/**
 * Check for agents with mismatched status vs active task count.
 * - busy with 0 active tasks → fix to idle
 * - idle with active tasks → fix to busy
 */
function checkWorkerHealth(findings: HeartbeatFindings): void {
  const agents = getAllAgents().filter((a) => a.status !== "offline");

  for (const agent of agents) {
    const activeCount = getActiveTaskCount(agent.id);

    if (agent.status === "busy" && activeCount === 0) {
      updateAgentStatus(agent.id, "idle");
      findings.workerHealthFixes.push({
        agentId: agent.id,
        oldStatus: "busy",
        newStatus: "idle",
      });
    } else if (agent.status === "idle" && activeCount > 0) {
      updateAgentStatus(agent.id, "busy");
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
 * Uses atomic claimTask() to prevent races.
 */
function autoAssignPoolTasks(findings: HeartbeatFindings): void {
  getDb().transaction(() => {
    const idleWorkers = getIdleWorkersWithCapacity();
    if (idleWorkers.length === 0) return;

    const poolTasks = getUnassignedPoolTasks(MAX_AUTO_ASSIGN_PER_SWEEP);
    if (poolTasks.length === 0) return;

    let workerIndex = 0;
    for (const task of poolTasks) {
      if (workerIndex >= idleWorkers.length) break;

      const worker = idleWorkers[workerIndex]!;
      const claimed = claimTask(task.id, worker.id);

      if (claimed) {
        findings.autoAssigned.push({ taskId: task.id, agentId: worker.id });
        // Check if this worker still has capacity for more
        const remaining = (worker.maxTasks ?? 1) - getActiveTaskCount(worker.id);
        if (remaining <= 0) {
          workerIndex++;
        }
      }
    }
  })();
}

/**
 * Call existing stale resource cleanup functions.
 */
async function cleanupStaleResources(findings: HeartbeatFindings): Promise<void> {
  findings.staleCleanup.sessions = cleanupStaleSessions(STALE_CLEANUP_THRESHOLD_MINUTES);
  findings.staleCleanup.reviewingTasks = releaseStaleReviewingTasks(
    STALE_CLEANUP_THRESHOLD_MINUTES,
  );
  findings.staleCleanup.mentionProcessing = releaseStaleMentionProcessing(
    STALE_CLEANUP_THRESHOLD_MINUTES,
  );
  findings.staleCleanup.inboxProcessing = releaseStaleProcessingInbox(
    STALE_CLEANUP_THRESHOLD_MINUTES,
  );
  try {
    findings.staleCleanup.workflowRuns = await recoverIncompleteRuns(getExecutorRegistry());
  } catch {
    // Workflow engine may not be initialized yet — skip recovery
    findings.staleCleanup.workflowRuns = 0;
  }
}

// ============================================================================
// Tier 3: Escalation
// ============================================================================

/**
 * Evaluate whether findings require escalation to a Claude session (lead agent).
 * Only escalate for ambiguous stalls (worker alive but task not updating).
 */
function evaluateEscalation(findings: HeartbeatFindings): void {
  if (findings.stalledTasks.length > 0) {
    findings.escalationNeeded = true;
    const taskIds = findings.stalledTasks.map((t) => t.id.slice(0, 8)).join(", ");
    findings.escalationReason = `${findings.stalledTasks.length} task(s) stalled with active worker (no task update for ${STALL_THRESHOLD_MINUTES}+ min): ${taskIds}`;
  }
}

/**
 * Create a triage task for the lead agent to investigate ambiguous findings.
 */
function escalateToLead(findings: HeartbeatFindings): void {
  const lead = getLeadAgent();
  if (!lead) {
    console.log("[Heartbeat] No lead agent found — skipping escalation");
    return;
  }

  const escalationKey = buildEscalationKey(findings);

  // Cooldown check — prevent repeated escalations for the same task set
  const lastTime = lastEscalationTime.get(escalationKey);
  if (lastTime && Date.now() - lastTime < ESCALATION_COOLDOWN_MS) {
    return;
  }

  if (hasActiveEscalationTask(lead.id, escalationKey)) {
    return;
  }

  // Build stalled tasks section
  let stalledTasksSection = "";
  if (findings.stalledTasks.length > 0) {
    const lines: string[] = ["## Stalled Tasks"];
    for (const task of findings.stalledTasks) {
      const agentSlice = task.agentId?.slice(0, 8) ?? "unassigned";
      lines.push(
        `- Task ${task.id.slice(0, 8)} (agent: ${agentSlice}): last updated ${task.lastUpdatedAt}`,
      );
    }
    lines.push(
      "\nCheck if these tasks are genuinely stuck or just working without calling store-progress. " +
        "If stuck, consider cancelling and reassigning.",
    );
    stalledTasksSection = lines.join("\n");
  }

  const escalationMarker = `\n${HEARTBEAT_ESCALATION_MARKER} ${escalationKey}`;

  const result = resolveTemplate("heartbeat.escalation.stalled", {
    stalled_tasks_section: stalledTasksSection,
    escalation_marker: escalationMarker,
  });

  if (result.skipped) {
    return;
  }

  createTaskExtended(result.text, {
    agentId: lead.id,
    taskType: "heartbeat",
    tags: ["heartbeat", "triage", "auto-generated"],
    priority: 70,
  });

  lastEscalationTime.set(escalationKey, Date.now());
  console.log(`[Heartbeat] Created triage task for lead ${lead.name}`);
}

function buildEscalationKey(findings: HeartbeatFindings): string {
  const stalledTaskIds = findings.stalledTasks
    .map((task) => task.id)
    .sort((a, b) => a.localeCompare(b));
  return `stalled:${stalledTaskIds.join(",")}`;
}

function hasActiveEscalationTask(leadAgentId: string, escalationKey: string): boolean {
  const existing = getDb()
    .prepare<{ id: string }, [string, string]>(
      `SELECT id FROM agent_tasks
       WHERE agentId = ?
         AND taskType = 'heartbeat'
         AND status NOT IN ('completed', 'failed', 'cancelled')
         AND task LIKE ?
       LIMIT 1`,
    )
    .get(leadAgentId, `%${HEARTBEAT_ESCALATION_MARKER} ${escalationKey}%`);

  return Boolean(existing);
}

// ============================================================================
// Sweep Orchestrator
// ============================================================================

/**
 * Run a single heartbeat sweep (Tier 1 → Tier 2 → Tier 3).
 */
export async function runHeartbeatSweep(): Promise<void> {
  if (isSweeping) {
    return; // Concurrency guard — skip if previous sweep is still running
  }
  isSweeping = true;

  try {
    // Tier 1: Preflight gate
    if (!preflightGate()) {
      const cleanupOnlyFindings: HeartbeatFindings = {
        stalledTasks: [],
        autoFailedTasks: [],
        workerHealthFixes: [],
        autoAssigned: [],
        staleCleanup: {
          sessions: 0,
          reviewingTasks: 0,
          mentionProcessing: 0,
          inboxProcessing: 0,
          workflowRuns: 0,
        },
        escalationNeeded: false,
      };
      await cleanupStaleResources(cleanupOnlyFindings);
      logFindings(cleanupOnlyFindings);
      return; // Nothing actionable — bail early
    }

    // Tier 2: Code-level triage
    const findings = await codeLevelTriage();

    // Log findings summary
    logFindings(findings);

    // Tier 3: Escalate if needed
    if (findings.escalationNeeded) {
      escalateToLead(findings);
    }
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
  if (findings.stalledTasks.length > 0) {
    parts.push(`stalled=${findings.stalledTasks.length}`);
  }
  if (findings.workerHealthFixes.length > 0) {
    parts.push(`health_fixes=${findings.workerHealthFixes.length}`);
  }
  if (findings.autoAssigned.length > 0) {
    parts.push(`auto_assigned=${findings.autoAssigned.length}`);
  }

  const { sessions, reviewingTasks, mentionProcessing, inboxProcessing, workflowRuns } =
    findings.staleCleanup;
  const totalCleanup =
    sessions + reviewingTasks + mentionProcessing + inboxProcessing + workflowRuns;
  if (totalCleanup > 0) {
    parts.push(`stale_cleanup=${totalCleanup}`);
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
export function startHeartbeat(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (heartbeatInterval) {
    console.log("[Heartbeat] Already running");
    return;
  }

  console.log(`[Heartbeat] Starting with ${intervalMs}ms interval`);

  // Run initial sweep after a short delay (let server fully start)
  setTimeout(() => runHeartbeatSweep(), 5000);

  heartbeatInterval = setInterval(() => {
    runHeartbeatSweep();
  }, intervalMs);
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
}

/**
 * Reset escalation cooldown state. Exported for testing only.
 */
export function resetEscalationCooldowns(): void {
  lastEscalationTime.clear();
}

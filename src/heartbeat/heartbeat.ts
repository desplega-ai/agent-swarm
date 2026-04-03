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
  getRecentCompletedCount,
  getRecentFailedCount,
  getRecentFailedTasks,
  getStalledInProgressTasks,
  getTaskStats,
  getTasksByStatus,
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
  workerHealthFixes: Array<{ agentId: string; oldStatus: string; newStatus: string }>;
  autoAssigned: Array<{ taskId: string; agentId: string }>;
  staleCleanup: {
    sessions: number;
    reviewingTasks: number;
    mentionProcessing: number;
    inboxProcessing: number;
    workflowRuns: number;
  };
}

// ============================================================================
// State
// ============================================================================

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let checklistInterval: ReturnType<typeof setInterval> | null = null;
let isSweeping = false;

/** Tasks auto-failed during the reboot sweep, consumed by boot triage */
let rebootAffectedTasks: Array<{ original: AgentTask; retryTaskId: string | null }> = [];

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
  };

  // 1. Detect and remediate stalled tasks (tiered: auto-fail dead workers)
  detectAndRemediateStalledTasks(findings);

  // 2. Check and fix worker health
  checkWorkerHealth(findings);

  // 3. Auto-assign pool tasks to idle workers
  autoAssignPoolTasks(findings);

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
 * Aggressive sweep that runs once after server restart.
 * Ignores age thresholds — any in_progress task with no active session is auto-failed.
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
    const allInProgress = getStalledInProgressTasks(0);
    if (allInProgress.length === 0) {
      console.log("[Heartbeat] Reboot sweep: no in-progress tasks found");
      return;
    }
    const reason = "Auto-failed by reboot sweep: worker session not found after server restart";

    for (const task of allInProgress) {
      if (!task.agentId) {
        console.warn(
          `[Heartbeat] Reboot sweep: skipping task ${task.id} — in_progress with no agentId`,
        );
        continue;
      }

      const session = getActiveSessionForTask(task.id);
      if (session) continue; // Session exists — worker might still be alive, skip

      // Auto-fail the task
      const failed = failTask(task.id, reason);
      if (!failed) continue;

      // Fix agent status
      if (getActiveTaskCount(task.agentId) === 0) {
        updateAgentStatus(task.agentId, "idle");
      }

      // Don't retry system-generated heartbeat tasks
      const skipRetryTypes = ["heartbeat-checklist", "boot-triage", "heartbeat"];
      if (skipRetryTypes.includes(task.taskType ?? "")) {
        rebootAffectedTasks.push({ original: failed, retryTaskId: null });
        continue;
      }

      // Auto-retry: create a replacement task with parentTaskId
      let retryTaskId: string | null = null;

      // Guard: only retry if parent doesn't already have a retry child
      const existingRetry = getDb()
        .prepare<{ id: string }, [string]>(
          `SELECT id FROM agent_tasks
           WHERE parentTaskId = ?
             AND status NOT IN ('completed', 'failed', 'cancelled')
           LIMIT 1`,
        )
        .get(task.id);

      if (!existingRetry) {
        try {
          const retryTask = createTaskExtended(task.task, {
            parentTaskId: task.id,
            tags: ["reboot-retry", "auto-generated"],
            priority: task.priority,
            source: task.source,
            taskType: task.taskType ?? undefined,
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
export function gatherSystemStatus(options?: { isBootTriage?: boolean }): string {
  const stats = getTaskStats();
  const stalledTasks = getStalledInProgressTasks(STALL_THRESHOLD_MINUTES);
  const agents = getAllAgents();
  const idleWorkers = getIdleWorkersWithCapacity();
  const poolTasks = getUnassignedPoolTasks(10);
  const recentCompleted = getRecentCompletedCount(24);
  const recentFailedCount = getRecentFailedCount(24);

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
  const recentFailures = getRecentFailedTasks(6);
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
      const tasks = getTasksByStatus(status);

      for (const task of tasks) {
        if (!task.agentId) continue;
        const agent = agents.find((a) => a.id === task.agentId);
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
        const agentName = agents.find((a) => a.id === task.agentId)?.name ?? task.agentId ?? "?";
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
  const lead = getLeadAgent();
  if (!lead) return;

  const heartbeatMd = lead.heartbeatMd;
  if (!heartbeatMd) return;

  if (isEffectivelyEmpty(heartbeatMd)) return;

  // Dedup: skip if lead already has an active heartbeat-checklist task
  const existing = getDb()
    .prepare<{ id: string }, [string]>(
      `SELECT id FROM agent_tasks
       WHERE agentId = ?
         AND taskType = 'heartbeat-checklist'
         AND status NOT IN ('completed', 'failed', 'cancelled')
       LIMIT 1`,
    )
    .get(lead.id);
  if (existing) return;

  const systemStatus = gatherSystemStatus();

  const result = resolveTemplate("heartbeat.checklist", {
    system_status: systemStatus,
    heartbeat_content: heartbeatMd,
  });

  if (result.skipped) return;

  createTaskExtended(result.text, {
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
      };
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

  // Run aggressive reboot sweep first (no thresholds), then normal sweep cycle
  setTimeout(async () => {
    await runRebootSweep();
    runHeartbeatSweep();
  }, 5000);

  heartbeatInterval = setInterval(() => {
    runHeartbeatSweep();
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
  const lead = getLeadAgent();
  if (!lead) return;

  const heartbeatMd = lead.heartbeatMd ?? "";

  // Dedup: skip if lead already has an active boot-triage task
  const existing = getDb()
    .prepare<{ id: string }, [string]>(
      `SELECT id FROM agent_tasks
       WHERE agentId = ?
         AND taskType = 'boot-triage'
         AND status NOT IN ('completed', 'failed', 'cancelled')
       LIMIT 1`,
    )
    .get(lead.id);
  if (existing) return;

  const systemStatus = gatherSystemStatus({ isBootTriage: true });

  const result = resolveTemplate("heartbeat.boot-triage", {
    system_status: systemStatus,
    heartbeat_content: isEffectivelyEmpty(heartbeatMd)
      ? "_No standing orders configured._"
      : heartbeatMd,
  });

  if (result.skipped) return;

  createTaskExtended(result.text, {
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
    checkHeartbeatChecklist();
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

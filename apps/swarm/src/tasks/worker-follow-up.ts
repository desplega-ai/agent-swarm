import {
  createTaskExtended,
  getActiveTaskCount,
  getAgentById,
  getDependentTasks,
  getLeadAgent,
  getTaskAttachments,
  getTaskById,
  hasNonTerminalRerouteDecisionChild,
} from "../be/db";
import { repointTrackerSyncBySwarmId } from "../be/db-queries/tracker";
import { resolveTemplate } from "../prompts/resolver";
import type { AgentTask, ResumeReason, TaskAttachment } from "../types";
// Side-effect import: registers task lifecycle templates in the in-memory registry.
import "../tools/templates";

/**
 * Liveness window (seconds) for considering a worker "online" enough to
 * pre-assign a resume task. Defaults to 30s; override via env. The worker
 * heartbeats `lastActivityAt` on its agent row at least once per
 * provider tool-call / poll tick, so 30s comfortably covers a healthy worker.
 */
export const WORKER_LIVENESS_WINDOW_SECONDS = Number(
  process.env.WORKER_LIVENESS_WINDOW_SECONDS || "30",
);

/**
 * Rollback switch (DES-523) for the same-agent crash-recovery pin. ON by
 * default: `crash_recovery` resumes pin back to their original agent regardless
 * of `lastActivityAt` freshness. Set `HEARTBEAT_PIN_CRASH_RESUME=0` to restore
 * the pre-DES-523 behavior verbatim — `crash_recovery` then requires the 30s
 * `fresh` window like every other reason, so at the ~5-min detection mark it
 * falls back to the unassigned pool. A reversible kill-switch for this
 * production crash-path change (no code revert needed if the pin misbehaves).
 */
export const HEARTBEAT_PIN_CRASH_RESUME = process.env.HEARTBEAT_PIN_CRASH_RESUME !== "0";

export const RESUME_GENERATION_TAG_PREFIX = "resume-generation:";

/**
 * Tag set ONLY on a genuine same-agent `crash_recovery` pin (i.e. when the
 * resume is actually assigned back to the original agent). The heartbeat reaper
 * (`getStalePinnedResumes`) scopes its sweep to this tag so it cannot mistake a
 * *pooled* resume that `autoAssignPoolTasks` later flips to `pending` — which
 * keeps its original `createdAt` and would otherwise look identical to a stale
 * pin — for an unreclaimed crash pin, and so it never escalates a
 * `context_limits` / `manual_supersede` pin under a `crash_recovery` label.
 *
 * The literal is duplicated in `getStalePinnedResumes` (src/be/db.ts) rather
 * than imported, to avoid a worker-follow-up ↔ db import cycle — keep them in sync.
 */
export const CRASH_RECOVERY_PIN_TAG = "crash-recovery-pin";

export function getResumeGeneration(task: Pick<AgentTask, "tags">): number {
  const tag = task.tags.find((value) => value.startsWith(RESUME_GENERATION_TAG_PREFIX));
  if (!tag) return 0;

  const parsed = Number(tag.slice(RESUME_GENERATION_TAG_PREFIX.length));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function getNextResumeGeneration(parent: Pick<AgentTask, "tags">): number {
  return getResumeGeneration(parent) + 1;
}

function attachmentPointer(a: TaskAttachment): string {
  switch (a.kind) {
    case "url":
      return a.url ?? "";
    case "page":
      return `page:${a.pageId ?? ""}`;
    case "agent-fs":
      return `agent-fs:${a.path ?? ""}`;
    case "shared-fs":
      return `shared-fs:${a.path ?? ""}`;
  }
}

function formatAttachmentsBlock(attachments: TaskAttachment[]): string {
  if (attachments.length === 0) return "";
  const lines = attachments.map((a) => {
    const tag = a.isPrimary ? "[primary] " : "";
    const intent = a.intent ? ` (intent: ${a.intent})` : "";
    return `- ${tag}${a.name} - ${attachmentPointer(a)}${intent}`;
  });
  return `\n\nAttachments (${attachments.length}):\n${lines.join("\n")}`;
}

export function createWorkerTaskFollowUp(args: {
  task: AgentTask;
  status: "completed" | "failed";
  output?: string;
  failureReason?: string;
}): AgentTask | null {
  const { task, status, output, failureReason } = args;

  if (task.workflowRunId) return null;
  if (task.followUpConfig?.disabled === true) return null;

  const taskAgent = getAgentById(task.agentId ?? "");
  if (!taskAgent || taskAgent.isLead) return null;

  const leadAgent = getLeadAgent();
  if (!leadAgent) return null;

  const agentName = taskAgent.name || task.agentId?.slice(0, 8) || "Unknown";
  const taskDesc = task.task.slice(0, 200);
  const creatorAgent = task.creatorAgentId
    ? `${task.creatorAgentId}${task.creatorAgentId === leadAgent.id ? " (you)" : ""}`
    : "<none>";
  const instructions =
    status === "completed"
      ? (task.followUpConfig?.onCompleted ?? "")
      : (task.followUpConfig?.onFailed ?? "");
  const followUpInstructions = instructions
    ? `\nAdditional instructions from the task creator:\n${instructions}\n`
    : "";

  let followUpDescription: string;
  if (status === "completed") {
    const attachmentsBlock = formatAttachmentsBlock(getTaskAttachments(task.id));
    const outputSummary = output
      ? `${output.slice(0, 500)}${output.length > 500 ? "..." : ""}${attachmentsBlock}`
      : `(no output)${attachmentsBlock}`;
    const completedResult = resolveTemplate("task.worker.completed", {
      agent_name: agentName,
      task_desc: taskDesc,
      creator_agent: creatorAgent,
      output_summary: outputSummary,
      follow_up_instructions: followUpInstructions,
      task_id: task.id,
    });
    followUpDescription = completedResult.text;
  } else {
    const reason = failureReason || "(no reason given)";
    const failedResult = resolveTemplate("task.worker.failed", {
      agent_name: agentName,
      task_desc: taskDesc,
      creator_agent: creatorAgent,
      failure_reason: reason,
      follow_up_instructions: followUpInstructions,
      task_id: task.id,
    });
    followUpDescription = failedResult.text;

    // Enrich with cascade info: list dependents that were cascade-failed.
    const cascadedDeps = getDependentTasks(task.id, { includeTerminal: true }).filter(
      (t) => t.status === "failed" && t.failureReason?.includes("Blocked dependency"),
    );
    if (cascadedDeps.length > 0) {
      const depLines = cascadedDeps.map(
        (d) => `- ${d.id.slice(0, 8)} — "${d.task.slice(0, 100)}" (${d.failureReason})`,
      );
      followUpDescription += `\n\n⚠️ Cascade impact: ${cascadedDeps.length} dependent task(s) were also failed because they depend on this task:\n${depLines.join("\n")}`;
    }
  }

  return createTaskExtended(followUpDescription, {
    agentId: leadAgent.id,
    source: "system",
    taskType: "follow-up",
    parentTaskId: task.id,
    slackChannelId: task.slackChannelId,
    slackThreadTs: task.slackThreadTs,
    slackUserId: task.slackUserId,
  });
}

/** Result of `createResumeFollowUp`. */
export type CreateResumeFollowUpResult =
  | { kind: "created"; task: AgentTask }
  | { kind: "workflow-skip"; stepId: string }
  | { kind: "skipped"; reason: "parent_not_found" | "lead_not_found" };

/**
 * Create a "resume" follow-up task for a parent that is being superseded
 * (graceful shutdown, context-limit pressure, manual operator action).
 *
 * Workflow carve-out: if the parent is a workflow step (`workflowRunStepId`
 * is set), no follow-up is created. Returns `{ kind: 'workflow-skip', stepId }`
 * so the caller can `failTask(parent.id, 'superseded_workflow_task')` and let
 * the workflow engine's retry/failure policy take over.
 *
 * Field inheritance is transitive via `createTaskExtended`'s `parentTaskId`
 * lookup (`dir`, `vcsRepo`/`vcsProvider`/etc., `outputSchema`, Slack/AgentMail
 * context, `requestedByUserId`, `contextKey`, `followUpConfig`). This was chosen
 * over re-listing fields here so there is a single source of truth.
 *
 * `model` is intentionally NOT inherited: a resume task is routinely claimed by
 * a different worker (and thus a different harness/provider) than the parent, so
 * carrying the parent's concrete provider-specific model would break the child
 * at session-init. The resume task runs on the assignee agent's own model. See
 * the `model` carve-out comment in `createTaskExtended` (`src/be/db.ts`).
 *
 * Routing: the parent's assigned worker (`parent.agentId`) is preferred when
 * the agent row still exists, is not `offline`, and has remaining capacity
 * (`getActiveTaskCount < agent.maxTasks`). For `crash_recovery` the pin holds
 * regardless of `lastActivityAt` freshness — the agent ID is stable across a
 * restart and the crashed row survives intact, so a stale `lastActivityAt` at
 * the ~5-min crash-detection mark means "restarting", not "gone". Pinning keeps
 * the resume off the role-blind unassigned pool so no wrong-specialization
 * worker can grab it (DES-523). For `context_limits` / `manual_supersede` the
 * worker is alive, so `lastActivityAt` freshness is still required. The resume
 * falls back to the unassigned pool only when the agent is genuinely gone
 * (graceful close → `offline`) or its row is absent.
 *
 * Gone-agent / never-reclaimed case: a pin whose agent never returns is NOT
 * re-pooled — the heartbeat's stale-resume reaper (`escalateUnreclaimedResumes`
 * in `src/heartbeat/heartbeat.ts`) escalates it to a Lead re-delegation decision
 * once `HEARTBEAT_RESUME_PIN_GRACE_MIN` lapses.
 *
 * The pin itself is gated by `HEARTBEAT_PIN_CRASH_RESUME` (default on); set it to
 * `0` to restore the pre-DES-523 pool-fallback behavior.
 */
export function createResumeFollowUp(args: {
  parentId: string;
  reason: ResumeReason;
}): CreateResumeFollowUpResult {
  const parent = getTaskById(args.parentId);
  if (!parent) return { kind: "skipped", reason: "parent_not_found" };

  // Workflow carve-out — let the engine's retry policy handle recovery.
  if (parent.workflowRunStepId) {
    return { kind: "workflow-skip", stepId: parent.workflowRunStepId };
  }

  // Routing decision — same DB process so the read-then-create window is small.
  //
  // For `graceful_shutdown`, force the unassigned-pool path: the parent worker
  // is exiting and will call `closeAgent` (→ offline) moments after the
  // supersede loop. At this check it still looks fresh + has capacity (it just
  // terminal-transitioned), so the liveness branch would pin the resume to a
  // dying worker — orphaning it in `pending` once the worker closes. Pool
  // routing lets any live worker claim it.
  //
  // For `crash_recovery`, deliberately PIN to the same (stable-ID) agent even
  // when `lastActivityAt` is stale. This REVERSES the prior "let staleness pool
  // it" behavior: crash detection only fires after STALL_THRESHOLD_NO_SESSION_MIN
  // (~5 min), by which point a healthy-but-restarting worker is always >30s
  // stale, so the old `fresh` gate dumped every crash resume into the role-blind
  // pool where a wrong-specialization worker could grab it (DES-523). The agent
  // ID is stable across restart and the crashed row survives intact, so here
  // "stale" means "restarting", not "gone". We KEEP the `offline` guard — only a
  // graceful close sets `offline`, i.e. genuinely gone → pool — and the capacity
  // guard. An unreclaimed pin is escalated to a Lead decision by the heartbeat
  // reaper, never silently re-pooled.
  //
  // Brittleness note: this relies on a hard crash NEVER marking the agent
  // `offline` (only `POST /close` does). If future code offlines stale agents
  // before remediation, this re-opens the pool path for `crash_recovery` —
  // revisit the gate then.
  //
  //   - `context_limits` / `manual_supersede`: the worker is alive and
  //     responsive, so keep requiring `fresh`.
  let preferredAgentId: string | undefined;
  if (parent.agentId && args.reason !== "graceful_shutdown") {
    const candidate = getAgentById(parent.agentId);
    if (candidate && candidate.status !== "offline") {
      const lastActivity = candidate.lastActivityAt ? Date.parse(candidate.lastActivityAt) : 0;
      const fresh =
        Number.isFinite(lastActivity) &&
        Date.now() - lastActivity < WORKER_LIVENESS_WINDOW_SECONDS * 1000;
      const activeCount = getActiveTaskCount(candidate.id);
      const hasCap = activeCount < (candidate.maxTasks ?? 1);
      const isCrashRecovery = args.reason === "crash_recovery" && HEARTBEAT_PIN_CRASH_RESUME;
      // crash_recovery pins regardless of `fresh` (unless the rollback switch is
      // off); other reasons still require it.
      if (hasCap && (isCrashRecovery || fresh)) {
        preferredAgentId = candidate.id;
      } else if (isCrashRecovery && !hasCap) {
        // The only reason a crash_recovery pin is skipped here is capacity —
        // surface the pool fallback instead of letting it happen silently.
        console.warn(
          `[Heartbeat] crash_recovery resume for task ${parent.id.slice(0, 8)} NOT pinned: agent ${candidate.id.slice(0, 8)} at capacity (${activeCount}/${candidate.maxTasks ?? 1}); falling back to unassigned pool`,
        );
      }
    }
  }

  const parentDesc = parent.task.slice(0, 200);
  const followUpDescription = [
    "Resume interrupted task.",
    "",
    `Parent task: ${parentDesc}`,
    "",
    `Reason: ${args.reason}`,
    "",
    "The full prior context (description, recent tool calls, artifacts) is",
    "prepended to this prompt at dispatch time via the resume context preamble.",
    "Do NOT redo work already completed — extend it.",
  ].join("\n");

  const priority = Math.min(100, (parent.priority ?? 50) + 10);
  const tags = [
    "auto-resume",
    `reason:${args.reason}`,
    `${RESUME_GENERATION_TAG_PREFIX}${getNextResumeGeneration(parent)}`,
  ];
  // Mark a GENUINE same-agent crash pin (crash_recovery that actually pinned to
  // the original agent) so the heartbeat reaper can scope to these only. A
  // pooled resume — including a crash_recovery resume that fell to the pool at
  // capacity — never gets this tag, so it can't be mistaken for a stale pin
  // after autoAssignPoolTasks flips it to `pending`.
  if (args.reason === "crash_recovery" && preferredAgentId !== undefined) {
    tags.push(CRASH_RECOVERY_PIN_TAG);
  }

  // Identity-shaped fields (dir, VCS provider/repo/number/url/etc.,
  // outputSchema, slack channel/thread/user, agentmail, mention, contextKey,
  // requestedByUserId, followUpConfig) are auto-inherited from the parent by
  // `createTaskExtended`'s parentTaskId block (see src/be/db.ts). `model` is
  // deliberately excluded there so the resume task resolves to the claiming
  // agent's own provider/model — never the parent's concrete model string.
  // We only override what's SPECIFIC to the resume task here.
  const created = createTaskExtended(followUpDescription, {
    agentId: preferredAgentId,
    creatorAgentId: parent.creatorAgentId,
    source: "system",
    taskType: "resume",
    tags,
    priority,
    parentTaskId: parent.id,
  });

  // Repoint Linear / Jira `tracker_sync` rows from the (now terminal) parent
  // to the resume child. Without this, outbound completion posts for the
  // resume task can't find their tracker_sync row, and subsequent inbound
  // webhooks load the terminal parent and create duplicate tasks.
  //
  // Safe to call when no tracker_sync rows exist for this parent (no-op).
  // Covers all providers (Linear AND Jira) and entity types in one call.
  const repointed = repointTrackerSyncBySwarmId(parent.id, created.id);
  if (repointed > 0) {
    console.log(
      `[ResumeFollowUp] Repointed ${repointed} tracker_sync row(s) from ${parent.id.slice(0, 8)} → ${created.id.slice(0, 8)}`,
    );
  }

  return { kind: "created", task: created };
}

/** Result of `createRerouteDecisionTask`. */
export type CreateRerouteDecisionResult =
  | { kind: "created"; task: AgentTask }
  | { kind: "skipped"; reason: "lead_not_found" | "duplicate_exists" };

/**
 * Hand the Lead a re-delegation DECISION task for a crash-recovery resume that
 * was pinned to its original agent but never reclaimed within the grace window
 * (DES-523). The Lead receives context — the crashed agent's identity + the
 * original work — and must re-dispatch via `send-task` with an explicit
 * `agentId`; it does NOT execute the work itself, and the work is never
 * re-pooled. Mirrors `createWorkerTaskFollowUp`'s Lead-owned-follow-up shape.
 *
 * Invoked by the heartbeat reaper (`escalateUnreclaimedResumes`), NOT at crash
 * time: "gone" can't be distinguished from "restarting" at detection time, so
 * the Lead path is only reached after a pin has demonstrably failed to be
 * reclaimed.
 *
 * Discriminator: `taskType: "reroute-decision"` (NOT "follow-up") so it is
 * distinguishable from ordinary completion follow-ups for dedup and so the
 * `send-task` Slack re-delegation guard (which only fires for `taskType ===
 * "follow-up"`) never blocks the Lead's re-dispatch.
 *
 * Idempotent: skips when a non-terminal reroute-decision child already exists
 * for the original. No lead → no-op (fail-safe), mirroring
 * `createWorkerTaskFollowUp`.
 *
 * @param staleResume the failed pinned resume (R1). The generation budget for
 *   the Lead's re-dispatch is derived from it (`gen(R1)+1`), NOT from the root
 *   `original` (which carries no resume-generation tag and would reset to 1
 *   every escalation cycle, defeating MAX_RESUME_GENERATIONS via the Lead path).
 * @param maxGenerations passed in (rather than imported from heartbeat.ts) to
 *   avoid a circular import — heartbeat.ts already imports this module.
 */
export function createRerouteDecisionTask(args: {
  original: AgentTask;
  staleResume: AgentTask;
  reason: ResumeReason;
  maxGenerations: number;
}): CreateRerouteDecisionResult {
  const { original, staleResume, reason, maxGenerations } = args;

  const leadAgent = getLeadAgent();
  if (!leadAgent) return { kind: "skipped", reason: "lead_not_found" };

  // Idempotency: a prior sweep may already have escalated this original.
  if (hasNonTerminalRerouteDecisionChild(original.id)) {
    return { kind: "skipped", reason: "duplicate_exists" };
  }

  const crashedAgent = original.agentId ? getAgentById(original.agentId) : null;
  const agentName = crashedAgent?.name || original.agentId?.slice(0, 8) || "unknown";
  const identitySlice = crashedAgent?.identityMd
    ? `${crashedAgent.identityMd.slice(0, 500)}${crashedAgent.identityMd.length > 500 ? "..." : ""}`
    : "(no identity recorded)";
  const attachmentsBlock = formatAttachmentsBlock(getTaskAttachments(original.id));

  const decision = resolveTemplate("task.reroute.decision", {
    original_agent_name: agentName,
    original_agent_identity: identitySlice,
    original_task_id: original.id,
    reason,
    task_desc: original.task.slice(0, 200),
    // Derive from the FAILED PIN (staleResume), not `original` (the root with no
    // generation tag) — otherwise every escalation resets to gen 1 and the
    // MAX_RESUME_GENERATIONS cap is never reached on the Lead path.
    generation_next: getNextResumeGeneration(staleResume),
    max_generations: maxGenerations,
    artifacts_block: attachmentsBlock,
  });

  // Lead-owned `pending` decision task (createTaskExtended derives `pending`
  // from a set agentId). Slack/VCS/etc. context is inherited from the original
  // via parentTaskId. taskType is the distinct "reroute-decision" marker.
  const created = createTaskExtended(decision.text, {
    agentId: leadAgent.id,
    creatorAgentId: original.creatorAgentId,
    source: "system",
    taskType: "reroute-decision",
    tags: ["reroute-decision"],
    priority: Math.min(100, (original.priority ?? 50) + 10),
    parentTaskId: original.id,
    // Inherit Slack/VCS context from the original, but NOT its outputSchema: this
    // is a control-plane task the Lead completes by re-delegating via send-task,
    // not by producing the original work's structured output. Inheriting it would
    // make store-progress reject the Lead's completion and strand the decision
    // (blocking further escalation via the duplicate-decision guard) — DES-523.
    inheritParentOutputSchema: false,
  });

  return { kind: "created", task: created };
}

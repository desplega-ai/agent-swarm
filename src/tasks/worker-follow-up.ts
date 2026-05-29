import {
  createTaskExtended,
  getActiveTaskCount,
  getAgentById,
  getLeadAgent,
  getTaskAttachments,
  getTaskById,
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
 * Field inheritance is explicit (`model`, `dir`, `vcsRepo`, `vcsProvider`).
 * Other fields (`slackChannelId`, `slackThreadTs`, `slackUserId`,
 * `agentmailInboxId`, `agentmailThreadId`, `requestedByUserId`, `contextKey`)
 * are inherited transitively by `createTaskExtended` via the `parentTaskId`
 * lookup at `src/be/db.ts:2614-2640`. This was chosen over modifying
 * `createTaskExtended`'s central inheritance list to avoid regressing other
 * follow-up flows.
 *
 * Routing: the parent's assigned worker (`parent.agentId`) is preferred if
 * its `lastActivityAt` is within `WORKER_LIVENESS_WINDOW_SECONDS` AND it has
 * remaining capacity (`getActiveTaskCount < agent.maxTasks`). Otherwise the
 * resume task goes to the unassigned pool for any worker to pick up.
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

  // Routing decision — same DB process so the read-then-create window is
  // small. Acceptable for v1 per the plan (the unassigned-pool fallback
  // covers the race anyway).
  //
  // For `graceful_shutdown` specifically, force the unassigned-pool path:
  // the parent worker is exiting and will call `closeAgent` (→ offline)
  // moments after the supersede loop. At the moment of this check it
  // still looks fresh + has capacity (the parent just terminal-
  // transitioned), so the liveness branch would assign the resume task to
  // a dying worker — leaving it orphaned in `pending` once the worker
  // closes. Pool routing lets any live worker claim it.
  //
  // Other reasons keep the liveness-aware routing:
  //   - `crash_recovery`: parent worker is presumed dead → `lastActivityAt`
  //     is stale or `status === "offline"`, so the existing check already
  //     rejects it naturally.
  //   - `context_limits` / `manual_supersede`: the worker is alive and
  //     can keep handling the resume task on a fresh session.
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
      if (fresh && hasCap) {
        preferredAgentId = candidate.id;
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
  const tags = ["auto-resume", `reason:${args.reason}`];

  // Identity-shaped fields (model, dir, VCS provider/repo/number/url/etc.,
  // outputSchema, slack channel/thread/user, agentmail, mention, contextKey,
  // requestedByUserId, followUpConfig) are auto-inherited from the parent by
  // `createTaskExtended`'s parentTaskId block (see src/be/db.ts ~line 2722).
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

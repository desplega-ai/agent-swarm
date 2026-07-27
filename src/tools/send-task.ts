import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { AssetKeyAuthorizationError, authorizeAssetKeyWrite } from "@/be/asset-key-auth";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import {
  createTaskExtended,
  findCompletedTaskInThread,
  findExistingLinearTrackerContextWork,
  findRecentCancelledTaskInThread,
  getActiveTaskCount,
  getAgentById,
  getDb,
  getTaskById,
  hasCapacity,
  resolveEffectiveTaskOptions,
} from "@/be/db";
import { repointTrackerSyncBySwarmId } from "@/be/db-queries/tracker";
import { createEvent } from "@/be/events";
import { backfillTraceTaskId, insertRoutingTrace } from "@/be/routing-trace-db";
import { buildRoutingCtx } from "@/routing/ctx";
import { runBeforeAssign } from "@/routing/engine";
import { validateRoutingAssignTarget } from "@/routing/target";
import { applyRoutingDecisionToOptions } from "@/tasks/create-task-routed";
import { checkSlackRoutingCoherence } from "@/tasks/slack-routing";
import { createRoutingBlockDecisionTask } from "@/tasks/worker-follow-up";
import { findDuplicateTask } from "@/tools/task-dedup";
import { ownerCtx, type ToolCtx } from "@/tools/task-tool-ctx";
import { createToolRegistrar } from "@/tools/utils";
import {
  type AgentTask,
  AgentTaskSchema,
  AssetKeySchema,
  FollowUpConfigSchema,
  ModelTierSchema,
  ReasoningEffortSchema,
  splitLegacyModelAlias,
} from "@/types";
import { workflowEventBus } from "@/workflows/event-bus";

export const sendTaskInputSchema = z
  .object({
    agentId: z
      .uuid()
      .optional()
      .describe("The agent to assign/offer task to. Omit to create unassigned task for pool."),
    task: z.string().min(1).describe("The task description to send."),
    key: AssetKeySchema.optional().describe(
      "Logical namespace key. Child tasks inherit their parent namespace when provided.",
    ),
    offerMode: z
      .boolean()
      .default(false)
      .describe("If true, offer the task instead of direct assign (agent must accept/reject)."),
    taskType: z
      .string()
      .max(50)
      .optional()
      .describe("Task type (e.g., 'bug', 'feature', 'review')."),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tags for filtering (e.g., ['urgent', 'frontend'])."),
    requiredCapabilities: z
      .array(z.string())
      .optional()
      .describe(
        "Capabilities a claiming agent must have (declared via join-swarm/update-profile) to be pool-eligible for this task. Written into the created task's routingAffinity (role is left unset — only enforced when the pool auto-claim/claim-tool paths check it). Most useful when omitting agentId (unassigned pool task); a no-op for a task with an explicit agentId, which bypasses the pool gate entirely.",
      ),
    priority: z.number().int().min(0).max(100).optional().describe("Priority 0-100 (default: 50)."),
    dependsOn: z.array(z.uuid()).optional().describe("Task IDs this task depends on."),
    parentTaskId: z
      .uuid()
      .optional()
      .describe(
        "Parent task ID for session continuity. Child task will resume the parent's Claude session. Auto-routes to the same worker unless agentId is explicitly provided.",
      ),
    dir: z
      .string()
      .min(1)
      .startsWith("/")
      .optional()
      .describe(
        "Working directory (absolute path) for the agent to start in. If the directory doesn't exist, falls back to the default working directory.",
      ),
    vcsRepo: z
      .string()
      .optional()
      .describe(
        "VCS repo identifier (e.g., 'desplega-ai/agent-swarm' for GitHub or 'group/project' for GitLab). Links the task to a registered repo for workspace context.",
      ),
    model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Concrete model override for this task, interpreted by the assignee's harness/provider. This does not switch providers. Prefer modelTier for portable intent.",
      ),
    modelTier: ModelTierSchema.optional().describe(
      "Portable model tier for this task: 'smol', 'regular', 'smart', or 'ultra'. Resolved at claim/run time using the assignee's harness/provider. Legacy model shortnames map as haiku→smol, sonnet→regular, opus→smart, fable→ultra.",
    ),
    effort: ReasoningEffortSchema.optional().describe(
      "Reasoning effort for this task: 'off', 'low', 'medium', 'high', 'xhigh', or 'max'. If omitted, the assignee's REASONING_EFFORT_OVERRIDE/default applies.",
    ),
    allowDuplicate: z
      .boolean()
      .default(false)
      .describe(
        "If true, skip duplicate detection and create the task even if a similar one exists.",
      ),
    slackChannelId: z
      .string()
      .optional()
      .describe(
        "Slack channel ID to post progress updates to. Use this to propagate Slack context when delegating from a Slack thread.",
      ),
    slackThreadTs: z
      .string()
      .optional()
      .describe("Slack thread timestamp. Required with slackChannelId for thread-level updates."),
    slackUserId: z.string().optional().describe("Slack user ID of the original requester."),
    overrideSlackContext: z
      .boolean()
      .default(false)
      .describe(
        "Explicitly route this task's Slack updates to a different channel/thread than its parent/contextKey. Requires slackChannelId AND slackThreadTs. Use only for deliberate cross-channel dispatch (e.g. escalation to another human's DM); logged for audit. Without this flag, a slackChannelId/slackThreadTs that disagrees with the parent task or inherited contextKey is rejected — omit the three Slack fields to inherit them from the parent as a unit instead.",
      ),
    requestedByUserId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "ID of the human user who originally requested this task chain. When omitted, inherited from the caller's current task so the attribution flows through multi-hop delegation automatically.",
      ),
    followUpConfig: FollowUpConfigSchema.optional().describe(
      "Control the lead follow-up created when this task finishes. When to use `followUpConfig`: set `disabled: true` when you'll wait for this task to complete inline and no follow-up is needed; set `onCompleted` / `onFailed` with specific instructions when you need to follow up effectively on a particular outcome of a long-running flow; for normal one-shot tasks, leave it unset because defaults are fine. It is most valuable for long-running / complex flows.",
    ),
  })
  .superRefine((data, ctx) => {
    const hasChannel = !!data.slackChannelId;
    const hasThread = !!data.slackThreadTs;
    if (hasChannel !== hasThread) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "slackChannelId and slackThreadTs must both be set, or both omitted.",
        path: [hasChannel ? "slackThreadTs" : "slackChannelId"],
      });
    }
  });

export const sendTaskOutputSchema = z.object({
  yourAgentId: z.string().uuid().optional(),
  success: z.boolean(),
  message: z.string(),
  task: AgentTaskSchema.optional(),
});

type SendTaskArgs = z.infer<typeof sendTaskInputSchema>;

const TRACKER_OWNERSHIP_TRANSFER_PARENT_STATUSES = new Set([
  "superseded",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * When `send-task` creates a `resume` task whose parent is in a terminal state,
 * move the parent's `tracker_sync` rows (Linear / Jira / GitHub outbound link)
 * onto the new resume child so the re-delegated work keeps its external-tracker
 * completion link. General-correct for any Lead re-delegation of a resume;
 * specifically it completes the DES-523 tracker chain on the gone-agent path:
 * original → R1 (pin) → R1 → original (reaper) → original → R2 (here). No-op for
 * non-resume tasks or when the parent has no tracker_sync rows.
 */
function transferTrackerSyncToResumeChild(args: {
  parentTaskId?: string;
  taskType?: string;
  child: AgentTask;
}): void {
  if (args.taskType !== "resume" || !args.parentTaskId) return;

  const parent = getTaskById(args.parentTaskId);
  if (!parent || !TRACKER_OWNERSHIP_TRANSFER_PARENT_STATUSES.has(parent.status)) return;

  const repointed = repointTrackerSyncBySwarmId(parent.id, args.child.id);
  if (repointed > 0) {
    console.log(
      `[send-task] Repointed ${repointed} tracker_sync row(s) from terminal parent ${parent.id.slice(0, 8)} to resume child ${args.child.id.slice(0, 8)}`,
    );
  }
}

export async function sendTaskHandler(
  ctx: ToolCtx,
  {
    agentId,
    task,
    key,
    offerMode,
    taskType,
    tags,
    requiredCapabilities,
    priority,
    dependsOn,
    dir,
    parentTaskId,
    vcsRepo,
    model,
    modelTier,
    effort,
    allowDuplicate,
    slackChannelId,
    slackThreadTs,
    slackUserId,
    overrideSlackContext,
    requestedByUserId: inputRequestedByUserId,
    followUpConfig,
  }: SendTaskArgs,
): Promise<CallToolResult> {
  if (ctx.kind === "owner" && !ctx.agentId) {
    return {
      content: [
        {
          type: "text",
          text: 'Agent ID not found. The MCP client should define the "X-Agent-ID" header.',
        },
      ],
      structuredContent: {
        yourAgentId: ctx.agentId,
        success: false,
        message: 'Agent ID not found. The MCP client should define the "X-Agent-ID" header.',
      },
    };
  }

  const creatorAgentId = ctx.kind === "owner" ? ctx.agentId : undefined;
  const sourceTaskId = ctx.kind === "owner" ? ctx.sourceTaskId : undefined;
  const callerTask = sourceTaskId ? getTaskById(sourceTaskId) : null;
  const requestedByUserId =
    ctx.kind === "user"
      ? ctx.userId
      : (inputRequestedByUserId ?? callerTask?.requestedByUserId ?? undefined);

  if (ctx.kind === "owner" && agentId === ctx.agentId) {
    return {
      content: [
        {
          type: "text",
          text: "Cannot send a task to yourself, are you drunk?",
        },
      ],
      structuredContent: {
        yourAgentId: ctx.agentId,
        success: false,
        message: "Cannot send a task to yourself, are you drunk?",
      },
    };
  }

  const effectiveVcsRepo = vcsRepo;
  const normalizedModel = splitLegacyModelAlias({ model, modelTier });

  // Auto-default parentTaskId to caller's current task for tree tracking
  const effectiveParentTaskId = parentTaskId ?? sourceTaskId;
  const effectiveParentTask = effectiveParentTaskId ? getTaskById(effectiveParentTaskId) : null;

  // Slack-routing coherence guard: reject a hand-typed slackChannelId/slackThreadTs
  // that disagrees with the parent task or the contextKey this child will inherit.
  // A mismatch here silently misroutes a worker's completion summary into the
  // wrong human's Slack DM (see swarm memory
  // dispatch-slack-channel-must-match-parent-context-2026-07-10). Omitting the
  // three Slack fields lets inheritance do the right thing; overrideSlackContext
  // opts into a deliberate cross-channel dispatch.
  if (!overrideSlackContext) {
    // send-task never passes contextKey explicitly, so the child inherits the
    // parent's contextKey verbatim (createTaskExtended, src/be/db.ts:3556-3558).
    const inheritedContextKey = effectiveParentTask?.contextKey;
    const routingCheck = checkSlackRoutingCoherence({
      explicit: { channelId: slackChannelId, threadTs: slackThreadTs, userId: slackUserId },
      parent: effectiveParentTask,
      inheritedContextKey,
    });
    if (routingCheck.verdict !== "ok") {
      const msg =
        routingCheck.verdict === "partial-unit"
          ? `Slack routing rejected: ${routingCheck.detail}`
          : `Slack routing mismatch: you passed ${routingCheck.field}="${routingCheck.got}" but the ${routingCheck.expectedSource} task says "${routingCheck.expected}". Omit the three Slack fields to inherit them from the parent as a unit (preferred), or pass overrideSlackContext: true if the cross-channel routing is deliberate.`;
      return {
        content: [{ type: "text", text: msg }],
        structuredContent: {
          yourAgentId: creatorAgentId,
          success: false,
          message: msg,
        },
      };
    }
  } else if (slackChannelId || slackThreadTs) {
    console.log(
      `[send-task] slack-context override: creatorAgentId=${creatorAgentId ?? "n/a"} slackChannelId=${slackChannelId ?? "n/a"} slackThreadTs=${slackThreadTs ?? "n/a"} parentTaskId=${effectiveParentTaskId ?? "n/a"}`,
    );
  }

  let assetKey: string | undefined;
  try {
    const trustedUserId =
      ctx.kind === "user" ? ctx.userId : resolveTaskAuditUserId(sourceTaskId, creatorAgentId);
    const requestedKey = key ?? effectiveParentTask?.key;
    assetKey = requestedKey ? authorizeAssetKeyWrite(requestedKey, trustedUserId) : undefined;
  } catch (error) {
    const message =
      error instanceof AssetKeyAuthorizationError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      isError: true,
      content: [{ type: "text", text: message }],
      structuredContent: { yourAgentId: creatorAgentId, success: false, message },
    };
  }

  // Auto-route to parent's worker if parentTaskId is set and no explicit agentId
  let effectiveAgentId = agentId;
  if (effectiveParentTaskId && !agentId) {
    if (effectiveParentTask?.agentId) {
      effectiveAgentId = effectiveParentTask.agentId;
    }
  }

  const effective = resolveEffectiveTaskOptions(task, {
    key: assetKey,
    agentId: effectiveAgentId,
    creatorAgentId,
    requestedByUserId,
    sourceTaskId,
    taskType,
    tags,
    priority,
    dependsOn,
    dir,
    parentTaskId: effectiveParentTaskId,
    vcsRepo: effectiveVcsRepo,
    model: normalizedModel.model,
    modelTier: normalizedModel.modelTier,
    effort,
    slackChannelId,
    slackThreadTs,
    slackUserId,
    overrideSlackContext,
    followUpConfig,
    routingAffinity:
      !effectiveAgentId && requiredCapabilities?.length
        ? { capabilities: requiredCapabilities }
        : undefined,
  });
  // The Lead's own pick, captured BEFORE routing can overwrite it. The
  // `routing.lead_deviated` telemetry below is about whether the LEAD followed
  // the parent's suggestion, so it must compare against this — not against the
  // post-routing assignee, which a hard handler override would otherwise
  // report as a Lead deviation that never happened.
  const leadChosenAgentId = effectiveAgentId;
  const routingCtx = buildRoutingCtx("delegation", effective, {
    proposedAgentId: effectiveAgentId,
  });
  const routingDecision = await runBeforeAssign(routingCtx);
  // Fail open on bogus hard-assign targets, same as createTaskRouted: an
  // unknown or lead agentId from a handler must not misroute (or strand) the
  // delegation — drop it and keep the caller's own selection.
  if (
    routingDecision.final?.assignTo &&
    !validateRoutingAssignTarget(routingDecision.final.assignTo, "delegation")
  ) {
    routingDecision.final = routingDecision.final.block
      ? { ...routingDecision.final, assignTo: undefined }
      : undefined;
  }
  const routedOptions = applyRoutingDecisionToOptions(effective.options ?? {}, routingDecision);
  // `routedOptions.agentId` is authoritative post-routing: it carries both a
  // hard `assignTo` and an `unassign` (pin dropped → pool), which a plain
  // `assignTo ?? effectiveAgentId` would silently ignore.
  effectiveAgentId = routedOptions.agentId ?? undefined;

  if (routingDecision.final?.block) {
    const reason = routingDecision.final.block.reason;
    const rerouteTask = createRoutingBlockDecisionTask({
      description: effective.description,
      reason,
      options: routedOptions,
    });
    backfillTraceTaskId(routingDecision.routingRunId, rerouteTask.id);
    const message = `Delegation blocked by routing: ${reason}. Created Lead reroute-decision task "${rerouteTask.id}".`;
    return {
      content: [{ type: "text", text: message }],
      structuredContent: {
        yourAgentId: creatorAgentId,
        success: false,
        message,
        task: rerouteTask,
      },
    };
  }

  const existingTrackerWork = findExistingLinearTrackerContextWork(effectiveParentTask?.contextKey);
  if (existingTrackerWork) {
    const msg = `Skipped: Linear tracker contextKey ${effectiveParentTask?.contextKey} already has ${existingTrackerWork.reason === "active_task" ? "active task" : "linked open PR"} ${existingTrackerWork.task.id.slice(0, 8)}.`;
    console.log(`[send-task] ${msg}`);
    return {
      content: [{ type: "text", text: msg }],
      structuredContent: {
        yourAgentId: creatorAgentId,
        success: true,
        message: msg,
        task: existingTrackerWork.task,
      },
    };
  }

  // Dedup guard: check for similar recent tasks
  if (!allowDuplicate && creatorAgentId) {
    const duplicate = findDuplicateTask({
      taskDescription: task,
      creatorAgentId,
      targetAgentId: effectiveAgentId ?? undefined,
    });
    if (duplicate) {
      const msg = `Duplicate task detected (matches task ${duplicate.task.id.slice(0, 8)}, ${duplicate.reason}). Skipping. Use allowDuplicate: true to override.`;
      return {
        content: [{ type: "text", text: msg }],
        structuredContent: {
          yourAgentId: creatorAgentId,
          success: false,
          message: msg,
        },
      };
    }
  }

  // Guard: prevent re-delegation from follow-up tasks
  // When the source task is a "follow-up" (worker completed/failed notification),
  // check if there are completed tasks in the same Slack thread recently.
  // This prevents the cycle: worker completes → follow-up → Lead re-delegates → repeat.
  //
  // Exception: if a MORE RECENT task in the same thread was cancelled (exit 130,
  // status='cancelled', or status='failed' with failureReason containing
  // "cancelled"), bypass the guard. A cancellation means the work was
  // interrupted — re-dispatch is the correct response, not a deduped no-op.
  // Without this bypass, a cancelled worker permanently jams the thread
  // against re-delegation when an earlier completed sibling exists.
  //
  // NOTE: `taskType === "resume"` (created by createResumeFollowUp on
  // supersede) is intentionally NOT in this guard — a resume IS the legitimate
  // re-dispatch and bypassing the check is correct. Do not add "resume" here.
  if (sourceTaskId) {
    const sourceTask = getTaskById(sourceTaskId);
    if (
      sourceTask?.taskType === "follow-up" &&
      sourceTask.slackThreadTs &&
      sourceTask.slackChannelId
    ) {
      const recentCompleted = findCompletedTaskInThread(
        sourceTask.slackChannelId,
        sourceTask.slackThreadTs,
        2880, // 48 hours in minutes
      );
      if (recentCompleted) {
        const recentCancelled = findRecentCancelledTaskInThread(
          sourceTask.slackChannelId,
          sourceTask.slackThreadTs,
          2880,
        );
        const cancelledMoreRecent =
          recentCancelled &&
          new Date(recentCancelled.lastUpdatedAt).getTime() >
            new Date(recentCompleted.lastUpdatedAt).getTime();
        if (!cancelledMoreRecent) {
          const msg = `Blocked: re-delegation from follow-up task in a thread that already has completed work (task ${recentCompleted.id.slice(0, 8)}). The original request was already handled.`;
          return {
            content: [{ type: "text", text: msg }],
            structuredContent: {
              yourAgentId: creatorAgentId,
              success: false,
              message: msg,
            },
          };
        }
        // else: fall through — the cancellation is more recent than the
        // completion, so re-delegation is legitimate.
      }
    }
  }

  // The engine already ran (via=delegation) above and creation is synchronous
  // from here, so the capacity check, INSERT, and tracker repoint run inside
  // one transaction — same atomicity as before routing landed. Never await
  // inside this block.
  const txn = getDb().transaction((): { success: boolean; message: string; task?: AgentTask } => {
    // If no agentId (and no auto-routed agentId), create an unassigned task for the pool.
    if (!effectiveAgentId) {
      const newTask = createTaskExtended(effective.description, {
        ...routedOptions,
        agentId: undefined,
        offeredTo: undefined,
      });
      transferTrackerSyncToResumeChild({
        parentTaskId: effectiveParentTaskId,
        taskType,
        child: newTask,
      });
      backfillTraceTaskId(routingDecision.routingRunId, newTask.id);
      return {
        success: true,
        message: `Created unassigned task "${newTask.id}" in the pool.`,
        task: newTask,
      };
    }
    const agent = getAgentById(effectiveAgentId);
    if (!agent) {
      return {
        success: false,
        message: `Agent with ID "${effectiveAgentId}" not found.`,
      };
    }
    if (agent.isLead) {
      return {
        success: false,
        message: `Cannot assign tasks to the lead agent "${agent.name}", wtf?`,
      };
    }
    if (!offerMode && !hasCapacity(effectiveAgentId)) {
      const activeCount = getActiveTaskCount(effectiveAgentId);
      return {
        success: false,
        message: `Agent "${agent.name}" is at capacity (${activeCount}/${agent.maxTasks ?? 1} tasks). Use offerMode: true to offer the task instead, or wait for a task to complete.`,
      };
    }
    if (offerMode) {
      const newTask = createTaskExtended(effective.description, {
        ...routedOptions,
        agentId: undefined,
        offeredTo: effectiveAgentId,
      });
      transferTrackerSyncToResumeChild({
        parentTaskId: effectiveParentTaskId,
        taskType,
        child: newTask,
      });
      backfillTraceTaskId(routingDecision.routingRunId, newTask.id);
      return {
        success: true,
        message: `Task "${newTask.id}" offered to agent "${agent.name}". They must accept or reject it.`,
        task: newTask,
      };
    }
    const newTask = createTaskExtended(effective.description, {
      ...routedOptions,
      agentId: effectiveAgentId,
      offeredTo: undefined,
    });
    transferTrackerSyncToResumeChild({
      parentTaskId: effectiveParentTaskId,
      taskType,
      child: newTask,
    });
    backfillTraceTaskId(routingDecision.routingRunId, newTask.id);
    return {
      success: true,
      message: `Task "${newTask.id}" sent to agent "${agent.name}".`,
      task: newTask,
    };
  });
  const result = txn();
  const suggestion = effectiveParentTask?.routingDirectives?.suggestions.find(
    (candidate) => candidate.assignTo,
  );
  // `routing.lead_deviated` measures whether the LEAD followed a soft
  // suggestion — it is the signal that promotes a rule from soft to hard. But
  // send-task is callable by workers too, and counting a worker's delegation
  // as a Lead deviation would distort the very metric the promotion decision
  // rests on. Gate on the caller actually being the Lead.
  const callerIsLead = creatorAgentId ? (getAgentById(creatorAgentId)?.isLead ?? false) : false;
  if (
    result.success &&
    callerIsLead &&
    leadChosenAgentId &&
    suggestion?.assignTo &&
    suggestion.assignTo !== leadChosenAgentId &&
    effectiveParentTask
  ) {
    const routingRunId = effectiveParentTask.routingDirectives?.routingRunId ?? crypto.randomUUID();
    const payload = {
      taskId: effectiveParentTask.id,
      suggestedAgentId: suggestion.assignTo,
      chosenAgentId: leadChosenAgentId,
      handlerName: suggestion.handlerName,
      routingRunId,
    };
    try {
      createEvent({
        category: "task",
        event: "routing.lead_deviated",
        status: "ok",
        source: "hook",
        agentId: creatorAgentId,
        taskId: effectiveParentTask.id,
        data: payload,
      });
      workflowEventBus.emit("routing.lead_deviated", payload);
    } catch {
      // Deviation telemetry must not affect task delivery.
    }
    try {
      insertRoutingTrace({
        routingRunId,
        taskId: effectiveParentTask.id,
        edge: "task.before_assign",
        via: "delegation",
        handlerId: "lead-deviation",
        handlerName: suggestion.handlerName,
        flavor: "route",
        mode: "soft",
        matched: true,
        decisive: false,
        suggestion: suggestion.assignTo,
        deviated: true,
        dryRun: false,
        durationMs: 0,
      });
    } catch {
      // Trace persistence is best effort, matching routing engine behavior.
    }
  }
  const structuredContent = {
    yourAgentId: creatorAgentId,
    ...result,
  };

  return {
    content: [
      { type: "text", text: result.message },
      { type: "text", text: JSON.stringify(result) },
    ],
    structuredContent,
  };
}

export const registerSendTaskTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "send-task",
    {
      title: "Send a task",
      annotations: { destructiveHint: false },
      description:
        "Sends a task to a specific agent, creates an unassigned task for the pool, or offers a task for acceptance.",
      inputSchema: sendTaskInputSchema,
      outputSchema: sendTaskOutputSchema,
    },
    async (args, info, _meta) => sendTaskHandler(ownerCtx(info), args),
  );
};

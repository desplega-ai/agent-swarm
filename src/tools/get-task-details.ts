import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  getLogsByTaskIdChronological,
  getTaskAttachments,
  getTaskById,
  getUserById,
} from "@/be/db";
import { assertOwnsTask, ownerCtx, type ToolCtx } from "@/tools/task-tool-ctx";
import {
  createToolRegistrar,
  type SwarmToolResult,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "@/tools/utils";
import { type AgentTask, AgentTaskStatusSchema } from "@/types";
import { getUserCommsPrefs } from "@/utils/requester-comms";

/**
 * Reductions the size fit may apply, each one opted out of by its `include` value:
 * `logs` returns every log row verbatim, `text` returns every text field uncut.
 */
export const GET_TASK_DETAILS_INCLUDE = ["logs", "text"] as const;
type GetTaskDetailsInclude = (typeof GET_TASK_DETAILS_INCLUDE)[number];

export const getTaskDetailsInputSchema = z.object({
  taskId: z.uuid().describe("The ID of the task to get details for."),
  include: z
    .array(z.enum(GET_TASK_DETAILS_INCLUDE))
    .optional()
    .describe(
      'Opt out of the size fit. A response that fits the budget is never reduced. One that does not is reduced only as far as needed, and `fitted` lists what changed. "logs": every log row verbatim. "text": every text field (task, output, progress, failureReason, requester notes, log values) uncut. A result over the wire limit still spills to KV.',
    ),
});

// Loosened, output-only mirror of FollowUpConfigSchema / RoutingAffinitySchema
// (both plain z.object) and AgentTaskSchema / AgentLogSchema / TaskAttachmentSchema
// (which pin id/timestamp fields to z.uuid()/z.iso.datetime()). Output schemas
// must be all-optional z.looseObject with plain z.string() for those fields —
// a UUID/datetime constraint here fails MCP output validation after the write
// already applied (the -32602-after-write trap for slug-ID agents). The
// strict schemas in src/types.ts stay untouched: they're shared with runtime
// parsing (AgentTaskSchema.parse) elsewhere and covered by their own tests.
const looseFollowUpConfigSchema = z.looseObject({
  disabled: z.boolean().optional(),
  onCompleted: z.string().optional(),
  onFailed: z.string().optional(),
});

const looseRoutingAffinitySchema = z.looseObject({
  sourceAgentId: z.string().optional(),
  role: z.string().optional(),
  harnessProvider: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  leadOnly: z.boolean().optional(),
});

export const looseAgentTaskOutputSchema = z.looseObject({
  id: z.string().optional(),
  key: z.string().optional(),
  agentId: z.string().nullable().optional(),
  creatorAgentId: z.string().optional(),
  task: z.string().optional(),
  title: z.string().optional(),
  status: AgentTaskStatusSchema.optional(),
  source: z.string().optional(),
  taskType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().optional(),
  dependsOn: z.array(z.string()).optional(),
  offeredTo: z.string().optional(),
  offeredAt: z.string().optional(),
  acceptedAt: z.string().optional(),
  rejectionReason: z.string().optional(),
  createdAt: z.string().optional(),
  lastUpdatedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  notifiedAt: z.string().optional(),
  failureReason: z.string().optional(),
  output: z.string().optional(),
  progress: z.string().optional(),
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
  slackUserId: z.string().optional(),
  slackReplySent: z.boolean().optional(),
  slackProgressMessageTs: z.string().optional(),
  slackTreeRootMessageTs: z.string().optional(),
  vcsProvider: z.string().optional(),
  vcsRepo: z.string().optional(),
  vcsEventType: z.string().optional(),
  vcsNumber: z.number().optional(),
  vcsCommentId: z.number().optional(),
  vcsAuthor: z.string().optional(),
  vcsUrl: z.string().optional(),
  vcsInstallationId: z.number().optional(),
  vcsNodeId: z.string().optional(),
  agentmailInboxId: z.string().optional(),
  agentmailMessageId: z.string().optional(),
  agentmailThreadId: z.string().optional(),
  mentionMessageId: z.string().optional(),
  mentionChannelId: z.string().optional(),
  dir: z.string().optional(),
  parentTaskId: z.string().optional(),
  claudeSessionId: z.string().optional(),
  model: z.string().optional(),
  modelTier: z.string().optional(),
  effort: z.string().optional(),
  scheduleId: z.string().optional(),
  workflowRunId: z.string().nullable().optional(),
  workflowRunStepId: z.string().nullable().optional(),
  contextKey: z.string().optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  followUpConfig: looseFollowUpConfigSchema.optional(),
  wasPaused: z.boolean().optional(),
  compactionCount: z.number().optional(),
  peakContextPercent: z.number().optional(),
  peakContextTokens: z.number().optional(),
  contextWindowSize: z.number().optional(),
  credentialKeySuffix: z.string().optional(),
  credentialKeyType: z.string().optional(),
  requestedByUserId: z.string().optional(),
  swarmVersion: z.string().optional(),
  provider: z.string().optional(),
  providerMeta: z.record(z.string(), z.unknown()).optional(),
  harnessVariant: z.string().optional(),
  harnessVariantMeta: z.record(z.string(), z.unknown()).optional(),
  totalCostUsd: z.number().optional(),
  routingAffinity: looseRoutingAffinitySchema.optional(),
});

const looseAgentLogSchema = z.looseObject({
  id: z.string().optional(),
  eventType: z.string().optional(),
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  oldValue: z.string().optional(),
  newValue: z.string().optional(),
  metadata: z.string().optional(),
  createdAt: z.string().optional(),
});

const looseTaskAttachmentSchema = z.looseObject({
  id: z.string().optional(),
  taskId: z.string().optional(),
  agentId: z.string().nullable().optional(),
  name: z.string().optional(),
  kind: z.string().optional(),
  url: z.string().optional(),
  path: z.string().optional(),
  pageId: z.string().optional(),
  providerId: z.string().optional(),
  providerKey: z.string().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  orgId: z.string().optional(),
  driveId: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().optional(),
  sha256: z.string().optional(),
  intent: z.string().optional(),
  description: z.string().optional(),
  isPrimary: z.boolean().optional(),
  createdAt: z.string().optional(),
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
});

export const getTaskDetailsOutputSchema = swarmToolOutputSchema({
  // Plain string, NOT .uuid(): agents may join with custom IDs (AGENT_ID env /
  // join-swarm agentId), and a UUID constraint here makes the response fail MCP
  // output validation after the handler already ran.
  yourAgentId: z.string().optional(),
  task: looseAgentTaskOutputSchema.optional(),
  requestedBy: z
    .looseObject({
      name: z.string().optional(),
      email: z.string().optional(),
      role: z.string().optional(),
      notes: z.string().optional(),
      comms: z
        .looseObject({
          tone: z.string().optional(),
          language: z.string().optional(),
          verbosity: z.string().optional(),
        })
        .optional(),
    })
    .optional()
    .describe(
      "Resolved user who requested this task, with role/notes and structured communication preferences (users.metadata.comms) when set",
    ),
  logs: z.array(looseAgentLogSchema).optional(),
  attachments: z
    .array(looseTaskAttachmentSchema)
    .optional()
    .describe(
      "Pointer-based artifacts attached to this task via store-progress, ordered by created_at.",
    ),
  fitted: z
    .looseObject({
      budgetBytes: z.number().optional(),
      logs: z
        .looseObject({
          compacted: z.string().optional(),
          omitted: z.number().optional(),
          omittedByEventType: z.record(z.string(), z.number()).optional(),
        })
        .optional(),
      text: z
        .array(
          z.looseObject({
            field: z.string().optional(),
            originalChars: z.number().optional(),
            keptChars: z.number().optional(),
          }),
        )
        .optional(),
      include: z.array(z.string()).optional(),
    })
    .optional()
    .describe(
      "Present only when the full response passed the size budget: what was reduced to fit, and the include values that return it.",
    ),
});

type GetTaskDetailsArgs = z.infer<typeof getTaskDetailsInputSchema>;

/**
 * Payload budget for the agent-facing response, in UTF-8 bytes of the JSON data. The text
 * channel renders that JSON once after the message, and the structured channel carries it once
 * (ctx-control drops the duplicate `details` there before it spills), so a payload under this
 * budget stays under MCP_RESULT_WIRE_LIMIT_BYTES with room for the message and envelope keys.
 */
const FIT_BUDGET_BYTES = 9_000;
/** Log events the fit never drops: they carry the task's lifecycle. */
const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set(["task_created", "task_status_change"]);
/** A shortened text field keeps at least this many leading characters. */
const MIN_TEXT_CHARS = 280;
/** Task text fields the fit may shorten, after the log reductions. */
const TASK_TEXT_FIELDS = ["task", "output", "progress", "failureReason"] as const;

type LogView = Record<string, unknown> & { eventType: string };
type FitNotice = {
  budgetBytes: number;
  logs?: { compacted: string; omitted?: number; omittedByEventType?: Record<string, number> };
  text?: Array<{ field: string; originalChars: number; keptChars: number }>;
  include?: GetTaskDetailsInclude[];
};
type DetailsData = {
  yourAgentId: string | undefined;
  task: AgentTask;
  requestedBy: Record<string, unknown> | undefined;
  logs: LogView[];
  attachments: unknown[];
  fitted?: FitNotice;
};

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** The first `chars` characters of `value`, never ending on a lone high surrogate. */
function head(value: string, chars: number): string {
  const code = value.charCodeAt(chars - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? chars - 1 : chars);
}

/**
 * Fit the response under FIT_BUDGET_BYTES with the least loss. A response that already fits is
 * returned unchanged. Otherwise the steps run in order and stop as soon as it fits:
 * 1. log rows drop fields that repeat the task (lossless);
 * 2. the oldest non-lifecycle log rows go, keeping lifecycle events and the newest progress;
 * 3. the longest text field is shortened, repeatedly, never below MIN_TEXT_CHARS.
 * `include` skips steps 1-2 ("logs") or step 3 ("text"). Ids, status, parentTaskId and
 * attachments are never touched, and `fitted` records every reduction.
 */
function fitToBudget(full: DetailsData, include: ReadonlySet<GetTaskDetailsInclude>): DetailsData {
  if (jsonBytes(full) <= FIT_BUDGET_BYTES) return full;

  const fitted: FitNotice = { budgetBytes: FIT_BUDGET_BYTES };
  const reduced: GetTaskDetailsInclude[] = [];
  let task: AgentTask = full.task;
  let requestedBy = full.requestedBy;
  let logs = full.logs;
  const view = (): DetailsData => ({
    ...full,
    task,
    requestedBy,
    logs,
    fitted: { ...fitted, include: reduced },
  });
  const fits = () => jsonBytes(view()) <= FIT_BUDGET_BYTES;

  if (!include.has("logs")) {
    reduced.push("logs");
    const taskAgentId = full.task.agentId;
    const compact: LogView[] = full.logs.map(({ taskId: _sameTask, agentId, ...rest }) =>
      agentId && agentId !== taskAgentId ? { ...rest, agentId } : rest,
    );
    logs = compact;
    fitted.logs = {
      compacted:
        "Log rows omit taskId (always this task) and agentId where it equals task.agentId.",
    };

    if (!fits()) {
      let newestProgress = -1;
      compact.forEach((log, i) => {
        if (log.eventType === "task_progress") newestProgress = i;
      });
      // Oldest first, so the newest context survives.
      const droppable = compact
        .map((_log, i) => i)
        .filter((i) => i !== newestProgress && !LIFECYCLE_EVENTS.has(compact[i]?.eventType ?? ""));
      const without = (count: number) => {
        const drop = new Set(droppable.slice(0, count));
        return compact.filter((_, i) => !drop.has(i));
      };
      let low = 1;
      let high = droppable.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        logs = without(mid);
        if (fits()) high = mid;
        else low = mid + 1;
      }
      const dropped = Math.min(low, droppable.length);
      logs = without(dropped);
      if (dropped > 0) {
        const byEventType: Record<string, number> = {};
        for (const i of droppable.slice(0, dropped)) {
          const type = compact[i]?.eventType ?? "unknown";
          byEventType[type] = (byEventType[type] ?? 0) + 1;
        }
        fitted.logs = { ...fitted.logs, omitted: dropped, omittedByEventType: byEventType };
      }
    }
  }

  if (!fits() && !include.has("text")) {
    reduced.push("text");
    fitted.text = [];
    task = { ...task };
    if (requestedBy) {
      const comms = requestedBy.comms;
      requestedBy = {
        ...requestedBy,
        ...(comms && typeof comms === "object" ? { comms: { ...comms } } : {}),
      };
    }
    const shortenLogs = !include.has("logs");
    if (shortenLogs) logs = logs.map((log) => ({ ...log }));

    type Slot = { field: string; value: string; set: (next: string) => void };
    const slots = (): Slot[] => {
      const out: Slot[] = [];
      const mutableTask = task as Record<string, unknown>;
      for (const key of TASK_TEXT_FIELDS) {
        const value = mutableTask[key];
        if (typeof value === "string") {
          out.push({ field: `task.${key}`, value, set: (next) => (mutableTask[key] = next) });
        }
      }
      // Requester notes and comms preferences (tone, verbosity, ...) are free text too.
      const owner = requestedBy;
      const comms = owner?.comms as Record<string, unknown> | undefined;
      for (const [prefix, record] of [
        ["requestedBy", owner],
        ["requestedBy.comms", comms],
      ] as const) {
        if (!record) continue;
        for (const [key, value] of Object.entries(record)) {
          if (typeof value === "string" && key !== "name" && key !== "email" && key !== "role") {
            out.push({ field: `${prefix}.${key}`, value, set: (next) => (record[key] = next) });
          }
        }
      }
      if (shortenLogs) {
        logs.forEach((log, i) => {
          for (const key of ["newValue", "oldValue", "metadata"]) {
            const value = log[key];
            if (typeof value === "string") {
              out.push({ field: `logs[${i}].${key}`, value, set: (next) => (log[key] = next) });
            }
          }
        });
      }
      return out;
    };

    const original = new Map<string, number>();
    for (let round = 0; round < 40 && !fits(); round++) {
      const over = jsonBytes(view()) - FIT_BUDGET_BYTES;
      const longest = slots().reduce<Slot | undefined>(
        (best, slot) => (!best || slot.value.length > best.value.length ? slot : best),
        undefined,
      );
      if (!longest || longest.value.length <= MIN_TEXT_CHARS + 120) break;
      const first = original.get(longest.field) ?? longest.value.length;
      original.set(longest.field, first);
      // The previous marker is cut away with the tail; 120 chars of slack cover the new one.
      const keep = Math.max(MIN_TEXT_CHARS, longest.value.length - over - 120);
      longest.set(
        `${head(longest.value, keep)}… [cut, ${first} chars in full; include "text" for all]`,
      );
      const existing = fitted.text.find((entry) => entry.field === longest.field);
      if (existing) existing.keptChars = keep;
      else fitted.text.push({ field: longest.field, originalChars: first, keptChars: keep });
    }
    // Nothing was long enough to cut: report no text reduction.
    if (fitted.text.length === 0) {
      delete fitted.text;
      reduced.pop();
    }
  }

  return view();
}

export async function getTaskDetailsHandler(
  ctx: ToolCtx,
  { taskId, include }: GetTaskDetailsArgs,
): Promise<SwarmToolResult> {
  const task = await getTaskById(taskId);
  const agentId = ctx.kind === "owner" ? ctx.agentId : undefined;

  if (!task) {
    return toolErr(`Task with ID "${taskId}" not found.`, { data: { yourAgentId: agentId } });
  }

  const ownershipError = assertOwnsTask(ctx, task, "task.read.own");
  if (ownershipError) return ownershipError;

  const logs = await getLogsByTaskIdChronological(taskId);
  const attachments = await getTaskAttachments(taskId);

  // Resolve requesting user details if available
  const requestedByUser = task.requestedByUserId
    ? await getUserById(task.requestedByUserId)
    : undefined;
  const requestedBy = requestedByUser
    ? {
        name: requestedByUser.name,
        email: requestedByUser.email,
        role: requestedByUser.role,
        notes: requestedByUser.notes,
        comms: getUserCommsPrefs(requestedByUser),
      }
    : undefined;

  const full: DetailsData = {
    yourAgentId: agentId,
    task,
    requestedBy,
    logs,
    attachments,
  };

  // Script and extension calls never reach a model context, so they keep the full shape.
  const origin = ctx.kind === "owner" ? ctx.requestInfo?.callOrigin : undefined;
  const data =
    origin === "script-sdk" || origin === "extension"
      ? full
      : fitToBudget(full, new Set(include ?? []));
  const reducedParts = data.fitted?.include ?? [];
  const fitNote = reducedParts.length
    ? ` Fitted to the size budget; include ${JSON.stringify(reducedParts)} for the rest.`
    : "";

  return toolOk(`Task "${taskId}" (${task.status}) details retrieved.${fitNote}`, {
    details: JSON.stringify(data),
    data,
  });
}

export const registerGetTaskDetailsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-task-details",
    {
      title: "Get task details",
      description:
        'Returns detailed information about a specific task, including output, failure reason, attachments and log history. A response over the size budget is fitted with the least loss: log rows drop fields that repeat the task, then the oldest non-lifecycle rows, then the longest text is cut. `fitted` lists each reduction; include ["logs", "text"] returns the rest.',
      annotations: { readOnlyHint: true },
      inputSchema: getTaskDetailsInputSchema,
      outputSchema: getTaskDetailsOutputSchema,
    },
    async (args, info, _meta) => getTaskDetailsHandler(ownerCtx(info), args),
  );
};

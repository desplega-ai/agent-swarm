import { getTaskById } from "../be/db";
import { scrubSecrets } from "../utils/secret-scrubber";
import { workflowEventBus } from "../workflows/event-bus";
import type {
  ApprovalResolvedEvent,
  KapsoMessageEvent,
  TaskBudgetRefusedEvent,
  VcsEvent,
  VcsEventKind,
  VcsProvider,
} from "./contract";
import { dispatchPost, extensionIdForAgent } from "./dispatcher";

let subscribed = false;

function observed(
  eventName: string,
  handler: (data: unknown) => Promise<void>,
): (data: unknown) => void {
  return (data): void => {
    handler(data).catch((error) => {
      console.error(
        `[extensions] ${eventName} bridge failed:`,
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    });
  };
}

async function taskFrom(data: unknown) {
  const taskId = (data as { taskId?: unknown } | null)?.taskId;
  if (typeof taskId !== "string") return null;
  return await getTaskById(taskId);
}

const onTaskCreated = observed("task.created", async (data) => {
  const task = await taskFrom(data);
  if (task)
    await dispatchPost(
      "post.task.created",
      { task },
      { skipExtensionId: extensionIdForAgent(task.creatorAgentId) },
    );
});

const onTaskCompleted = observed("task.completed", async (data) => {
  const task = await taskFrom(data);
  if (!task) return;
  const output = (data as { output?: unknown }).output;
  await dispatchPost(
    "post.task.completed",
    {
      task,
      output: typeof output === "string" ? output : (task.output ?? ""),
    },
    { skipExtensionId: extensionIdForAgent(task.creatorAgentId) },
  );
});

const onTaskFailed = observed("task.failed", async (data) => {
  const task = await taskFrom(data);
  if (!task) return;
  const failureReason = (data as { failureReason?: unknown }).failureReason;
  await dispatchPost(
    "post.task.failed",
    {
      task,
      failureReason: typeof failureReason === "string" ? failureReason : (task.failureReason ?? ""),
    },
    { skipExtensionId: extensionIdForAgent(task.creatorAgentId) },
  );
});

const onTaskCancelled = observed("task.cancelled", async (data) => {
  const task = await taskFrom(data);
  if (task)
    await dispatchPost(
      "post.task.cancelled",
      { task },
      { skipExtensionId: extensionIdForAgent(task.creatorAgentId) },
    );
});

const onTaskSuperseded = observed("task.superseded", async (data) => {
  const task = await taskFrom(data);
  if (!task) return;
  const source = data as { resumeTaskId?: unknown; supersededBy?: unknown };
  const supersededBy =
    typeof source.supersededBy === "string"
      ? source.supersededBy
      : typeof source.resumeTaskId === "string"
        ? source.resumeTaskId
        : "";
  await dispatchPost(
    "post.task.superseded",
    { task, supersededBy },
    { skipExtensionId: extensionIdForAgent(task.creatorAgentId) },
  );
});

const onTaskProgress = observed("task.progress", async (data) => {
  const task = await taskFrom(data);
  if (!task) return;
  const progress = (data as { progress?: unknown }).progress;
  await dispatchPost(
    "post.task.progress",
    {
      task,
      progress: typeof progress === "string" ? progress : (task.progress ?? ""),
    },
    { skipExtensionId: extensionIdForAgent(task.creatorAgentId) },
  );
});

const onSlackMessage = observed("slack.message", async (data) => {
  const source = data as {
    channel?: unknown;
    channelId?: unknown;
    user?: unknown;
    userId?: unknown;
    text?: unknown;
    threadTs?: unknown;
    taskId?: unknown;
  };
  const channelId =
    typeof source.channelId === "string"
      ? source.channelId
      : typeof source.channel === "string"
        ? source.channel
        : undefined;
  const userId =
    typeof source.userId === "string"
      ? source.userId
      : typeof source.user === "string"
        ? source.user
        : undefined;
  if (!channelId || !userId || typeof source.text !== "string") return;
  await dispatchPost("post.slack.message", {
    channelId,
    userId,
    text: source.text,
    ...(typeof source.threadTs === "string" ? { threadTs: source.threadTs } : {}),
    ...(typeof source.taskId === "string" ? { taskId: source.taskId } : {}),
  });
});

const APPROVAL_STATUSES: ReadonlySet<unknown> = new Set<ApprovalResolvedEvent["status"]>([
  "approved",
  "rejected",
  "timeout",
  "cancelled",
]);

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function compact<T extends object>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

const onApprovalResolved = observed("approval.resolved", async (data) => {
  const source = (data ?? {}) as Record<string, unknown>;
  const requestId = text(source.requestId);
  if (!requestId || !APPROVAL_STATUSES.has(source.status)) return;
  const responses = source.responses;
  await dispatchPost(
    "post.approval.resolved",
    compact<ApprovalResolvedEvent>({
      requestId,
      status: source.status as ApprovalResolvedEvent["status"],
      responses:
        typeof responses === "object" && responses !== null && !Array.isArray(responses)
          ? (responses as Record<string, unknown>)
          : null,
      workflowRunId: text(source.workflowRunId),
      workflowRunStepId: text(source.workflowRunStepId),
      sourceTaskId: text(source.sourceTaskId),
    }),
  );
});

const onTaskBudgetRefused = observed("task.budget_refused", async (data) => {
  const task = await taskFrom(data);
  if (!task) return;
  const source = data as Record<string, unknown>;
  const agentId = text(source.agentId);
  const resetAt = text(source.resetAt);
  const cause = source.cause;
  if (!agentId || !resetAt) return;
  if (cause !== "agent" && cause !== "global" && cause !== "user") return;
  await dispatchPost(
    "post.task.budgetRefused",
    compact<TaskBudgetRefusedEvent>({
      task,
      agentId,
      cause,
      agentSpendUsd: count(source.agentSpendUsd),
      agentBudgetUsd: count(source.agentBudgetUsd),
      globalSpendUsd: count(source.globalSpendUsd),
      globalBudgetUsd: count(source.globalBudgetUsd),
      userSpendUsd: count(source.userSpendUsd),
      userBudgetUsd: count(source.userBudgetUsd),
      resetAt,
    }),
    { skipExtensionId: extensionIdForAgent(task.creatorAgentId) },
  );
});

const onEmailReceived = observed("agentmail.message.received", async (data) => {
  const source = (data ?? {}) as Record<string, unknown>;
  const inboxId = text(source.inboxId);
  const from = text(source.from);
  const subject = text(source.subject);
  const body = text(source.body);
  const threadId = text(source.threadId);
  const messageId = text(source.messageId);
  if (
    inboxId === undefined ||
    from === undefined ||
    subject === undefined ||
    body === undefined ||
    threadId === undefined ||
    messageId === undefined
  ) {
    return;
  }
  await dispatchPost("post.email.received", {
    inboxId,
    from,
    subject,
    body,
    threadId,
    messageId,
  });
});

const onKapsoMessage = observed("kapso.message.received", async (data) => {
  const source = (data ?? {}) as Record<string, unknown>;
  const phoneNumberId = text(source.phoneNumberId);
  const messageId = text(source.messageId);
  const messageText = text(source.text);
  if (phoneNumberId === undefined || messageId === undefined || messageText === undefined) return;
  await dispatchPost(
    "post.kapso.message",
    compact<KapsoMessageEvent>({
      phoneNumberId,
      conversationId: text(source.conversationId),
      messageId,
      from: text(source.from),
      type: text(source.type),
      text: messageText,
    }),
  );
});

// The code-host events are named `<provider>.<kind>.<action>` and the last
// segment is open-ended (`github.pull_request.<action>`, `gitlab.pipeline.<status>`),
// so one prefix subscription per provider covers them all.
const VCS_PROVIDERS: ReadonlySet<string> = new Set<VcsProvider>([
  "github",
  "gitlab",
  "azure-devops",
]);
const VCS_KINDS: ReadonlySet<string> = new Set<VcsEventKind>([
  "pull_request",
  "merge_request",
  "issue",
  "issue_comment",
  "note",
  "pull_request_review",
  "pipeline",
]);
const VCS_PREFIXES = [...VCS_PROVIDERS].map((provider) => `${provider}.`);

function parseVcsEventName(name: string): Pick<VcsEvent, "provider" | "kind" | "action"> | null {
  const [provider, kind, ...rest] = name.split(".");
  const action = rest.join(".");
  if (!provider || !kind || !action) return null;
  if (!VCS_PROVIDERS.has(provider) || !VCS_KINDS.has(kind)) return null;
  return { provider: provider as VcsProvider, kind: kind as VcsEventKind, action };
}

async function bridgeVcsEvent(name: string, data: unknown): Promise<void> {
  const parsed = parseVcsEventName(name);
  const source = (data ?? {}) as Record<string, unknown>;
  const repo = text(source.repo);
  if (!parsed || !repo) return;
  const body = source.body;
  await dispatchPost(
    "post.vcs.event",
    compact<VcsEvent>({
      ...parsed,
      repo,
      number: count(source.number),
      title: text(source.title),
      body: typeof body === "string" || body === null ? body : undefined,
      author: text(source.user_login),
      url: text(source.html_url),
      merged: typeof source.merged === "boolean" ? source.merged : undefined,
      changedFiles: count(source.changed_files),
      reviewState: text(source.state),
    }),
  );
}

const onVcsEvent = (name: string, data: unknown): void => {
  bridgeVcsEvent(name, data).catch((error) => {
    console.error(
      `[extensions] ${name} bridge failed:`,
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
  });
};

export function initExtensionPostBridge(): void {
  if (subscribed) return;
  subscribed = true;
  workflowEventBus.on("task.created", onTaskCreated);
  workflowEventBus.on("task.completed", onTaskCompleted);
  workflowEventBus.on("task.failed", onTaskFailed);
  workflowEventBus.on("task.cancelled", onTaskCancelled);
  workflowEventBus.on("task.superseded", onTaskSuperseded);
  workflowEventBus.on("task.progress", onTaskProgress);
  workflowEventBus.on("slack.message", onSlackMessage);
  workflowEventBus.on("approval.resolved", onApprovalResolved);
  workflowEventBus.on("task.budget_refused", onTaskBudgetRefused);
  workflowEventBus.on("agentmail.message.received", onEmailReceived);
  workflowEventBus.on("kapso.message.received", onKapsoMessage);
  for (const prefix of VCS_PREFIXES) workflowEventBus.onPrefix(prefix, onVcsEvent);
}

export function teardownExtensionPostBridge(): void {
  if (!subscribed) return;
  subscribed = false;
  workflowEventBus.off("task.created", onTaskCreated);
  workflowEventBus.off("task.completed", onTaskCompleted);
  workflowEventBus.off("task.failed", onTaskFailed);
  workflowEventBus.off("task.cancelled", onTaskCancelled);
  workflowEventBus.off("task.superseded", onTaskSuperseded);
  workflowEventBus.off("task.progress", onTaskProgress);
  workflowEventBus.off("slack.message", onSlackMessage);
  workflowEventBus.off("approval.resolved", onApprovalResolved);
  workflowEventBus.off("task.budget_refused", onTaskBudgetRefused);
  workflowEventBus.off("agentmail.message.received", onEmailReceived);
  workflowEventBus.off("kapso.message.received", onKapsoMessage);
  for (const prefix of VCS_PREFIXES) workflowEventBus.offPrefix(prefix, onVcsEvent);
}

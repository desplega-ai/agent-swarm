import { getTaskById } from "../be/db";
import { scrubSecrets } from "../utils/secret-scrubber";
import { workflowEventBus } from "../workflows/event-bus";
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
}

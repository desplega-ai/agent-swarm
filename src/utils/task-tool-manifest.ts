import { z } from "zod";
import { chatThreadOfContextKey } from "../tasks/context-key";
import { ALL_TOOLS } from "../tools/tool-config";

const toolNames = z
  .array(z.string().refine((name) => ALL_TOOLS.has(name), "Unknown swarm tool"))
  .max(16);

/** Exact task-type and schedule keys; a schedule entry overrides its task type. */
export const taskToolManifestSchema = z.strictObject({
  taskTypes: z.record(z.string().min(1).max(50), toolNames).optional(),
  schedules: z.record(z.uuid(), toolNames).optional(),
});

export function parseTaskToolManifest(value: string) {
  return taskToolManifestSchema.parse(JSON.parse(value));
}

/** Tools that act on the chat thread of the calling task; useless on any other task. */
export const CHAT_TASK_ONLY_TOOLS: readonly string[] = ["chat-reply"];

/** True when the task came from a Chat SDK thread (contextKey family `chat-sdk`). */
export function isChatSdkTask(task: { contextKey?: string | null }): boolean {
  return chatThreadOfContextKey(task.contextKey) !== null;
}

export function selectTaskTools(
  manifest: z.infer<typeof taskToolManifestSchema>,
  task: {
    taskType?: string;
    scheduleId?: string;
    slackChannelId?: string;
    contextKey?: string | null;
  },
): string[] {
  const fromSchedule =
    task.scheduleId && Object.hasOwn(manifest.schedules ?? {}, task.scheduleId)
      ? manifest.schedules?.[task.scheduleId]
      : undefined;
  const fromType =
    task.taskType && Object.hasOwn(manifest.taskTypes ?? {}, task.taskType)
      ? manifest.taskTypes?.[task.taskType]
      : undefined;
  const chatTask = isChatSdkTask(task);
  return [...new Set(fromSchedule ?? fromType ?? [])].filter(
    (name) =>
      (!name.startsWith("slack-") || Boolean(task.slackChannelId)) &&
      (chatTask || !CHAT_TASK_ONLY_TOOLS.includes(name)),
  );
}

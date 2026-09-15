import { z } from "zod";
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

export function selectTaskTools(
  manifest: z.infer<typeof taskToolManifestSchema>,
  task: { taskType?: string; scheduleId?: string; slackChannelId?: string },
): string[] {
  const fromSchedule =
    task.scheduleId && Object.hasOwn(manifest.schedules ?? {}, task.scheduleId)
      ? manifest.schedules?.[task.scheduleId]
      : undefined;
  const fromType =
    task.taskType && Object.hasOwn(manifest.taskTypes ?? {}, task.taskType)
      ? manifest.taskTypes?.[task.taskType]
      : undefined;
  return [...new Set(fromSchedule ?? fromType ?? [])].filter(
    (name) => !name.startsWith("slack-") || Boolean(task.slackChannelId),
  );
}

import { CronExpressionParser } from "cron-parser";
import {
  computeContentHash,
  createScheduledTask,
  getScheduledTaskByName,
  getWorkflow,
  getWorkflowByName,
  updateScheduledTask,
} from "../db";
import { ADDONS, type Addon, type AddonScheduleDef, canonicalJson } from "./addons";
import type { Seeder, SeedItem } from "./types";

type ScheduleSeedItem = SeedItem & { schedule: AddonScheduleDef };

function scheduleSeedHash(schedule: AddonScheduleDef): string {
  const base = {
    name: schedule.name,
    description: schedule.description,
    cronExpression: schedule.cronExpression,
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    targetType: schedule.targetType,
  };
  if (schedule.targetType === "workflow") {
    return computeContentHash(canonicalJson({ ...base, workflowName: schedule.workflowName }));
  }
  return computeContentHash(
    canonicalJson({
      ...base,
      taskTemplate: schedule.taskTemplate,
      taskType: schedule.taskType,
      targetAgentId: schedule.targetAgentId,
      tags: schedule.tags ?? [],
    }),
  );
}

function nextRunAt(schedule: AddonScheduleDef): string | null {
  try {
    const interval = CronExpressionParser.parse(schedule.cronExpression, {
      currentDate: new Date(),
      tz: schedule.timezone || "UTC",
    });
    return schedule.enabled ? interval.next().toISOString() : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid cron expression";
    throw new Error(`Invalid cron expression: ${message}`);
  }
}

export function createSchedulesSeeder(addons: readonly Addon[] = ADDONS): Seeder<ScheduleSeedItem> {
  return {
    kind: "schedule",

    items(): ScheduleSeedItem[] {
      return addons.flatMap((addon) =>
        addon.schedules.map((schedule) => ({
          key: schedule.name,
          contentHash: scheduleSeedHash(schedule),
          schedule,
        })),
      );
    },

    upstreamHash(item): string | null {
      const existing = getScheduledTaskByName(item.key);
      if (!existing) return null;
      if (existing.targetType === "workflow") {
        return computeContentHash(
          canonicalJson({
            name: existing.name,
            description: existing.description ?? "",
            cronExpression: existing.cronExpression,
            timezone: existing.timezone,
            enabled: existing.enabled,
            targetType: existing.targetType,
            workflowName: existing.workflowId
              ? (getWorkflow(existing.workflowId)?.name ?? null)
              : null,
          }),
        );
      }
      if (existing.targetType === "agent-task") {
        return computeContentHash(
          canonicalJson({
            name: existing.name,
            description: existing.description ?? "",
            cronExpression: existing.cronExpression,
            timezone: existing.timezone,
            enabled: existing.enabled,
            targetType: existing.targetType,
            taskTemplate: existing.taskTemplate,
            taskType: existing.taskType,
            targetAgentId: existing.targetAgentId,
            tags: existing.tags,
          }),
        );
      }
      return computeContentHash(
        canonicalJson({
          name: existing.name,
          description: existing.description ?? "",
          cronExpression: existing.cronExpression,
          timezone: existing.timezone,
          enabled: existing.enabled,
          targetType: existing.targetType,
        }),
      );
    },

    apply(item): void {
      const { schedule } = item;
      const resolvedNextRunAt = nextRunAt(schedule);
      const existing = getScheduledTaskByName(schedule.name);

      if (schedule.targetType === "workflow") {
        const workflow = getWorkflowByName(schedule.workflowName);
        if (!workflow) {
          throw new Error(
            `Workflow "${schedule.workflowName}" for schedule "${schedule.name}" was not found`,
          );
        }
        const data = {
          name: schedule.name,
          description: schedule.description,
          cronExpression: schedule.cronExpression,
          timezone: schedule.timezone,
          enabled: schedule.enabled,
          targetType: schedule.targetType,
          workflowId: workflow.id,
        } as const;
        if (existing) updateScheduledTask(existing.id, { ...data, nextRunAt: resolvedNextRunAt });
        else createScheduledTask({ ...data, nextRunAt: resolvedNextRunAt ?? undefined });
        return;
      }

      const data = {
        name: schedule.name,
        description: schedule.description,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone,
        enabled: schedule.enabled,
        targetType: schedule.targetType,
        taskTemplate: schedule.taskTemplate,
        taskType: schedule.taskType,
        targetAgentId: schedule.targetAgentId,
        tags: schedule.tags ?? [],
      } as const;
      if (existing) updateScheduledTask(existing.id, { ...data, nextRunAt: resolvedNextRunAt });
      else createScheduledTask({ ...data, nextRunAt: resolvedNextRunAt ?? undefined });
    },
  };
}

export const schedulesSeeder = createSchedulesSeeder();

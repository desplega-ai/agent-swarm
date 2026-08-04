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
import { isPristineSeededWorkflow } from "./workflows-seeder";

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
        // Prefer the binding this schedule already has: re-resolving by name on every
        // reseed would let a later rename/replacement silently re-point an operator's
        // schedule. Only fall back to name resolution when there is nothing to keep, or
        // when the current binding no longer refers to the workflow we ship.
        const boundWorkflow = existing?.workflowId ? getWorkflow(existing.workflowId) : null;
        const workflow =
          boundWorkflow?.name === schedule.workflowName
            ? boundWorkflow
            : getWorkflowByName(schedule.workflowName);
        if (!workflow) {
          throw new Error(
            `Workflow "${schedule.workflowName}" for schedule "${schedule.name}" was not found`,
          );
        }
        // A name match is not proof of ownership. If the operator already had a workflow
        // called e.g. "dream", the workflow seeder preserved it as user-modified — binding
        // an enabled add-on schedule to it would run arbitrary user graph every night
        // without them opting in. Fail loudly (seed failures are logged and retried on the
        // next boot) instead of scheduling something we did not ship.
        if (
          workflow.id !== boundWorkflow?.id &&
          !isPristineSeededWorkflow(schedule.workflowName, addons)
        ) {
          throw new Error(
            `Workflow "${schedule.workflowName}" for schedule "${schedule.name}" exists but is not ` +
              `the unmodified add-on seed — refusing to schedule a workflow this add-on does not own`,
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

import { CronExpressionParser } from "cron-parser";
import dailyBlockerDigestConfig from "../../../templates/schedules/daily-blocker-digest/config.json" with {
  type: "text",
};
import dailyBlockerDigestContent from "../../../templates/schedules/daily-blocker-digest/content.md" with {
  type: "text",
};
import dailyCompoundingReflectionConfig from "../../../templates/schedules/daily-compounding-reflection/config.json" with {
  type: "text",
};
import dailyCompoundingReflectionContent from "../../../templates/schedules/daily-compounding-reflection/content.md" with {
  type: "text",
};
import dailyStatusReportConfig from "../../../templates/schedules/daily-status-report/config.json" with {
  type: "text",
};
import dailyStatusReportContent from "../../../templates/schedules/daily-status-report/content.md" with {
  type: "text",
};
import dailyWorkflowHealthAuditConfig from "../../../templates/schedules/daily-workflow-health-audit/config.json" with {
  type: "text",
};
import dailyWorkflowHealthAuditContent from "../../../templates/schedules/daily-workflow-health-audit/content.md" with {
  type: "text",
};
import gtmWeeklyReviewConfig from "../../../templates/schedules/gtm-weekly-review/config.json" with {
  type: "text",
};
import gtmWeeklyReviewContent from "../../../templates/schedules/gtm-weekly-review/content.md" with {
  type: "text",
};
import weeklyCodeHealthReportsConfig from "../../../templates/schedules/weekly-code-health-reports/config.json" with {
  type: "text",
};
import weeklyCodeHealthReportsContent from "../../../templates/schedules/weekly-code-health-reports/content.md" with {
  type: "text",
};
import weeklyDependabotTriageConfig from "../../../templates/schedules/weekly-dependabot-triage/config.json" with {
  type: "text",
};
import weeklyDependabotTriageContent from "../../../templates/schedules/weekly-dependabot-triage/content.md" with {
  type: "text",
};
import weeklyDoraMetricsConfig from "../../../templates/schedules/weekly-dora-metrics/config.json" with {
  type: "text",
};
import weeklyDoraMetricsContent from "../../../templates/schedules/weekly-dora-metrics/content.md" with {
  type: "text",
};
import type { AutomationIntegrationId, ScheduledTask } from "../../types";
import {
  computeContentHash,
  createScheduledTask,
  getScheduledTaskByName,
  updateScheduledTask,
} from "../db";
import type { Seeder, SeedItem } from "./types";
import { canonicalJson } from "./workflows-seeder";

type ScheduleTemplateConfig = {
  name: string;
  title: string;
  description: string;
  placeholders?: string[];
  requires?: AutomationIntegrationId[];
  runAllSeedersCandidate?: boolean;
  tags?: string[];
};

type ScheduleBlock = {
  cron: string;
  timezone?: string;
  enabled?: boolean;
};

export type SeedSchedule = {
  name: string;
  description: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  taskTemplate: string;
  taskType: string;
  tags: string[];
  params: Record<string, unknown>;
  requiredParams: string[];
  requires: AutomationIntegrationId[];
};

export type ScheduleTemplateSource = { config: string; content: string };
type ScheduleSeedItem = SeedItem & { schedule: SeedSchedule };

const asText = (value: unknown): string => value as string;

const BUILT_IN_SCHEDULE_SOURCES: readonly ScheduleTemplateSource[] = [
  { config: asText(dailyBlockerDigestConfig), content: asText(dailyBlockerDigestContent) },
  {
    config: asText(dailyCompoundingReflectionConfig),
    content: asText(dailyCompoundingReflectionContent),
  },
  { config: asText(dailyStatusReportConfig), content: asText(dailyStatusReportContent) },
  {
    config: asText(dailyWorkflowHealthAuditConfig),
    content: asText(dailyWorkflowHealthAuditContent),
  },
  { config: asText(gtmWeeklyReviewConfig), content: asText(gtmWeeklyReviewContent) },
  {
    config: asText(weeklyCodeHealthReportsConfig),
    content: asText(weeklyCodeHealthReportsContent),
  },
  {
    config: asText(weeklyDependabotTriageConfig),
    content: asText(weeklyDependabotTriageContent),
  },
  { config: asText(weeklyDoraMetricsConfig), content: asText(weeklyDoraMetricsContent) },
];

function parseScheduleSource(source: ScheduleTemplateSource): SeedSchedule | null {
  const config = JSON.parse(source.config) as ScheduleTemplateConfig;
  if (!config.runAllSeedersCandidate) return null;

  const scheduleHeading = source.content.match(/## Schedule\s*\n+/);
  const scheduleStart = scheduleHeading
    ? scheduleHeading.index! + scheduleHeading[0].length
    : source.content.indexOf("```json");
  const scheduleText = source.content.slice(scheduleStart);
  const blockMatch = scheduleText.match(/(?:```json\s*\n)?(\{[\s\S]*?\})(?:\n```)?/);
  if (!blockMatch?.[1]) throw new Error(`Schedule template ${config.name} has no schedule JSON`);
  const block = JSON.parse(blockMatch[1]) as ScheduleBlock;
  const afterBlock = scheduleStart + blockMatch.index! + blockMatch[0].length;
  const taskHeading = source.content.indexOf("## Scheduled Task", afterBlock);
  const taskTemplate = source.content
    .slice(taskHeading >= 0 ? taskHeading + "## Scheduled Task".length : afterBlock)
    .trim();
  if (!taskTemplate) throw new Error(`Schedule template ${config.name} has no task prompt`);

  return {
    name: config.name,
    description: config.description,
    cronExpression: block.cron,
    timezone: block.timezone ?? "UTC",
    enabled: block.enabled !== false,
    taskTemplate,
    taskType: config.title,
    tags: config.tags ?? [],
    params: {},
    requiredParams: config.placeholders ?? [],
    requires: config.requires ?? [],
  };
}

export function loadSeedSchedules(
  sources: readonly ScheduleTemplateSource[] = BUILT_IN_SCHEDULE_SOURCES,
): SeedSchedule[] {
  return sources
    .map(parseScheduleSource)
    .filter((schedule): schedule is SeedSchedule => schedule !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function scheduleSeedHash(schedule: SeedSchedule): string {
  return computeContentHash(canonicalJson(schedule));
}

function scheduleFromRow(schedule: ScheduledTask): SeedSchedule {
  return {
    name: schedule.name,
    description: schedule.description ?? "",
    cronExpression: schedule.cronExpression ?? "",
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    taskTemplate: schedule.taskTemplate ?? "",
    taskType: schedule.taskType ?? "",
    tags: schedule.tags,
    params: schedule.params ?? {},
    requiredParams: schedule.requiredParams ?? [],
    requires: schedule.requires ?? [],
  };
}

function nextRunAt(schedule: SeedSchedule): string | null {
  try {
    const interval = CronExpressionParser.parse(schedule.cronExpression, {
      currentDate: new Date(),
      tz: schedule.timezone,
    });
    return schedule.enabled ? interval.next().toISOString() : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid cron expression";
    throw new Error(`Invalid cron expression: ${message}`);
  }
}

export function createSchedulesSeeder(
  sources: readonly ScheduleTemplateSource[] = BUILT_IN_SCHEDULE_SOURCES,
): Seeder<ScheduleSeedItem> {
  const schedules = loadSeedSchedules(sources);
  return {
    kind: "schedule",

    items(): ScheduleSeedItem[] {
      return schedules.map((schedule) => ({
        key: schedule.name,
        contentHash: scheduleSeedHash(schedule),
        schedule,
      }));
    },

    async upstreamHash(item): Promise<string | null> {
      const existing = await getScheduledTaskByName(item.key);
      return existing ? scheduleSeedHash(scheduleFromRow(existing)) : null;
    },

    async apply(item): Promise<void> {
      const { schedule } = item;
      const resolvedNextRunAt = nextRunAt(schedule);
      const data = {
        description: schedule.description,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone,
        enabled: schedule.enabled,
        targetType: "agent-task" as const,
        taskTemplate: schedule.taskTemplate,
        taskType: schedule.taskType,
        tags: schedule.tags,
        params: schedule.params,
        requiredParams: schedule.requiredParams,
        requires: schedule.requires,
      };
      const existing = await getScheduledTaskByName(schedule.name);
      if (existing) {
        await updateScheduledTask(existing.id, { ...data, nextRunAt: resolvedNextRunAt });
      } else {
        await createScheduledTask({
          name: schedule.name,
          ...data,
          nextRunAt: resolvedNextRunAt ?? undefined,
        });
      }
    },
  };
}

export const schedulesSeeder = createSchedulesSeeder();

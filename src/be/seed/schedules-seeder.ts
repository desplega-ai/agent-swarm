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
import dailyHnBriefingConfig from "../../../templates/schedules/daily-hn-briefing/config.json" with {
  type: "text",
};
import dailyHnBriefingContent from "../../../templates/schedules/daily-hn-briefing/content.md" with {
  type: "text",
};
import dailyStatusReportConfig from "../../../templates/schedules/daily-status-report/config.json" with {
  type: "text",
};
import dailyStatusReportContent from "../../../templates/schedules/daily-status-report/content.md" with {
  type: "text",
};
import dailySwarmUpdateCheckConfig from "../../../templates/schedules/daily-swarm-update-check/config.json" with {
  type: "text",
};
import dailySwarmUpdateCheckContent from "../../../templates/schedules/daily-swarm-update-check/content.md" with {
  type: "text",
};
import dailyWorkflowHealthAuditConfig from "../../../templates/schedules/daily-workflow-health-audit/config.json" with {
  type: "text",
};
import dailyWorkflowHealthAuditContent from "../../../templates/schedules/daily-workflow-health-audit/content.md" with {
  type: "text",
};
import dreamingDailyConfig from "../../../templates/schedules/dreaming-daily/config.json" with {
  type: "text",
};
import dreamingDailyContent from "../../../templates/schedules/dreaming-daily/content.md" with {
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
import weeklyHarnessUpgradeCheckConfig from "../../../templates/schedules/weekly-harness-upgrade-check/config.json" with {
  type: "text",
};
import weeklyHarnessUpgradeCheckContent from "../../../templates/schedules/weekly-harness-upgrade-check/content.md" with {
  type: "text",
};
import type { AutomationIntegrationId, ScheduledTask } from "../../types";
import {
  computeContentHash,
  createScheduledTask,
  getScheduledTaskByName,
  getWorkflow,
  listWorkflows,
  updateScheduledTask,
} from "../db";
import { getScript } from "../scripts/db";
import { resolveSeededEnabled } from "./automation-toggle";
import type { Seeder, SeedItem } from "./types";
import { canonicalJson } from "./workflows-seeder";

type ScheduleTemplateConfig = {
  name: string;
  title: string;
  description: string;
  placeholders?: string[];
  requires?: AutomationIntegrationId[];
  runAllSeedersCandidate?: boolean;
  /** Explicit, reviewed opt-in into the auto-enable policy — see ./automation-toggle. */
  autoEnableCandidate?: boolean;
  tags?: string[];
};

type ScheduleBlock = {
  cron: string;
  timezone?: string;
  enabled?: boolean;
  /** What a fire runs. Default `agent-task`: the `## Scheduled Task` prompt becomes a task. */
  targetType?: ScheduleTargetType;
  /** `targetType: "workflow"`: the workflow's name, resolved to its id at apply time. */
  workflow?: string;
  /** `targetType: "script"`: a global script, run directly with `scriptArgs`. */
  scriptName?: string;
  scriptArgs?: Record<string, unknown>;
};

type ScheduleTargetType = "agent-task" | "workflow" | "script";
const TARGET_TYPES: readonly ScheduleTargetType[] = ["agent-task", "workflow", "script"];

/**
 * The non-default target of a seeded schedule. Agent-task schedules carry none
 * of these keys, so their seed hash is unchanged from before targets existed
 * and recorded seed state on existing installs still matches.
 */
type SeedScheduleTarget =
  | { targetType: "workflow"; workflow: string }
  | { targetType: "script"; scriptName: string; scriptArgs: Record<string, unknown> };

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
} & (SeedScheduleTarget | { targetType?: undefined });

export type ScheduleTemplateSource = { config: string; content: string };
type ScheduleSeedItem = SeedItem & { schedule: SeedSchedule };

const asText = (value: unknown): string => value as string;

const BUILT_IN_SCHEDULE_SOURCES: readonly ScheduleTemplateSource[] = [
  { config: asText(dailyBlockerDigestConfig), content: asText(dailyBlockerDigestContent) },
  {
    config: asText(dailyCompoundingReflectionConfig),
    content: asText(dailyCompoundingReflectionContent),
  },
  { config: asText(dailyHnBriefingConfig), content: asText(dailyHnBriefingContent) },
  { config: asText(dailyStatusReportConfig), content: asText(dailyStatusReportContent) },
  {
    config: asText(dailySwarmUpdateCheckConfig),
    content: asText(dailySwarmUpdateCheckContent),
  },
  {
    config: asText(dailyWorkflowHealthAuditConfig),
    content: asText(dailyWorkflowHealthAuditContent),
  },
  { config: asText(dreamingDailyConfig), content: asText(dreamingDailyContent) },
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
  {
    config: asText(weeklyHarnessUpgradeCheckConfig),
    content: asText(weeklyHarnessUpgradeCheckContent),
  },
];

function parseScheduleSource(source: ScheduleTemplateSource): SeedSchedule | null {
  const config = JSON.parse(source.config) as ScheduleTemplateConfig;
  if (!config.runAllSeedersCandidate) return null;

  const scheduleHeading = source.content.match(/## Schedule\s*\n+/);
  const scheduleStart = scheduleHeading
    ? scheduleHeading.index! + scheduleHeading[0].length
    : source.content.indexOf("```json");
  const scheduleText = source.content.slice(scheduleStart);
  const blockMatch =
    scheduleText.match(/^\s*```json\s*\n([\s\S]*?)\n```/) ?? scheduleText.match(/(\{[\s\S]*?\})/);
  if (!blockMatch?.[1]) throw new Error(`Schedule template ${config.name} has no schedule JSON`);
  const block = JSON.parse(blockMatch[1]) as ScheduleBlock;
  const afterBlock = scheduleStart + blockMatch.index! + blockMatch[0].length;
  const taskHeading = source.content.indexOf("## Scheduled Task", afterBlock);
  const target = parseScheduleTarget(config.name, block);
  let taskTemplate = "";
  if (target) {
    // A workflow or script fire never reads a prompt: shipping one is a mistake.
    if (taskHeading >= 0) {
      throw new Error(
        `Schedule template ${config.name} targets a ${target.targetType} but ships a ## Scheduled Task prompt it would ignore`,
      );
    }
  } else {
    taskTemplate = source.content
      .slice(taskHeading >= 0 ? taskHeading + "## Scheduled Task".length : afterBlock)
      .trim();
    if (!taskTemplate) throw new Error(`Schedule template ${config.name} has no task prompt`);
  }

  const requires = config.requires ?? [];
  const requiredParams = config.placeholders ?? [];
  return {
    name: config.name,
    description: config.description,
    cronExpression: block.cron,
    timezone: block.timezone ?? "UTC",
    // Boot seeding always inventories the automation. Whether it also arrives
    // enabled is gated by the operator switch (SEED_AUTOMATIONS_ENABLED), the
    // item being zero-config (no requires/placeholders), the template's own
    // explicit autoEnableCandidate opt-in, and the template not explicitly
    // recommending it stay off. See ./automation-toggle.
    enabled: resolveSeededEnabled({
      requires,
      requiredParams,
      autoEnableCandidate: config.autoEnableCandidate === true,
      templateRecommendsEnabled: block.enabled !== false,
    }),
    taskTemplate,
    taskType: config.title,
    tags: config.tags ?? [],
    params: {},
    requiredParams,
    requires,
    ...target,
  };
}

/** Validate the block's target fields. Returns null for the default agent-task target. */
function parseScheduleTarget(name: string, block: ScheduleBlock): SeedScheduleTarget | null {
  const targetType = block.targetType ?? "agent-task";
  if (!TARGET_TYPES.includes(targetType)) {
    throw new Error(`Schedule template ${name} has unknown targetType "${targetType}"`);
  }
  const stray = (fields: (keyof ScheduleBlock)[]) => {
    const set = fields.filter((field) => block[field] !== undefined);
    if (set.length > 0) {
      throw new Error(
        `Schedule template ${name} (targetType ${targetType}) sets ${set.join(", ")}, which it would ignore`,
      );
    }
  };
  switch (targetType) {
    case "agent-task":
      stray(["workflow", "scriptName", "scriptArgs"]);
      return null;
    case "workflow":
      stray(["scriptName", "scriptArgs"]);
      if (!block.workflow) throw new Error(`Schedule template ${name} has no workflow name`);
      return { targetType, workflow: block.workflow };
    case "script":
      stray(["workflow"]);
      if (!block.scriptName) throw new Error(`Schedule template ${name} has no scriptName`);
      return { targetType, scriptName: block.scriptName, scriptArgs: block.scriptArgs ?? {} };
  }
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

async function scheduleTargetFromRow(
  schedule: ScheduledTask,
): Promise<SeedScheduleTarget | undefined> {
  switch (schedule.targetType) {
    case "workflow": {
      const workflow = schedule.workflowId ? await getWorkflow(schedule.workflowId) : null;
      // A dangling id can never equal a seeded name, so the row reads as edited.
      return { targetType: "workflow", workflow: workflow?.name ?? `id:${schedule.workflowId}` };
    }
    case "script":
      return {
        targetType: "script",
        scriptName: schedule.scriptName ?? "",
        scriptArgs: schedule.scriptArgs ?? {},
      };
    default:
      return undefined;
  }
}

async function scheduleFromRow(schedule: ScheduledTask): Promise<SeedSchedule> {
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
    ...(await scheduleTargetFromRow(schedule)),
  };
}

/** Resolve a seeded target to row fields, failing the item when its target is missing. */
async function resolveTargetFields(schedule: SeedSchedule) {
  switch (schedule.targetType) {
    case "workflow": {
      const name = schedule.workflow;
      const workflow = (await listWorkflows()).find((candidate) => candidate.name === name);
      if (!workflow) throw new Error(`Workflow "${name}" not found`);
      return {
        targetType: "workflow" as const,
        workflowId: workflow.id,
        scriptName: null,
        scriptArgs: null,
        taskTemplate: null,
      };
    }
    case "script": {
      if (!(await getScript({ name: schedule.scriptName, scope: "global" }))) {
        throw new Error(`Global script "${schedule.scriptName}" not found`);
      }
      return {
        targetType: "script" as const,
        workflowId: null,
        scriptName: schedule.scriptName,
        scriptArgs: schedule.scriptArgs,
        taskTemplate: null,
      };
    }
    default:
      return {
        targetType: "agent-task" as const,
        workflowId: null,
        scriptName: null,
        scriptArgs: null,
        taskTemplate: schedule.taskTemplate,
      };
  }
}

function nextRunAt(schedule: SeedSchedule): string | null {
  try {
    // Disabled templates can await a required timezone parameter. Validate the
    // cron in UTC until setup supplies it, retaining the placeholder in the row.
    const timezonePending =
      !schedule.enabled &&
      schedule.requiredParams.some((param) => schedule.timezone.includes(`{{${param}}}`));
    const interval = CronExpressionParser.parse(schedule.cronExpression, {
      currentDate: new Date(),
      tz: timezonePending ? "UTC" : schedule.timezone,
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
      return existing ? scheduleSeedHash(await scheduleFromRow(existing)) : null;
    },

    async apply(item): Promise<void> {
      const { schedule } = item;
      const resolvedNextRunAt = nextRunAt(schedule);
      const data = {
        description: schedule.description,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone,
        enabled: schedule.enabled,
        ...(await resolveTargetFields(schedule)),
        taskType: schedule.taskType,
        tags: schedule.tags,
        params: schedule.params,
        requiredParams: schedule.requiredParams,
        requires: schedule.requires,
      };
      const existing = await getScheduledTaskByName(schedule.name);
      if (existing) {
        // Nulls clear the previous target's fields when a template changes target.
        await updateScheduledTask(existing.id, { ...data, nextRunAt: resolvedNextRunAt });
      } else {
        await createScheduledTask({
          name: schedule.name,
          ...data,
          workflowId: data.workflowId ?? undefined,
          scriptName: data.scriptName ?? undefined,
          scriptArgs: data.scriptArgs ?? undefined,
          taskTemplate: data.taskTemplate ?? undefined,
          nextRunAt: resolvedNextRunAt ?? undefined,
        });
      }
    },
  };
}

export const schedulesSeeder = createSchedulesSeeder();

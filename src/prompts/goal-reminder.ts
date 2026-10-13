// Worker-side hooks do not load base-prompt, which normally registers these
// code-default templates.
import "./session-templates.ts";
import { resolveTemplateAsync, resolveTemplateFromCode } from "./resolver.ts";

const GOAL_REMINDER_TEMPLATE = "system.agent.compaction.goal_reminder";

/**
 * Render the compaction goal reminder for `task`. Returns "" when an operator
 * disabled the template; falls back to the code default if resolution fails,
 * because losing the task anchor across compaction is worse than an unedited
 * reminder.
 */
export async function renderGoalReminder(task: {
  id: string;
  task: string;
  progress?: string;
}): Promise<string> {
  const variables = {
    taskId: task.id,
    task: task.task,
    progressLine: task.progress ? `\nCurrent Progress: ${task.progress}` : "",
  };
  try {
    const result = await resolveTemplateAsync(GOAL_REMINDER_TEMPLATE, variables);
    return result.skipped ? "" : result.text;
  } catch {
    return resolveTemplateFromCode(GOAL_REMINDER_TEMPLATE, variables).text;
  }
}

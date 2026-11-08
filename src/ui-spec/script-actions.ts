import { createLogEntry, getDbClient } from "../be/db";
import { getScript } from "../be/scripts/db";
import { runSavedScriptAsAgent } from "../be/scripts/run-saved";
import {
  acquireTaskUiScriptActionRun,
  finishTaskUiScriptActionRun,
  getTaskUiSpec,
  type TaskUiActionSurface,
  upsertTaskUiSpec,
} from "../be/task-ui-spec";
import type { AgentTask, ScriptRecord } from "../types";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  type TaskUiSpec,
  type TaskUiSpecAction,
  UI_SPEC_SCRIPT_ARGS_MAX_BYTES,
} from "../utils/task-ui-spec";
import { workflowEventBus } from "../workflows/event-bus";
import { validateJsonSchema } from "../workflows/json-schema-validator";
import type { TaskUiActionResult } from "./actions";
import { TaskUiSpecInputSchema } from "./schema";
import { parseScriptActionAllowlist, UI_SPEC_SCRIPT_ACTIONS_KEY } from "./script-allowlist";
import { validateTaskUiSpec } from "./validate";

/** The script's wall clock. The lease adds a margin, so a crashed run frees itself. */
export const UI_SPEC_SCRIPT_ACTION_TIMEOUT_MS = 30_000;
export const UI_SPEC_SCRIPT_ACTION_LEASE_MS = UI_SPEC_SCRIPT_ACTION_TIMEOUT_MS + 15_000;
/** Minimum gap between two runs of one action on one task. */
export const UI_SPEC_SCRIPT_ACTION_COOLDOWN_MS = 30_000;

/** Emitted after a script action replaced a task's card. Data: `{ taskId }`. */
export const TASK_UI_SPEC_UPDATED_EVENT = "task.ui_spec_updated";

type ScriptAction = Extract<TaskUiSpecAction, { kind: "script" }>;

type ResolvedScriptAction =
  | { ok: true; script: ScriptRecord }
  | { ok: false; reason: "not_allowlisted" | "script_changed" | "missing"; issue: string };

/**
 * The trust checks of one `script` action, at write time and again at click
 * time: the name is pinned in UI_SPEC_SCRIPT_ACTIONS, a global script with
 * that name exists, and its current contentHash matches a pin. A script edit
 * disarms its cards until a human re-pins it.
 */
export async function resolveScriptAction(
  actionId: string,
  action: ScriptAction,
): Promise<ResolvedScriptAction> {
  const pins = parseScriptActionAllowlist(process.env[UI_SPEC_SCRIPT_ACTIONS_KEY]).pins.filter(
    (pin) => pin.name === action.script,
  );
  if (pins.length === 0) {
    return {
      ok: false,
      reason: "not_allowlisted",
      issue: `Action "${actionId}" runs script "${action.script}", which is not allowlisted in UI_SPEC_SCRIPT_ACTIONS.`,
    };
  }
  const script = await getScript({ name: action.script, scope: "global" });
  if (!script) {
    return {
      ok: false,
      reason: "missing",
      issue: `Action "${actionId}" runs script "${action.script}", which is not a global script.`,
    };
  }
  if (!pins.some((pin) => script.contentHash.toLowerCase().startsWith(pin.hashPrefix))) {
    return {
      ok: false,
      reason: "script_changed",
      issue: `Action "${actionId}": script "${action.script}" changed since it was allowlisted (contentHash ${script.contentHash.slice(0, 12)}). A human must re-pin it in UI_SPEC_SCRIPT_ACTIONS.`,
    };
  }
  return { ok: true, script };
}

function argsIssue(actionId: string, action: ScriptAction, script: ScriptRecord): string | null {
  const args = action.args ?? {};
  const bytes = new TextEncoder().encode(JSON.stringify(args)).length;
  if (bytes > UI_SPEC_SCRIPT_ARGS_MAX_BYTES) {
    return `Action "${actionId}" args are ${bytes} bytes; the limit is ${UI_SPEC_SCRIPT_ARGS_MAX_BYTES}.`;
  }
  if (!script.argsJsonSchema) return null;
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(script.argsJsonSchema) as Record<string, unknown>;
  } catch {
    return `Action "${actionId}": script "${script.name}" has an unreadable argsJsonSchema.`;
  }
  const errors = validateJsonSchema(schema, args);
  return errors.length > 0
    ? `Action "${actionId}" args do not match the script's argsJsonSchema: ${errors[0]}`
    : null;
}

/** Write-time issues of every `script` action in `actions`. Empty when all pass. */
export async function scriptActionIssues(
  actions: Record<string, TaskUiSpecAction> | undefined,
): Promise<string[]> {
  const issues: string[] = [];
  for (const [actionId, action] of Object.entries(actions ?? {})) {
    if (action.kind !== "script") continue;
    if (!isEnvFlagEnabled("UI_SPEC_ACTIONS_ENABLED", false)) {
      issues.push(`Action "${actionId}" needs UI_SPEC_ACTIONS_ENABLED=true.`);
      continue;
    }
    const resolved = await resolveScriptAction(actionId, action);
    const issue = resolved.ok ? argsIssue(actionId, action, resolved.script) : resolved.issue;
    if (issue) issues.push(issue);
  }
  return issues;
}

/** One short scrubbed line for the clicker and `last_error`. */
function shortError(text: string): string {
  const line = scrubSecrets(text).replace(/\s+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

type ScriptOutcome =
  | { ok: true; uiSpec: TaskUiSpec }
  | { ok: false; kind: "script_failed" | "invalid_output"; error: string };

async function runAndValidate(
  task: AgentTask,
  action: ScriptAction,
  script: ScriptRecord,
  stored: TaskUiSpec,
): Promise<ScriptOutcome> {
  if (!task.agentId)
    return {
      ok: false,
      kind: "script_failed",
      error: "the task has no agent to run the script as",
    };
  // The script runs as the agent that wrote the card, so it never gets more
  // credentials than that agent. Only the frozen args reach it.
  const output = await runSavedScriptAsAgent({
    script,
    input: action.args ?? {},
    agentId: task.agentId,
    timeoutMs: UI_SPEC_SCRIPT_ACTION_TIMEOUT_MS,
  });
  if (output.exitCode !== 0 || output.error || output.runtimeError) {
    const reason = output.runtimeError
      ? `${output.runtimeError.name}: ${output.runtimeError.message}`
      : output.error
        ? `script ${output.error}`
        : `script exited ${output.exitCode}`;
    return { ok: false, kind: "script_failed", error: reason };
  }

  const parsed = TaskUiSpecInputSchema.safeParse(output.result);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "result";
    return {
      ok: false,
      kind: "invalid_output",
      error: `script output is not { spec, actions? }: ${path}: ${issue?.message ?? "invalid"}`,
    };
  }
  const newActions = parsed.data.actions;
  const scriptIssues = await scriptActionIssues(newActions);
  if (scriptIssues.length > 0)
    return { ok: false, kind: "invalid_output", error: scriptIssues[0] ?? "invalid action" };
  // A script that returns no actions keeps the stored ones, so Refresh survives.
  const actions = newActions ?? stored.actions;
  const validation = validateTaskUiSpec(
    { spec: parsed.data.spec, ...(actions ? { actions } : {}) },
    { taskId: task.id, actionsEnabled: true },
  );
  if (!validation.ok)
    return { ok: false, kind: "invalid_output", error: validation.issues[0] ?? "invalid uiSpec" };
  return {
    ok: true,
    uiSpec: {
      spec: validation.spec,
      ...(validation.actions ? { actions: validation.actions } : {}),
      fallbackText: validation.fallbackText,
    },
  };
}

/**
 * Re-runs a card's `script` action and replaces the card with its output.
 * Repeatable: a lease lock stops overlapping runs and a cooldown spaces them.
 * A failure keeps the old card.
 */
export async function runTaskUiScriptAction({
  task,
  actionId,
  action,
  stored,
  surface,
  actorUserId,
  slackUserId,
}: {
  task: AgentTask;
  actionId: string;
  action: ScriptAction;
  stored: TaskUiSpec;
  surface: TaskUiActionSurface;
  actorUserId: string;
  slackUserId?: string;
}): Promise<TaskUiActionResult> {
  const resolved = await resolveScriptAction(actionId, action);
  if (!resolved.ok) {
    if (resolved.reason === "missing") {
      return { status: "script_failed", error: `script "${action.script}" no longer exists` };
    }
    return { status: resolved.reason };
  }

  const lock = await acquireTaskUiScriptActionRun({
    taskId: task.id,
    actionId,
    surface,
    slackUserId,
    userId: actorUserId,
    leaseMs: UI_SPEC_SCRIPT_ACTION_LEASE_MS,
    cooldownMs: UI_SPEC_SCRIPT_ACTION_COOLDOWN_MS,
  });
  if (lock.status !== "acquired") return lock;

  let outcome: ScriptOutcome;
  try {
    outcome = await runAndValidate(task, action, resolved.script, stored);
  } catch (error) {
    outcome = {
      ok: false,
      kind: "script_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!outcome.ok) {
    const error = shortError(outcome.error);
    await finishTaskUiScriptActionRun(task.id, actionId, error);
    await createLogEntry({
      eventType: "task_ui_script_action_failed",
      ...(task.agentId ? { agentId: task.agentId } : {}),
      taskId: task.id,
      newValue: error,
      metadata: { actionId, script: action.script, kind: outcome.kind },
    });
    return { status: outcome.kind, error };
  }

  await upsertTaskUiSpec(task.id, outcome.uiSpec, actorUserId);
  await finishTaskUiScriptActionRun(task.id, actionId, null);
  getDbClient().afterCommit(() =>
    workflowEventBus.emit(TASK_UI_SPEC_UPDATED_EVENT, { taskId: task.id }),
  );
  // The stored row is the scrubbed one: return that, not the raw script output.
  return { status: "refreshed", uiSpec: (await getTaskUiSpec(task.id)) ?? outcome.uiSpec };
}

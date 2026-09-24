import { z } from "zod";
import { telemetry } from "../telemetry";
import type { ProviderName } from "../types";
import { getDbClient, getSwarmConfigs, getTaskById, upsertSwarmConfig } from "./db";

const ONBOARDING_CONFIG_KEY = "onboarding_state";

export const OnboardingStepIdSchema = z.enum([
  "connect",
  "name",
  "ai",
  "memory",
  "integrations",
  "first_task",
]);
export type OnboardingStepId = z.infer<typeof OnboardingStepIdSchema>;

export const OnboardingErrorClassSchema = z.enum([
  "auth",
  "network",
  "timeout",
  "dimension",
  "model",
  "not_enabled",
  "expired",
  "unknown",
]);
export type OnboardingErrorClass = z.infer<typeof OnboardingErrorClassSchema>;

const OnboardingStepStateSchema = z.object({
  status: z.enum(["todo", "done", "skipped", "failed"]),
  at: z.string().datetime().nullable(),
  method: z.string().nullable(),
  errorClass: OnboardingErrorClassSchema.nullable(),
});

export const OnboardingStateSchema = z.object({
  version: z.literal(1),
  startedAt: z.string().datetime(),
  currentStep: OnboardingStepIdSchema,
  minimizedAt: z.string().datetime().nullable(),
  dismissedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  autoCompleted: z.boolean(),
  firstTaskId: z.string().nullable(),
  steps: z.object({
    connect: OnboardingStepStateSchema,
    name: OnboardingStepStateSchema,
    ai: OnboardingStepStateSchema,
    memory: OnboardingStepStateSchema,
    integrations: OnboardingStepStateSchema,
    first_task: OnboardingStepStateSchema,
  }),
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export interface OnboardingSignals {
  providers: Array<{
    provider: ProviderName;
    state: "unverified" | "configured" | "verified";
    workers: number;
    verifiedWorkers: number;
  }>;
  embeddings: { configured: boolean; dimensions: number };
  integrations: {
    slack: boolean;
    github: boolean;
    gitlab: boolean;
    linear: boolean;
    jira: boolean;
  };
  agents: { leadsOnline: number; workersOnline: number };
  firstTask: { id: string; status: string } | null;
}

export type OnboardingAction =
  | { action: "view"; step: OnboardingStepId }
  | { action: "complete"; step: "connect"; method: "api_key" }
  | { action: "complete"; step: "name"; method: "custom_name" | "default_name" }
  | {
      action: "complete";
      step: "ai";
      method:
        | "claude_setup_token"
        | "claude_api_key"
        | "codex_device"
        | "codex_cli"
        | "openrouter"
        | "openai_gateway"
        | "deepseek"
        | "devin";
    }
  | {
      action: "complete";
      step: "integrations";
      method: "slack" | "github" | "gitlab" | "linear_oauth" | "jira_oauth";
    }
  | { action: "skip"; step: Exclude<OnboardingStepId, "connect"> }
  | { action: "fail"; step: OnboardingStepId; errorClass: OnboardingErrorClass }
  | { action: "first_task"; taskId: string; method: "suggestion" | "free_form" }
  | { action: "minimize" }
  | { action: "resume" }
  | { action: "dismiss" };

export type OnboardingMemoryPreset = "openai" | "openrouter" | "vercel" | "custom" | "existing";

type OnboardingTelemetryEvent =
  | "started"
  | "step_viewed"
  | "step_completed"
  | "step_skipped"
  | "step_failed"
  | "dismissed"
  | "completed"
  | "first_task_completed";

type PendingTelemetry = {
  event: OnboardingTelemetryEvent;
  properties: Record<string, string | boolean | number>;
};

type SignalLoader = (state: OnboardingState) => Promise<OnboardingSignals>;

function emptyStep(): OnboardingState["steps"][OnboardingStepId] {
  return { status: "todo", at: null, method: null, errorClass: null };
}

function freshState(now: string, autoCompleted: boolean): OnboardingState {
  return {
    version: 1,
    startedAt: now,
    currentStep: "connect",
    minimizedAt: null,
    dismissedAt: null,
    completedAt: autoCompleted ? now : null,
    autoCompleted,
    firstTaskId: null,
    steps: {
      connect: emptyStep(),
      name: emptyStep(),
      ai: emptyStep(),
      memory: emptyStep(),
      integrations: emptyStep(),
      first_task: emptyStep(),
    },
  };
}

function secondsSinceStart(state: OnboardingState): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(state.startedAt)) / 1_000));
}

function addTelemetry(
  events: PendingTelemetry[],
  state: OnboardingState,
  event: OnboardingTelemetryEvent,
  properties: Record<string, string | boolean | number> = {},
): void {
  events.push({
    event,
    properties: { ...properties, seconds_since_start: secondsSinceStart(state) },
  });
}

function queueTelemetry(events: PendingTelemetry[]): void {
  for (const item of events) {
    getDbClient().afterCommit(() => telemetry.onboarding(item.event, item.properties));
  }
}

async function isExistingInstall(): Promise<boolean> {
  const row = await getDbClient().get<{ existing: number }>(
    `SELECT CASE WHEN
       EXISTS (SELECT 1 FROM users LIMIT 1)
       OR EXISTS (SELECT 1 FROM agent_tasks WHERE requestedByUserId IS NOT NULL LIMIT 1)
       OR EXISTS (
         SELECT 1 FROM agent_tasks
         WHERE status = 'completed'
           AND (taskType IS NULL OR taskType NOT IN ('boot-triage', 'heartbeat-checklist'))
         LIMIT 1
       )
     THEN 1 ELSE 0 END AS existing`,
  );
  return row?.existing === 1;
}

async function loadState(
  events: PendingTelemetry[],
): Promise<{ state: OnboardingState; dirty: boolean }> {
  const rows = await getSwarmConfigs({ scope: "global", key: ONBOARDING_CONFIG_KEY });
  const stored = rows[0];
  if (stored) {
    try {
      const parsed = OnboardingStateSchema.safeParse(JSON.parse(stored.value));
      if (parsed.success) return { state: parsed.data, dirty: false };
    } catch {
      // Replace malformed state below.
    }
  }

  const now = new Date().toISOString();
  const existingInstall = stored ? false : await isExistingInstall();
  const state = freshState(now, existingInstall);
  addTelemetry(events, state, "started", { existing_install: existingInstall });
  return { state, dirty: true };
}

async function persistState(state: OnboardingState): Promise<void> {
  await upsertSwarmConfig({
    scope: "global",
    key: ONBOARDING_CONFIG_KEY,
    value: JSON.stringify(state),
    description: "Internal first-run onboarding state",
  });
}

function completeStep(
  state: OnboardingState,
  step: OnboardingStepId,
  method: string | null,
  derived: boolean,
  events: PendingTelemetry[],
): boolean {
  const current = state.steps[step];
  if (current.status === "done") {
    if (derived || current.method === method) return false;
    current.method = method;
    return true;
  }

  current.status = "done";
  current.at = new Date().toISOString();
  current.method = current.method ?? method;
  current.errorClass = null;
  addTelemetry(events, state, "step_completed", {
    step,
    ...(current.method ? { method: current.method } : {}),
    derived,
  });
  return true;
}

function inferAiMethod(signals: OnboardingSignals): string | null {
  const provider = signals.providers.find((entry) => entry.state === "verified")?.provider;
  if (provider === "claude") {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN ? "claude_setup_token" : "claude_api_key";
  }
  if (provider === "codex") return "codex_cli";
  if (provider === "pi" || provider === "opencode") {
    return process.env.OPENROUTER_BASE_URL ? "openai_gateway" : "openrouter";
  }
  if (provider === "dsh") return process.env.DEEPSEEK_API_KEY ? "deepseek" : "openrouter";
  if (provider === "devin") return "devin";
  return null;
}

function inferIntegrationMethod(signals: OnboardingSignals): string | null {
  if (signals.integrations.slack) return "slack";
  if (signals.integrations.github) return "github";
  if (signals.integrations.gitlab) return "gitlab";
  if (signals.integrations.linear) return "linear_oauth";
  if (signals.integrations.jira) return "jira_oauth";
  return null;
}

function deriveState(
  state: OnboardingState,
  signals: OnboardingSignals,
  funnelEvents: PendingTelemetry[],
): boolean {
  // Existing installs (R1) still derive, so "Run setup again" shows the true
  // state, but they never feed the funnel.
  const events = state.autoCompleted ? [] : funnelEvents;
  let changed = false;

  if (state.steps.connect.status !== "done") {
    changed = completeStep(state, "connect", "api_key", true, events) || changed;
  }
  if (
    state.steps.ai.status !== "done" &&
    signals.providers.some((entry) => entry.state === "verified")
  ) {
    changed = completeStep(state, "ai", inferAiMethod(signals), true, events) || changed;
  }
  const integrationMethod = inferIntegrationMethod(signals);
  if (state.steps.integrations.status !== "done" && integrationMethod) {
    changed = completeStep(state, "integrations", integrationMethod, true, events) || changed;
  }
  if (state.steps.first_task.status !== "done" && signals.firstTask?.status === "completed") {
    changed =
      completeStep(state, "first_task", state.steps.first_task.method, true, events) || changed;
    if (!state.completedAt) state.completedAt = new Date().toISOString();
    addTelemetry(events, state, "first_task_completed", {
      ...(state.steps.first_task.method ? { method: state.steps.first_task.method } : {}),
    });
    addTelemetry(events, state, "completed");
    changed = true;
  }

  return changed;
}

export class OnboardingTaskNotFoundError extends Error {}

async function applyAction(
  state: OnboardingState,
  action: OnboardingAction,
  events: PendingTelemetry[],
): Promise<boolean> {
  const now = new Date().toISOString();
  switch (action.action) {
    case "view":
      if (state.currentStep === action.step) return false;
      state.currentStep = action.step;
      addTelemetry(events, state, "step_viewed", { step: action.step });
      return true;
    case "complete":
      return completeStep(state, action.step, action.method, false, events);
    case "skip": {
      const step = state.steps[action.step];
      if (step.status === "done") return false;
      step.status = "skipped";
      step.at = now;
      step.errorClass = null;
      addTelemetry(events, state, "step_skipped", { step: action.step });
      return true;
    }
    case "fail": {
      const step = state.steps[action.step];
      if (step.status === "done") return false;
      step.status = "failed";
      step.at = now;
      step.errorClass = action.errorClass;
      addTelemetry(events, state, "step_failed", {
        step: action.step,
        error_class: action.errorClass,
      });
      return true;
    }
    case "first_task": {
      if (!(await getTaskById(action.taskId))) throw new OnboardingTaskNotFoundError();
      if (state.firstTaskId === action.taskId && state.steps.first_task.method === action.method) {
        return false;
      }
      state.firstTaskId = action.taskId;
      state.steps.first_task.method = action.method;
      return true;
    }
    case "minimize":
      if (state.minimizedAt) return false;
      state.minimizedAt = now;
      return true;
    case "resume":
      if (!state.minimizedAt && !state.dismissedAt) return false;
      state.minimizedAt = null;
      state.dismissedAt = null;
      return true;
    case "dismiss":
      state.dismissedAt = now;
      addTelemetry(events, state, "dismissed");
      return true;
  }
}

export async function readOrUpdateOnboarding(
  loadSignals: SignalLoader,
  action?: OnboardingAction,
): Promise<{ state: OnboardingState; signals: OnboardingSignals }> {
  return await getDbClient().transaction(async () => {
    const events: PendingTelemetry[] = [];
    const loaded = await loadState(events);
    const state = loaded.state;
    let dirty = loaded.dirty;
    let signals = await loadSignals(state);
    dirty = deriveState(state, signals, events) || dirty;
    if (action) dirty = (await applyAction(state, action, events)) || dirty;
    if (action?.action === "first_task") signals = await loadSignals(state);
    if (dirty) await persistState(state);
    queueTelemetry(events);
    return { state, signals };
  });
}

export async function updateOnboardingMemory(
  preset: OnboardingMemoryPreset,
  result: { ok: true } | { ok: false; errorClass: OnboardingErrorClass },
  saveConfig?: { baseUrl: string; model: string; apiKey?: string },
): Promise<boolean> {
  return await getDbClient().transaction(async () => {
    const events: PendingTelemetry[] = [];
    const loaded = await loadState(events);
    let dirty = loaded.dirty;

    if (saveConfig) {
      await upsertSwarmConfig({
        scope: "global",
        key: "EMBEDDING_API_BASE_URL",
        value: saveConfig.baseUrl,
      });
      await upsertSwarmConfig({ scope: "global", key: "EMBEDDING_MODEL", value: saveConfig.model });
      if (saveConfig.apiKey) {
        await upsertSwarmConfig({
          scope: "global",
          key: "EMBEDDING_API_KEY",
          value: saveConfig.apiKey,
          isSecret: true,
        });
      }
    }

    if (result.ok) {
      const step = loaded.state.steps.memory;
      const methodChanged = step.method !== preset;
      step.method = preset;
      dirty = completeStep(loaded.state, "memory", preset, false, events) || methodChanged || dirty;
    } else {
      const step = loaded.state.steps.memory;
      step.status = "failed";
      step.at = new Date().toISOString();
      step.errorClass = result.errorClass;
      addTelemetry(events, loaded.state, "step_failed", {
        step: "memory",
        error_class: result.errorClass,
      });
      dirty = true;
    }

    if (dirty) await persistState(loaded.state);
    queueTelemetry(events);
    return saveConfig !== undefined;
  });
}

export async function updateOnboardingAiFromCodexDevice(
  result: { status: "complete" } | { status: "failed"; errorClass: OnboardingErrorClass },
): Promise<boolean> {
  return await getDbClient().transaction(async () => {
    const rows = await getSwarmConfigs({ scope: "global", key: ONBOARDING_CONFIG_KEY });
    const stored = rows[0];
    if (!stored) return false;

    let parsed: ReturnType<typeof OnboardingStateSchema.safeParse>;
    try {
      parsed = OnboardingStateSchema.safeParse(JSON.parse(stored.value));
    } catch {
      return false;
    }
    if (!parsed.success || parsed.data.steps.ai.status === "done") return false;

    const state = parsed.data;
    const events: PendingTelemetry[] = [];
    if (result.status === "complete") {
      completeStep(state, "ai", "codex_device", false, events);
    } else {
      state.steps.ai.status = "failed";
      state.steps.ai.at = new Date().toISOString();
      state.steps.ai.errorClass = result.errorClass;
      addTelemetry(events, state, "step_failed", {
        step: "ai",
        error_class: result.errorClass,
      });
    }

    await persistState(state);
    queueTelemetry(events);
    return true;
  });
}

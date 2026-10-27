import { telemetry } from "../telemetry";
import { ProviderNameSchema, TERMINAL_TASK_STATUSES } from "../types";
import { getCurrentRequestUserId } from "../utils/request-auth-context";
import { z } from "../utils/zod-openapi";
import {
  deleteSwarmConfigByKey,
  getDbClient,
  getSwarmConfigs,
  getTaskById,
  upsertSwarmConfig,
} from "./db";
import { validateConfigValue } from "./swarm-config-guard";

const ONBOARDING_CONFIG_KEY = "onboarding_state";

export const OnboardingStepIdSchema = z.enum([
  "connect",
  "name",
  "ai",
  "agents",
  "memory",
  "integrations",
  "files",
  "first_task",
]);
export type OnboardingStepId = z.infer<typeof OnboardingStepIdSchema>;

export const OnboardingErrorClassSchema = z.enum([
  "auth",
  "network",
  "timeout",
  "dimension",
  "model",
  "endpoint",
  "not_enabled",
  "expired",
  "unknown",
]);
export type OnboardingErrorClass = z.infer<typeof OnboardingErrorClassSchema>;

export const OnboardingStepStatusSchema = z.enum(["todo", "done", "skipped", "failed"]);
export const OnboardingConnectMethodSchema = z.enum(["api_key"]);
export const OnboardingNameMethodSchema = z.enum(["custom_name", "default_name"]);
export const OnboardingAiMethodSchema = z.enum([
  "claude_setup_token",
  "claude_api_key",
  "codex_device",
  "codex_cli",
  "openrouter",
  "openai_gateway",
  "deepseek",
  "devin",
]);
/** The dial level every agent got, or `mixed` (different levels or a custom model). */
export const OnboardingAgentsMethodSchema = z.enum(["cheap", "optimal", "max", "mixed"]);
export const OnboardingMemoryPresetSchema = z.enum([
  "openai",
  "openrouter",
  "vercel",
  "azure",
  "custom",
  "existing",
]);
/**
 * Where the embeddings endpoint runs: `local` (this server or its private
 * network), the hosted preset whose host it calls, or `custom` (another host).
 */
export const OnboardingMemoryProviderSchema = z.enum([
  "local",
  "openai",
  "openrouter",
  "vercel",
  "azure",
  "custom",
]);
export type OnboardingMemoryProvider = z.infer<typeof OnboardingMemoryProviderSchema>;
export const OnboardingIntegrationMethodSchema = z.enum([
  "slack",
  "github",
  "gitlab",
  "bitbucket",
  "linear_oauth",
  "jira_oauth",
]);
/** `created`: the Files step registered a new agent-fs account. `connected`: it reused one. */
export const OnboardingFilesMethodSchema = z.enum(["created", "connected"]);
export const OnboardingFirstTaskMethodSchema = z.enum(["suggestion", "free_form"]);
export const OnboardingStepMethodSchema = z.union([
  OnboardingConnectMethodSchema,
  OnboardingNameMethodSchema,
  OnboardingAiMethodSchema,
  OnboardingAgentsMethodSchema,
  OnboardingMemoryPresetSchema,
  OnboardingIntegrationMethodSchema,
  OnboardingFilesMethodSchema,
  OnboardingFirstTaskMethodSchema,
]);
export type OnboardingStepMethod = z.infer<typeof OnboardingStepMethodSchema>;

function onboardingStepStateSchema<T extends z.ZodEnum>(method: T) {
  const tolerantMethod = z
    .preprocess((value) => {
      if (value === undefined || method.safeParse(value).success) return value;
      return null;
    }, method.nullable())
    .openapi({ type: ["string", "null"], enum: [...method.options, null] });

  return z.object({
    status: OnboardingStepStatusSchema,
    at: z.string().datetime().nullable(),
    method: tolerantMethod,
    errorClass: OnboardingErrorClassSchema.nullable(),
  });
}

const OnboardingConnectStepStateSchema = onboardingStepStateSchema(OnboardingConnectMethodSchema);
const OnboardingNameStepStateSchema = onboardingStepStateSchema(OnboardingNameMethodSchema);
const OnboardingAiStepStateSchema = onboardingStepStateSchema(OnboardingAiMethodSchema);
const OnboardingAgentsStepStateSchema = onboardingStepStateSchema(OnboardingAgentsMethodSchema);
const OnboardingMemoryStepStateSchema = onboardingStepStateSchema(OnboardingMemoryPresetSchema);
const OnboardingIntegrationStepStateSchema = onboardingStepStateSchema(
  OnboardingIntegrationMethodSchema,
);
const OnboardingFilesStepStateSchema = onboardingStepStateSchema(OnboardingFilesMethodSchema);
const OnboardingFirstTaskStepStateSchema = onboardingStepStateSchema(
  OnboardingFirstTaskMethodSchema,
);

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
    connect: OnboardingConnectStepStateSchema,
    name: OnboardingNameStepStateSchema,
    ai: OnboardingAiStepStateSchema,
    agents: OnboardingAgentsStepStateSchema,
    memory: OnboardingMemoryStepStateSchema,
    integrations: OnboardingIntegrationStepStateSchema,
    files: OnboardingFilesStepStateSchema,
    first_task: OnboardingFirstTaskStepStateSchema,
  }),
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export const OnboardingSignalsSchema = z.object({
  providers: z.array(
    z.object({
      provider: ProviderNameSchema,
      state: z.enum(["unverified", "configured", "verified"]),
      workers: z.number().int().nonnegative(),
      verifiedWorkers: z.number().int().nonnegative(),
      /** The latest live test failed: its error. */
      error: z.string().nullable(),
      /** The latest live test passed, but some pool keys failed: names them. */
      warning: z.string().nullable(),
    }),
  ),
  embeddings: z.object({
    configured: z.boolean(),
    dimensions: z.number().int().positive(),
    /** The embedding model memory search uses. Null while it is off. */
    model: z.string().nullable(),
    /**
     * The endpoint runs on this server or its private network (loopback, a
     * private address, or a single-label host such as `tei`). False while off.
     */
    local: z.boolean(),
    /** Where the endpoint runs, from its host only (never the URL). Null while off. */
    provider: OnboardingMemoryProviderSchema.nullable(),
    /**
     * The local setup of the deployment environment, also while a stored
     * hosted setup replaces it, so `/setup` can offer it again: the model of
     * its local endpoint. Null when the environment has no local endpoint.
     */
    localDefault: z.object({ model: z.string() }).nullable(),
  }),
  integrations: z.object({
    slack: z.boolean(),
    github: z.boolean(),
    gitlab: z.boolean(),
    bitbucket: z.boolean(),
    linear: z.boolean(),
    jira: z.boolean(),
  }),
  agents: z.object({
    leadsOnline: z.number().int().nonnegative(),
    workersOnline: z.number().int().nonnegative(),
  }),
  firstTask: z.object({ id: z.string(), status: z.string() }).nullable(),
  /** The Files step applies: Comb is on, so the browser can create an agent-fs account. */
  files: z.object({ enabled: z.boolean() }),
});
export type OnboardingSignals = z.infer<typeof OnboardingSignalsSchema>;

export const OnboardingResponseSchema = z.object({
  state: OnboardingStateSchema,
  signals: OnboardingSignalsSchema,
});

export const OnboardingActionSchema = z.union([
  z.object({ action: z.literal("view"), step: OnboardingStepIdSchema }).strict(),
  z
    .object({
      action: z.literal("complete"),
      step: z.literal("connect"),
      method: OnboardingConnectMethodSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("complete"),
      step: z.literal("name"),
      method: OnboardingNameMethodSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("complete"),
      step: z.literal("ai"),
      method: OnboardingAiMethodSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("complete"),
      step: z.literal("agents"),
      method: OnboardingAgentsMethodSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("complete"),
      step: z.literal("integrations"),
      method: OnboardingIntegrationMethodSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("complete"),
      step: z.literal("files"),
      method: OnboardingFilesMethodSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("skip"),
      step: z.enum(["name", "ai", "agents", "memory", "integrations", "files", "first_task"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("fail"),
      step: OnboardingStepIdSchema,
      errorClass: OnboardingErrorClassSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("first_task"),
      taskId: z.string().min(1),
      method: OnboardingFirstTaskMethodSchema,
    })
    .strict(),
  z.object({ action: z.literal("minimize") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
  z.object({ action: z.literal("dismiss") }).strict(),
]);
export type OnboardingAction = z.infer<typeof OnboardingActionSchema>;

export const OnboardingHttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "Must be an HTTP or HTTPS URL");

export const OnboardingMemoryRequestSchema = z
  .object({
    preset: OnboardingMemoryPresetSchema,
    baseUrl: OnboardingHttpUrlSchema.optional(),
    model: z.string().trim().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    reuseKey: z.enum(["OPENAI_API_KEY", "OPENROUTER_API_KEY"]).optional(),
    /**
     * With preset `existing`: test the setup of the deployment environment,
     * and when it works, delete the stored embeddings config so that setup
     * applies again. A failed test changes no config.
     */
    restoreDefault: z.boolean().optional(),
  })
  .strict()
  .refine((body) => !body.restoreDefault || body.preset === "existing", {
    message: "restoreDefault needs preset existing",
    path: ["restoreDefault"],
  });
export type OnboardingMemoryRequest = z.infer<typeof OnboardingMemoryRequestSchema>;

export const OnboardingMemoryResponseSchema = z.object({
  ok: z.boolean(),
  dimensions: z.number().int().positive().optional(),
  latencyMs: z.number().int().nonnegative(),
  error: z.string().optional(),
  errorClass: OnboardingErrorClassSchema.optional(),
});
export type OnboardingMemoryResponse = z.infer<typeof OnboardingMemoryResponseSchema>;
export type OnboardingMemoryPreset = z.infer<typeof OnboardingMemoryPresetSchema>;

type OnboardingTelemetryEvent =
  | "started"
  | "step_viewed"
  | "step_completed"
  | "step_skipped"
  | "step_failed"
  | "dismissed"
  | "completed"
  | "first_task_completed";

type OnboardingTelemetryProperties = {
  started: { existing_install: boolean; seconds_since_start: number };
  step_viewed: { step: OnboardingStepId; seconds_since_start: number };
  step_completed: {
    step: OnboardingStepId;
    method?: OnboardingStepMethod;
    derived: boolean;
    seconds_since_start: number;
  };
  step_skipped: { step: OnboardingStepId; seconds_since_start: number };
  step_failed: {
    step: OnboardingStepId;
    error_class: OnboardingErrorClass;
    seconds_since_start: number;
  };
  dismissed: { seconds_since_start: number };
  completed: { seconds_since_start: number };
  first_task_completed: {
    method?: z.infer<typeof OnboardingFirstTaskMethodSchema>;
    seconds_since_start: number;
  };
};

type PendingTelemetry = {
  [Event in OnboardingTelemetryEvent]: {
    event: Event;
    properties: OnboardingTelemetryProperties[Event];
  };
}[OnboardingTelemetryEvent];

type SignalLoader = (state: OnboardingState) => Promise<OnboardingSignals>;

function emptyStep(): { status: "todo"; at: null; method: null; errorClass: null } {
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
      agents: emptyStep(),
      memory: emptyStep(),
      integrations: emptyStep(),
      files: emptyStep(),
      first_task: emptyStep(),
    },
  };
}

/**
 * Parse the stored row. A step added after the row was written (for example
 * `agents`) starts as `todo`, so an older row keeps its progress.
 */
function parseStoredState(value: string): OnboardingState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (raw && typeof raw === "object" && "steps" in raw) {
    const steps = (raw as { steps: unknown }).steps;
    if (steps && typeof steps === "object") {
      const missing = Object.fromEntries(
        OnboardingStepIdSchema.options
          .filter((id) => !(id in steps))
          .map((id) => [id, emptyStep()]),
      );
      raw = { ...raw, steps: { ...steps, ...missing } };
    }
  }
  const parsed = OnboardingStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function secondsSinceStart(state: OnboardingState): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(state.startedAt)) / 1_000));
}

function addTelemetry<Event extends OnboardingTelemetryEvent>(
  events: PendingTelemetry[],
  state: OnboardingState,
  event: Event,
  properties: Omit<OnboardingTelemetryProperties[Event], "seconds_since_start">,
): void {
  events.push({
    event,
    properties: { ...properties, seconds_since_start: secondsSinceStart(state) },
  } as PendingTelemetry);
}

function queueTelemetry(events: PendingTelemetry[]): void {
  // Captured now: the request's user is ambient state, and the post-commit hook
  // may run after it has moved on. Null for an operator (API key) request.
  const actor = { userId: getCurrentRequestUserId() ?? null };
  for (const item of events) {
    getDbClient().afterCommit(() => telemetry.onboarding(item.event, item.properties, actor));
  }
}

/**
 * An install with a user, or with any task the swarm did not start on its own
 * (boot triage, the heartbeat checklist), was in use before onboarding. The
 * task status does not matter: failed or pending work is use too.
 */
async function isExistingInstall(): Promise<boolean> {
  const row = await getDbClient().get<{ existing: number }>(
    `SELECT CASE WHEN
       EXISTS (SELECT 1 FROM users LIMIT 1)
       OR EXISTS (
         SELECT 1 FROM agent_tasks
         WHERE taskType IS NULL OR taskType NOT IN ('boot-triage', 'heartbeat-checklist')
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
    const state = parseStoredState(stored.value);
    if (state) return { state, dirty: false };
    // Replace malformed state below.
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
  method: OnboardingStepMethod | null,
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

function markStepFailed(
  state: OnboardingState,
  step: OnboardingStepId,
  errorClass: OnboardingErrorClass,
  events: PendingTelemetry[],
): boolean {
  const current = state.steps[step];
  if (current.status === "done" || current.status === "failed") return false;

  current.status = "failed";
  current.at = new Date().toISOString();
  current.errorClass = errorClass;
  addTelemetry(events, state, "step_failed", { step, error_class: errorClass });
  return true;
}

function inferAiMethod(
  signals: OnboardingSignals,
): z.infer<typeof OnboardingAiMethodSchema> | null {
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

function inferIntegrationMethod(
  signals: OnboardingSignals,
): z.infer<typeof OnboardingIntegrationMethodSchema> | null {
  if (signals.integrations.slack) return "slack";
  if (signals.integrations.github) return "github";
  if (signals.integrations.gitlab) return "gitlab";
  if (signals.integrations.bitbucket) return "bitbucket";
  if (signals.integrations.linear) return "linear_oauth";
  if (signals.integrations.jira) return "jira_oauth";
  return null;
}

/**
 * How long ago the last task in the first task's tree must have finished.
 * The API creates the lead follow-up of a worker task only after the
 * completion commits (`runTaskTerminalEffects`). So for a short time, a tree
 * with no open task can still get a new task. On that path, each extension
 * pre-hook can take up to 5 s (`EXTENSION_HANDLER_TIMEOUT_MS`).
 */
const FIRST_TASK_SETTLE_MS = 10_000;

/**
 * True when the tree of `rootId` (all descendants through `parentTaskId`) has
 * settled: no task in it is open, no deferral in it waits to wake up, and its
 * last task finished `FIRST_TASK_SETTLE_MS` ago. A failed or cancelled task
 * is settled. The lead often completes the root task when it delegates, and
 * gives its answer in a later task of the same tree.
 */
async function isTaskTreeSettled(rootId: string): Promise<boolean> {
  const terminal = TERMINAL_TASK_STATUSES.map(() => "?").join(", ");
  // UNION (not UNION ALL) drops repeated ids, so a parentTaskId cycle ends the walk.
  const row = await getDbClient().get<{
    open: number;
    deferred: number;
    lastFinishedAt: string | null;
  }>(
    `WITH RECURSIVE tree(id) AS (
       SELECT ?
       UNION
       SELECT t.id FROM agent_tasks t JOIN tree ON t.parentTaskId = tree.id
     )
     SELECT
       COALESCE(SUM(t.status NOT IN (${terminal})), 0) AS open,
       EXISTS (
         SELECT 1 FROM scheduled_tasks s
         WHERE s.parentTaskId IN (SELECT id FROM tree)
           AND s.taskType = 'deferred' AND s.enabled = 1
       ) AS deferred,
       MAX(COALESCE(t.finishedAt, t.lastUpdatedAt)) AS lastFinishedAt
     FROM tree JOIN agent_tasks t ON t.id = tree.id`,
    [rootId, ...TERMINAL_TASK_STATUSES],
  );
  if (!row || row.open > 0 || row.deferred || !row.lastFinishedAt) return false;
  return Date.now() - Date.parse(row.lastFinishedAt) >= FIRST_TASK_SETTLE_MS;
}

async function deriveState(
  state: OnboardingState,
  signals: OnboardingSignals,
  funnelEvents: PendingTelemetry[],
): Promise<boolean> {
  // Existing installs (R1) still derive, so "Run setup again" shows the true
  // state, but they never feed the funnel.
  const events = state.autoCompleted ? [] : funnelEvents;
  let changed = false;

  if (state.steps.connect.status !== "done") {
    changed = completeStep(state, "connect", "api_key", true, events) || changed;
  }
  // A name saved anywhere (setup, the org-name popup, Settings, the API) names
  // the swarm. The old setup default "Your Swarm" does not count.
  const orgName = process.env.SWARM_ORG_NAME?.trim();
  if (state.steps.name.status !== "done" && orgName && orgName !== "Your Swarm") {
    changed = completeStep(state, "name", "custom_name", true, events) || changed;
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
  if (
    state.steps.first_task.status !== "done" &&
    signals.firstTask?.status === "completed" &&
    (await isTaskTreeSettled(signals.firstTask.id))
  ) {
    changed =
      completeStep(state, "first_task", state.steps.first_task.method, true, events) || changed;
    if (!state.completedAt) state.completedAt = new Date().toISOString();
    addTelemetry(events, state, "first_task_completed", {
      ...(state.steps.first_task.method ? { method: state.steps.first_task.method } : {}),
    });
    addTelemetry(events, state, "completed", {});
    changed = true;
  }

  return changed;
}

/**
 * The response view of the state. Without Comb the Files step cannot run, so a
 * stored `todo` reads as `skipped`. Response only: never persisted and never a
 * `step_skipped` event, so installs without Comb send no funnel noise and the
 * step comes back as `todo` once Comb is turned on.
 */
function presentState(state: OnboardingState, signals: OnboardingSignals): OnboardingState {
  if (signals.files.enabled || state.steps.files.status !== "todo") return state;
  return {
    ...state,
    steps: { ...state.steps, files: { ...state.steps.files, status: "skipped" } },
  };
}

export class OnboardingTaskNotFoundError extends Error {}

async function applyAction(
  state: OnboardingState,
  action: OnboardingAction,
  events: PendingTelemetry[],
): Promise<boolean> {
  const now = new Date().toISOString();
  const funnelEvents = state.autoCompleted ? [] : events;
  switch (action.action) {
    case "view":
      if (state.currentStep === action.step) return false;
      state.currentStep = action.step;
      addTelemetry(funnelEvents, state, "step_viewed", { step: action.step });
      return true;
    case "complete":
      return completeStep(state, action.step, action.method, false, funnelEvents);
    case "skip": {
      const step = state.steps[action.step];
      if (step.status === "done" || step.status === "skipped") return false;
      step.status = "skipped";
      step.at = now;
      step.errorClass = null;
      addTelemetry(funnelEvents, state, "step_skipped", { step: action.step });
      return true;
    }
    case "fail":
      return markStepFailed(state, action.step, action.errorClass, funnelEvents);
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
      if (state.dismissedAt) return false;
      state.dismissedAt = now;
      addTelemetry(funnelEvents, state, "dismissed", {});
      return true;
  }
}

async function loadAndDerive(
  loadSignals: SignalLoader,
  events: PendingTelemetry[],
): Promise<{
  state: OnboardingState;
  signals: OnboardingSignals;
  dirty: boolean;
}> {
  const loaded = await loadState(events);
  const signals = await loadSignals(loaded.state);
  const dirty = (await deriveState(loaded.state, signals, events)) || loaded.dirty;
  return { state: loaded.state, signals, dirty };
}

export async function readOrUpdateOnboarding(
  loadSignals: SignalLoader,
  action?: OnboardingAction,
): Promise<{ state: OnboardingState; signals: OnboardingSignals }> {
  const client = getDbClient();
  if (!action) {
    const read = await client.transaction(async () => await loadAndDerive(loadSignals, []), {
      readOnly: true,
    });
    if (!read.dirty)
      return { state: presentState(read.state, read.signals), signals: read.signals };
  }

  return await client.transaction(async () => {
    const events: PendingTelemetry[] = [];
    const loaded = await loadAndDerive(loadSignals, events);
    const state = loaded.state;
    let { dirty, signals } = loaded;
    if (action) {
      dirty = (await applyAction(state, action, events)) || dirty;
      signals = await loadSignals(state);
      dirty = (await deriveState(state, signals, events)) || dirty;
    }
    if (dirty) await persistState(state);
    queueTelemetry(events);
    return { state: presentState(state, signals), signals };
  });
}

/** The embeddings rows a memory probe writes or deletes. */
export const EMBEDDING_PREFIX_KEYS = [
  "EMBEDDING_QUERY_PREFIX",
  "EMBEDDING_DOCUMENT_PREFIX",
] as const;
export const EMBEDDING_CONFIG_KEYS = [
  "EMBEDDING_API_BASE_URL",
  "EMBEDDING_MODEL",
  "EMBEDDING_API_KEY",
  ...EMBEDDING_PREFIX_KEYS,
] as const;

/**
 * The config change of a passed memory probe:
 * - `save`: store the tested endpoint. `prefixes` sets a task prefix to an
 *   empty value (`""`), or deletes its stored row (`null`).
 * - `restore`: delete the stored embeddings rows, so the deployment
 *   environment applies again.
 */
export type MemoryConfigChange =
  | {
      kind: "save";
      baseUrl: string;
      model: string;
      apiKey?: string;
      prefixes: ReadonlyArray<{ key: (typeof EMBEDDING_PREFIX_KEYS)[number]; value: "" | null }>;
    }
  | { kind: "restore" };

export async function updateOnboardingMemory(
  preset: OnboardingMemoryPreset,
  result: { ok: true } | { ok: false; errorClass: OnboardingErrorClass },
  change?: MemoryConfigChange,
): Promise<boolean> {
  return await getDbClient().transaction(async () => {
    const events: PendingTelemetry[] = [];
    const loaded = await loadState(events);
    let dirty = loaded.dirty;
    const eventsForState = loaded.state.autoCompleted ? [] : events;

    if (change?.kind === "save") {
      const configValues = [
        ["EMBEDDING_API_BASE_URL", change.baseUrl],
        ["EMBEDDING_MODEL", change.model],
        ...(change.apiKey ? [["EMBEDDING_API_KEY", change.apiKey]] : []),
      ] as const;
      for (const [key, value] of configValues) {
        const validationError = validateConfigValue(key, value);
        if (validationError) throw new Error(validationError);
      }
      await upsertSwarmConfig({
        scope: "global",
        key: "EMBEDDING_API_BASE_URL",
        value: change.baseUrl,
      });
      await upsertSwarmConfig({ scope: "global", key: "EMBEDDING_MODEL", value: change.model });
      if (change.apiKey) {
        await upsertSwarmConfig({
          scope: "global",
          key: "EMBEDDING_API_KEY",
          value: change.apiKey,
          isSecret: true,
        });
      }
      for (const { key, value } of change.prefixes) {
        if (value === null) await deleteSwarmConfigByKey("global", null, key);
        else await upsertSwarmConfig({ scope: "global", key, value });
      }
    } else if (change?.kind === "restore") {
      for (const key of EMBEDDING_CONFIG_KEYS) await deleteSwarmConfigByKey("global", null, key);
    }

    if (result.ok) {
      dirty = completeStep(loaded.state, "memory", preset, false, eventsForState) || dirty;
    } else {
      dirty = markStepFailed(loaded.state, "memory", result.errorClass, eventsForState) || dirty;
    }

    if (dirty) await persistState(loaded.state);
    queueTelemetry(events);
    return change !== undefined;
  });
}

export async function updateOnboardingAiFromCodexDevice(
  result: { status: "complete" } | { status: "failed"; errorClass: OnboardingErrorClass },
): Promise<boolean> {
  return await getDbClient().transaction(async () => {
    const rows = await getSwarmConfigs({ scope: "global", key: ONBOARDING_CONFIG_KEY });
    const stored = rows[0];
    if (!stored) return false;

    const state = parseStoredState(stored.value);
    if (!state) return false;

    const events: PendingTelemetry[] = [];
    const eventsForState = state.autoCompleted ? [] : events;
    let changed: boolean;
    if (result.status === "complete") {
      changed = completeStep(state, "ai", "codex_device", false, eventsForState);
    } else {
      changed = markStepFailed(state, "ai", result.errorClass, eventsForState);
    }

    if (!changed) return false;
    await persistState(state);
    queueTelemetry(events);
    return true;
  });
}

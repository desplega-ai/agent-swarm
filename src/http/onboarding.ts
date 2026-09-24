import type { IncomingMessage, ServerResponse } from "node:http";
import OpenAI from "openai";
import { z } from "zod";
import { getAutomationSetupStates } from "../be/automation-preflight";
import { getAgentHarnessProviders, getLiveAgentCounts, getTaskById } from "../be/db";
import { getEmbeddingProvider } from "../be/memory";
import { EMBEDDING_DIMENSIONS } from "../be/memory/constants";
import {
  type OnboardingErrorClass,
  OnboardingErrorClassSchema,
  type OnboardingSignals,
  type OnboardingState,
  OnboardingStateSchema,
  OnboardingStepIdSchema,
  OnboardingTaskNotFoundError,
  readOrUpdateOnboarding,
  updateOnboardingMemory,
} from "../be/onboarding";
import { ProviderNameSchema } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { ensureConfigAdmin } from "./config";
import { scheduleIntegrationsReload } from "./core";
import { route } from "./route-def";
import { rollupCredStatusForProvider } from "./status";
import { jsonError } from "./utils";

export type { OnboardingState } from "../be/onboarding";

const OnboardingSignalsSchema = z.object({
  providers: z.array(
    z.object({
      provider: ProviderNameSchema,
      state: z.enum(["unverified", "configured", "verified"]),
      workers: z.number().int().nonnegative(),
      verifiedWorkers: z.number().int().nonnegative(),
    }),
  ),
  embeddings: z.object({
    configured: z.boolean(),
    dimensions: z.number().int().positive(),
  }),
  integrations: z.object({
    slack: z.boolean(),
    github: z.boolean(),
    gitlab: z.boolean(),
    linear: z.boolean(),
    jira: z.boolean(),
  }),
  agents: z.object({
    leadsOnline: z.number().int().nonnegative(),
    workersOnline: z.number().int().nonnegative(),
  }),
  firstTask: z.object({ id: z.string(), status: z.string() }).nullable(),
});
const OnboardingResponseSchema = z.object({
  state: OnboardingStateSchema,
  signals: OnboardingSignalsSchema,
});

const AiMethodSchema = z.enum([
  "claude_setup_token",
  "claude_api_key",
  "codex_device",
  "codex_cli",
  "openrouter",
  "openai_gateway",
  "deepseek",
  "devin",
]);
const IntegrationMethodSchema = z.enum(["slack", "github", "gitlab", "linear_oauth", "jira_oauth"]);
const MemoryPresetSchema = z.enum(["openai", "openrouter", "vercel", "custom", "existing"]);

const OnboardingActionSchema = z.union([
  z.object({ action: z.literal("view"), step: OnboardingStepIdSchema }).strict(),
  z
    .object({
      action: z.literal("complete"),
      step: z.literal("connect"),
      method: z.literal("api_key"),
    })
    .strict(),
  z
    .object({
      action: z.literal("complete"),
      step: z.literal("name"),
      method: z.enum(["custom_name", "default_name"]),
    })
    .strict(),
  z
    .object({ action: z.literal("complete"), step: z.literal("ai"), method: AiMethodSchema })
    .strict(),
  z
    .object({
      action: z.literal("complete"),
      step: z.literal("integrations"),
      method: IntegrationMethodSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("skip"),
      step: z.enum(["name", "ai", "memory", "integrations", "first_task"]),
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
      method: z.enum(["suggestion", "free_form"]),
    })
    .strict(),
  z.object({ action: z.literal("minimize") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
  z.object({ action: z.literal("dismiss") }).strict(),
]);

const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Must be an HTTP or HTTPS URL");

const MemoryRequestSchema = z
  .object({
    preset: MemoryPresetSchema,
    baseUrl: HttpUrlSchema.optional(),
    model: z.string().trim().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    reuseKey: z.enum(["OPENAI_API_KEY", "OPENROUTER_API_KEY"]).optional(),
  })
  .strict();

const MemoryResponseSchema = z.object({
  ok: z.boolean(),
  dimensions: z.number().int().positive().optional(),
  latencyMs: z.number().int().nonnegative(),
  error: z.string().optional(),
  errorClass: OnboardingErrorClassSchema.optional(),
});

async function buildSignals(state: OnboardingState): Promise<OnboardingSignals> {
  const providers: OnboardingSignals["providers"] = [];
  for (const entry of await getAgentHarnessProviders()) {
    const provider = ProviderNameSchema.safeParse(entry.provider);
    if (!provider.success) continue;
    const rollup = await rollupCredStatusForProvider(provider.data);
    providers.push({
      provider: provider.data,
      state: rollup.state,
      workers: rollup.workers,
      verifiedWorkers: rollup.verifiedWorkers,
    });
  }

  const integrations = await getAutomationSetupStates();
  const agentCounts = await getLiveAgentCounts(5);
  const firstTask = state.firstTaskId ? await getTaskById(state.firstTaskId) : null;

  return {
    providers,
    embeddings: {
      configured: getEmbeddingProvider().isConfigured(),
      dimensions: EMBEDDING_DIMENSIONS,
    },
    integrations: {
      slack: integrations.slack === "configured",
      github: Boolean(process.env.GITHUB_TOKEN?.trim()) || integrations.github === "verified",
      gitlab: Boolean(process.env.GITLAB_TOKEN?.trim()),
      linear: integrations.linear === "verified",
      jira: integrations.jira === "verified",
    },
    agents: {
      leadsOnline: agentCounts.leads_alive,
      workersOnline: agentCounts.workers_alive,
    },
    firstTask: firstTask ? { id: firstTask.id, status: firstTask.status } : null,
  };
}

const getOnboarding = route({
  method: "get",
  path: "/api/onboarding",
  pattern: ["api", "onboarding"],
  summary: "Get first-run onboarding state and live setup signals",
  tags: ["Onboarding"],
  responses: {
    200: { description: "Onboarding state and signals", schema: OnboardingResponseSchema },
  },
});

const putOnboarding = route({
  method: "put",
  path: "/api/onboarding",
  pattern: ["api", "onboarding"],
  summary: "Apply a first-run onboarding state transition",
  tags: ["Onboarding"],
  rbac: { permission: "config.write.any" },
  body: OnboardingActionSchema,
  responses: {
    200: { description: "Updated onboarding state and signals", schema: OnboardingResponseSchema },
    400: { description: "Invalid transition" },
    404: { description: "First task not found" },
  },
});

const postOnboardingMemory = route({
  method: "post",
  path: "/api/onboarding/memory",
  pattern: ["api", "onboarding", "memory"],
  summary: "Test and save an embeddings configuration for onboarding",
  tags: ["Onboarding"],
  rbac: { permission: "config.write.any" },
  body: MemoryRequestSchema,
  responses: {
    200: { description: "Embedding probe result", schema: MemoryResponseSchema },
    400: { description: "Invalid memory configuration" },
  },
});

const MEMORY_PRESETS = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small" },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/text-embedding-3-small",
  },
  vercel: {
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    model: "openai/text-embedding-3-small",
  },
} as const;

function classifyMemoryError(error: unknown): OnboardingErrorClass {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : 0;
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model";
  if (status === 408) return "timeout";
  const text =
    error instanceof Error
      ? `${error.name} ${error.message}`.toLowerCase()
      : String(error).toLowerCase();
  if (text.includes("timeout") || text.includes("timed out") || text.includes("aborted")) {
    return "timeout";
  }
  if (
    text.includes("fetch failed") ||
    text.includes("network") ||
    text.includes("connection") ||
    text.includes("econn")
  ) {
    return "network";
  }
  return "unknown";
}

function memoryErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return scrubSecrets(message).slice(0, 300) || "Embedding probe failed";
}

async function updateMemoryState(
  preset: z.infer<typeof MemoryPresetSchema>,
  result: { ok: true } | { ok: false; errorClass: OnboardingErrorClass },
  saveConfig?: { baseUrl: string; model: string; apiKey?: string },
): Promise<void> {
  const configSaved = await updateOnboardingMemory(preset, result, saveConfig);
  if (configSaved) scheduleIntegrationsReload();
}

async function handleMemoryProbe(
  body: z.infer<typeof MemoryRequestSchema>,
): Promise<z.infer<typeof MemoryResponseSchema>> {
  const explicitKey = body.apiKey;
  const reusedKey = !explicitKey && body.reuseKey ? process.env[body.reuseKey] : undefined;
  const apiKey =
    explicitKey ?? reusedKey ?? process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    await updateMemoryState(body.preset, { ok: false, errorClass: "auth" });
    return { ok: false, latencyMs: 0, error: "No API key", errorClass: "auth" };
  }

  const preset =
    body.preset === "openai" || body.preset === "openrouter" || body.preset === "vercel"
      ? MEMORY_PRESETS[body.preset]
      : undefined;
  const baseUrl =
    body.preset === "existing"
      ? process.env.EMBEDDING_API_BASE_URL
      : (body.baseUrl ??
        preset?.baseUrl ??
        process.env.EMBEDDING_API_BASE_URL ??
        "https://api.openai.com/v1");
  const model =
    body.preset === "existing"
      ? (process.env.EMBEDDING_MODEL ?? "text-embedding-3-small")
      : (body.model ?? preset?.model ?? process.env.EMBEDDING_MODEL ?? "text-embedding-3-small");

  const started = performance.now();
  try {
    const client = new OpenAI({ baseURL: baseUrl, apiKey, timeout: 15_000, maxRetries: 0 });
    const response = await client.embeddings.create({
      model,
      input: "agent-swarm onboarding probe",
      dimensions: EMBEDDING_DIMENSIONS,
      encoding_format: "float",
    });
    const dimensions = response.data[0]?.embedding.length ?? 0;
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    if (dimensions !== EMBEDDING_DIMENSIONS) {
      await updateMemoryState(body.preset, { ok: false, errorClass: "dimension" });
      return {
        ok: false,
        latencyMs,
        error: `Expected ${EMBEDDING_DIMENSIONS} dimensions, received ${dimensions}`,
        errorClass: "dimension",
      };
    }

    const keyToSave = explicitKey || reusedKey ? apiKey : undefined;
    await updateMemoryState(
      body.preset,
      { ok: true },
      body.preset === "existing"
        ? undefined
        : {
            baseUrl: baseUrl ?? "https://api.openai.com/v1",
            model,
            apiKey: keyToSave,
          },
    );
    return { ok: true, dimensions, latencyMs };
  } catch (error) {
    const errorClass = classifyMemoryError(error);
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    const message = memoryErrorMessage(error);
    await updateMemoryState(body.preset, { ok: false, errorClass });
    return { ok: false, latencyMs, error: message, errorClass };
  }
}

export async function handleOnboarding(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (getOnboarding.match(req.method, pathSegments)) {
    getOnboarding.respond(res, 200, await readOrUpdateOnboarding(buildSignals));
    return true;
  }

  if (putOnboarding.match(req.method, pathSegments)) {
    const parsed = await putOnboarding.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureConfigAdmin(req, res, "config.write.any"))) return true;
    try {
      putOnboarding.respond(res, 200, await readOrUpdateOnboarding(buildSignals, parsed.body));
    } catch (error) {
      if (error instanceof OnboardingTaskNotFoundError) {
        jsonError(res, "First task not found", 404);
      } else {
        throw error;
      }
    }
    return true;
  }

  if (postOnboardingMemory.match(req.method, pathSegments)) {
    const parsed = await postOnboardingMemory.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureConfigAdmin(req, res, "config.write.any"))) return true;
    postOnboardingMemory.respond(res, 200, await handleMemoryProbe(parsed.body));
    return true;
  }

  return false;
}

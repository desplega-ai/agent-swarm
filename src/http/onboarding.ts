import type { IncomingMessage, ServerResponse } from "node:http";
import OpenAI from "openai";
import { getAutomationSetupStates } from "../be/automation-preflight";
import { getAgentHarnessProviders, getLiveAgentCounts, getTaskById } from "../be/db";
import { getEmbeddingProvider } from "../be/memory";
import { EMBEDDING_DIMENSIONS } from "../be/memory/constants";
import {
  OnboardingActionSchema,
  type OnboardingErrorClass,
  type OnboardingMemoryPreset,
  type OnboardingMemoryRequest,
  OnboardingMemoryRequestSchema,
  type OnboardingMemoryResponse,
  OnboardingMemoryResponseSchema,
  OnboardingResponseSchema,
  type OnboardingSignals,
  type OnboardingState,
  OnboardingTaskNotFoundError,
  readOrUpdateOnboarding,
  updateOnboardingMemory,
} from "../be/onboarding";
import { assertUrlSafe, publicEndpointSsrfOptions } from "../oauth/mcp-wrapper";
import { ProviderNameSchema } from "../types";
import { ensureConfigAdmin } from "./config";
import { scheduleIntegrationsReload } from "./core";
import { route } from "./route-def";
import { rollupCredStatusForProvider } from "./status";
import { jsonError } from "./utils";

export type { OnboardingState } from "../be/onboarding";

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
  body: OnboardingMemoryRequestSchema,
  responses: {
    200: { description: "Embedding probe result", schema: OnboardingMemoryResponseSchema },
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

function memoryErrorStatus(error: unknown): number | undefined {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : 0;
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function classifyMemoryError(error: unknown): OnboardingErrorClass {
  const status = memoryErrorStatus(error);
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

function memoryErrorMessage(errorClass: OnboardingErrorClass, status?: number): string {
  const statusSuffix = status ? ` (${status})` : "";
  switch (errorClass) {
    case "auth":
      return `The endpoint rejected the key${statusSuffix}.`;
    case "model":
      return `The endpoint could not find the embedding model${statusSuffix}.`;
    case "timeout":
      return "The endpoint timed out.";
    case "network":
      return "The endpoint could not be reached.";
    default:
      return `The endpoint returned an error${statusSuffix}.`;
  }
}

async function updateMemoryState(
  preset: OnboardingMemoryPreset,
  result: { ok: true } | { ok: false; errorClass: OnboardingErrorClass },
  saveConfig?: { baseUrl: string; model: string; apiKey?: string },
): Promise<void> {
  const configSaved = await updateOnboardingMemory(preset, result, saveConfig);
  if (configSaved) scheduleIntegrationsReload();
}

async function handleMemoryProbe(body: OnboardingMemoryRequest): Promise<OnboardingMemoryResponse> {
  const explicitKey = body.apiKey;
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

  let endpoint: URL;
  try {
    endpoint = assertUrlSafe(baseUrl ?? "", publicEndpointSsrfOptions());
  } catch {
    // Input rejections are not probe outcomes: the step state stays as is.
    return {
      ok: false,
      latencyMs: 0,
      error: "The endpoint URL is not allowed.",
      errorClass: "network",
    };
  }

  const reuseHost =
    body.reuseKey === "OPENAI_API_KEY"
      ? "api.openai.com"
      : body.reuseKey === "OPENROUTER_API_KEY"
        ? "openrouter.ai"
        : undefined;
  const canReuseKey = reuseHost === undefined || endpoint.hostname === reuseHost;
  const reusedKey =
    !explicitKey && body.reuseKey && canReuseKey ? process.env[body.reuseKey] : undefined;
  const implicitKey =
    body.preset === "existing"
      ? (process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY)
      : undefined;
  const apiKey = explicitKey ?? reusedKey ?? implicitKey;

  if (!apiKey) {
    return {
      ok: false,
      latencyMs: 0,
      error: "Enter an API key for this endpoint.",
      errorClass: "auth",
    };
  }

  const started = performance.now();
  try {
    const client = new OpenAI({
      baseURL: endpoint.toString(),
      apiKey,
      timeout: 15_000,
      maxRetries: 0,
      fetchOptions: { redirect: "manual" },
    });
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
    const message = memoryErrorMessage(errorClass, memoryErrorStatus(error));
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

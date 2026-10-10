/**
 * Pi-mono provider adapter.
 *
 * Creates pi-mono AgentSessions and normalizes their events to the
 * shared ProviderEvent union. MCP tools from the swarm endpoint are
 * discovered at session creation and registered as custom tools.
 */

import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  getBuiltinModel as getModel,
  getBuiltinModels as getModels,
} from "@earendil-works/pi-ai/providers/all";
import type {
  AgentSessionEvent,
  AgentToolResult,
  CreateAgentSessionOptions,
  ExtensionFactory,
  McpServerConfig,
  SessionStats,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import "./pi-codemode-runtime";
// Registers the reprompt template in the code registry (the runner loads it too).
import "../commands/templates";
import { resolveTemplateAsync } from "../prompts/resolver";
import { CORE_TOOLS } from "../tools/tool-config";
import { classifyAwsSdkError } from "../utils/aws-error-classifier";
import { parseEnvFlag } from "../utils/env-flag";
import { fetchInstalledMcpServers } from "../utils/mcp-server-fetcher";
import { swarmRuntimeInstanceId } from "../utils/multi-runtime";
import { DEFAULT_OPENROUTER_BASE_URL, getOpenRouterBaseUrl } from "../utils/openrouter-base-url";
import { scrubSecrets } from "../utils/secret-scrubber";
import { readPkgVersion } from "./harness-version";
import { createSwarmHooksExtension } from "./pi-mono-extension";
import { McpHttpClient, type McpTool } from "./pi-mono-mcp-client";
import { applyReasoningEffort, type ReasoningEffort } from "./reasoning-effort";
import { piPromptSkillName } from "./skill-invoke";
import type {
  CostData,
  CredCheckOptions,
  CredStatus,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
  SteerDelivery,
  SteerDeliveryResult,
} from "./types";

/**
 * Map a `MODEL_OVERRIDE` string to the env var(s) that can satisfy it.
 *
 * Anthropic shortnames (`sonnet` / `haiku` / `opus`) accept EITHER
 * `ANTHROPIC_API_KEY` (preferred — talks to Anthropic directly) OR
 * `OPENROUTER_API_KEY` — in the latter case `resolveModel` swaps to the
 * OpenRouter mirror of the same model so pi-ai's anthropic-provider env
 * lookup (which only checks `ANTHROPIC_*`) doesn't fail with "No API key
 * found for anthropic". Provider-prefixed model IDs only accept that one
 * provider's key. Returns `null` for the permissive case (no MODEL_OVERRIDE
 * or bare unprefixed model name).
 */
function modelToCredKeys(modelStr: string | undefined): string[] | null {
  if (!modelStr) return null;
  const lower = modelStr.toLowerCase();
  // Hard-coded shortnames: anthropic-shape but pi-mono can route through
  // OpenRouter (see `resolveModel`) when only an OR key is available.
  if (lower === "opus" || lower === "sonnet" || lower === "haiku") {
    return ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"];
  }
  if (modelStr.includes("/")) {
    const provider = modelStr.slice(0, modelStr.indexOf("/")).toLowerCase();
    if (provider === "anthropic") return ["ANTHROPIC_API_KEY"];
    if (provider === "openrouter") return ["OPENROUTER_API_KEY"];
    if (provider === "openai") return ["OPENAI_API_KEY"];
    if (provider === "google") return ["GOOGLE_API_KEY", "GEMINI_API_KEY"];
  }
  // Bare model name with no provider prefix — adapter falls through to a
  // best-effort resolution against multiple providers, so the boot loop
  // accepts any one of them.
  return null;
}

/**
 * Return the pi-ai Bedrock models the harness can actually drive via the
 * Converse API (the catalog from `getModels("amazon-bedrock")`). Each id is a
 * valid pi-ai id — base foundation-model id OR inference-profile id (`us.` /
 * `eu.` / `apac.` / `au.` / `global.` prefixes) — so the matched id round-trips
 * through `MODEL_OVERRIDE=amazon-bedrock/<id>` unchanged. Used as the
 * harness-drivable half of the (drivable ∩ invocable) intersection.
 */
function getHarnessDrivableBedrockModels(): Array<{ id: string; name: string }> {
  try {
    return getModels("amazon-bedrock").map((m) => ({ id: m.id, name: m.name }));
  } catch {
    // getModels may throw if the pi-ai catalog is empty or corrupted.
    // Return an empty list — the intersection will be empty too, which is safe.
    return [];
  }
}

/**
 * Enumerate the Bedrock models that are both invocable by this AWS account and
 * drivable by the pi-ai Converse harness, and verify the credential chain in
 * one pass:
 *   1. VERIFY the active credential chain is valid for Bedrock in `region`
 *      (the AWS list calls throw on auth/access failure).
 *   2. ENUMERATE usable models = harness-drivable ∩ AWS-invocable, where the
 *      AWS-invocable set is:
 *        - `ListFoundationModels` filtered to on-demand TEXT models that are
 *          `ACTIVE` (base foundation-model ids), UNION
 *        - `ListInferenceProfiles` ids (the `us.`/`eu.`/… cross-region profile
 *          ids). The newest Claude models on Bedrock are invocable ONLY via an
 *          inference profile and never appear in `ListFoundationModels`, so this
 *          union is what keeps the current models in the usable list.
 *
 * `ListFoundationModels` reports models that EXIST in the region, not strictly
 * ones the account has enabled access to, so the on-demand/ACTIVE filtering
 * narrows it; base on-demand access-grant is not fully enumerable from the
 * catalog. The inference-profile union is what makes the *current* models
 * accurate. The matched id is stored/displayed as the pi-ai id (the id the
 * harness can drive); ids are matched exactly.
 *
 * Two list calls per refresh, no pagination loops or per-model lookups.
 * Dynamically imported so the API binary never loads `@aws-sdk/client-bedrock`.
 * Tests inject a stub via `CredCheckOptions.bedrockProbe` instead.
 *
 * Returns `Array<{id, name}>` on success; throws on auth/access failure.
 */
export async function runBedrockSdkProbeAndEnumerate(
  region: string,
): Promise<Array<{ id: string; name: string }>> {
  const { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } = await import(
    "@aws-sdk/client-bedrock"
  );
  const client = new BedrockClient({ region });

  // AWS-invocable set, region-scoped to `region`.
  const invocable = new Set<string>();

  // Base on-demand TEXT foundation models that are ACTIVE.
  const fmResponse = await client.send(
    new ListFoundationModelsCommand({ byInferenceType: "ON_DEMAND", byOutputModality: "TEXT" }),
  );
  for (const m of fmResponse.modelSummaries ?? []) {
    if (m.modelId && m.modelLifecycle?.status === "ACTIVE") {
      invocable.add(m.modelId);
    }
  }

  // Inference-profile / cross-region ids (`us.`/`eu.`/`apac.`/…). These are the
  // only invocation path for the newest Claude models and are absent from
  // `ListFoundationModels`.
  const profileResponse = await client.send(new ListInferenceProfilesCommand({}));
  for (const p of profileResponse.inferenceProfileSummaries ?? []) {
    if (p.inferenceProfileId) {
      invocable.add(p.inferenceProfileId);
    }
  }

  // Usable = harness-drivable ∩ AWS-invocable, exact-id match. The stored id is
  // the pi-ai id so it round-trips through `getModel("amazon-bedrock", id)`.
  return getHarnessDrivableBedrockModels().filter((m) => invocable.has(m.id));
}

/**
 * Pi-mono is satisfied by ANY of:
 *   1. `BEDROCK_AUTH_MODE=sdk` — or `MODEL_OVERRIDE` selects the
 *      `amazon-bedrock` provider (prefix-inference fallback when
 *      `BEDROCK_AUTH_MODE` is absent). The AWS SDK default credential chain is
 *      exercised by a real enumeration pass (`ListFoundationModels` +
 *      `ListInferenceProfiles`) that both verifies access and lists the usable
 *      models. Success → `ready:true, satisfiedBy:"sdk-delegated"` with the
 *      enumerated models; failure → `ready:false` with a classified hint;
 *      `AWS_REGION` unset → `ready:false` with a set-region hint. The
 *      enumeration is worker-only (the pi dynamic-import arm in
 *      `checkProviderCredentials`); the API binary never imports the SDK.
 *   2. `~/.pi/agent/auth.json` exists.
 *   3. `MODEL_OVERRIDE` is set to a non-Bedrock provider-prefixed model — only
 *      the matching provider's key is required.
 *   4. `MODEL_OVERRIDE` is empty / unprefixed — any one of the supported
 *      keys (ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY) is
 *      enough.
 *
 * The Bedrock branch is checked first so a stale `auth.json` (Anthropic /
 * OpenRouter creds from a previous login) doesn't get falsely reported as
 * the satisfying source when the model is actually going to AWS.
 */
export async function checkPiMonoCredentials(
  env: Record<string, string | undefined>,
  opts: CredCheckOptions = {},
): Promise<CredStatus> {
  // Determine the Bedrock mode:
  //   - Explicit:  BEDROCK_AUTH_MODE=sdk — the AWS SDK default credential chain
  //   - Explicit:  BEDROCK_AUTH_MODE=bearer — an explicit Bedrock API key in
  //                AWS_BEARER_TOKEN_BEDROCK, which the AWS SDK picks up as the
  //                bearer identity for the Bedrock clients
  //   - Fallback:  BEDROCK_AUTH_MODE absent AND MODEL_OVERRIDE starts with
  //                "amazon-bedrock/" (preserves today's prefix-inference semantics)
  // Both explicit modes share the region check and the enumeration probe; they
  // differ in what has to be present up front and in how readiness is reported.
  const bedrockAuthMode = env.BEDROCK_AUTH_MODE?.toLowerCase();
  const isBedrockBearer = bedrockAuthMode === "bearer";
  const isBedrockSdk =
    bedrockAuthMode === "sdk" ||
    (bedrockAuthMode === undefined &&
      env.MODEL_OVERRIDE?.toLowerCase().startsWith("amazon-bedrock/"));

  if (isBedrockBearer && !env.AWS_BEARER_TOKEN_BEDROCK) {
    // The token is the whole point of this mode; without it there is nothing
    // the probe could authenticate with, and the standard API keys do not
    // apply to Bedrock, so do not fall through to them.
    return {
      ready: false,
      missing: ["AWS_BEARER_TOKEN_BEDROCK"],
      hint: "BEDROCK_AUTH_MODE=bearer requires AWS_BEARER_TOKEN_BEDROCK (a Bedrock API key); set it, or use BEDROCK_AUTH_MODE=sdk to authenticate through the AWS credential chain.",
      bedrockModels: [],
      bedrockRegion: env.AWS_REGION ?? "",
    };
  }

  if (isBedrockSdk || isBedrockBearer) {
    const region = env.AWS_REGION;
    if (!region) {
      // Do NOT fabricate a region. A guessed `us-east-1` can differ from where
      // inference actually runs, which would enumerate the wrong region's
      // models. Report a not-ready Bedrock state with a hint instead, so the
      // enumeration region always matches the inference region. `bedrockRegion`
      // is an empty string (not undefined) so the report still carries a
      // Bedrock block and the picker can surface the reason.
      return {
        ready: false,
        missing: [],
        hint: "AWS_REGION is not set — set it to the region where your Bedrock models are accessible so model enumeration matches the inference region.",
        bedrockModels: [],
        bedrockRegion: "",
      };
    }
    const probe = opts.bedrockProbe ?? (() => runBedrockSdkProbeAndEnumerate(region));
    try {
      const probeResult = await probe();
      // `probeResult` is `Array<{id,name}> | void` — void comes from auth-only
      // stubs that don't exercise enumeration. Treat void as [].
      const bedrockModels: Array<{ id: string; name: string }> = Array.isArray(probeResult)
        ? probeResult
        : [];
      return {
        ready: true,
        missing: [],
        satisfiedBy: isBedrockBearer ? "env" : "sdk-delegated",
        hint: `Bedrock models invocable in ${region} enumerated (${bedrockModels.length} usable; ListFoundationModels + ListInferenceProfiles).`,
        bedrockModels,
        bedrockRegion: region,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const classification = classifyAwsSdkError(errorMessage);
      return {
        ready: false,
        missing: [],
        hint:
          classification?.message ??
          `AWS Bedrock enumeration failed (region: ${region}): ${errorMessage}`,
        bedrockModels: [],
        bedrockRegion: region,
      };
    }
  }

  const homeDir = opts.homeDir ?? env.HOME ?? "/root";
  const fsProbe = opts.fs?.existsSync ?? existsSync;
  const authFile = `${homeDir}/.pi/agent/auth.json`;
  if (fsProbe(authFile)) {
    return { ready: true, missing: [], satisfiedBy: "file" };
  }

  const requiredKeys = modelToCredKeys(env.MODEL_OVERRIDE);
  if (requiredKeys) {
    if (requiredKeys.some((k) => env[k])) {
      return { ready: true, missing: [], satisfiedBy: "env" };
    }
    const keyList = requiredKeys.join(" / ");
    return {
      ready: false,
      missing: [...requiredKeys, authFile],
      hint: `MODEL_OVERRIDE=${env.MODEL_OVERRIDE} requires one of ${keyList}; or run \`pi auth login\` to create ${authFile}.`,
    };
  }

  // Permissive case: any one supported key works.
  if (env.ANTHROPIC_API_KEY || env.OPENROUTER_API_KEY || env.OPENAI_API_KEY) {
    return { ready: true, missing: [], satisfiedBy: "env" };
  }
  return {
    ready: false,
    missing: ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", authFile],
    hint: "Set one of ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY (any one suffices), or run `pi auth login` to create ~/.pi/agent/auth.json.",
  };
}

/** Convert a JSON Schema object to a TypeBox TSchema using Type.Unsafe */
function jsonSchemaToTypeBox(schema: Record<string, unknown>): TSchema {
  // Type.Unsafe wraps a plain JSON Schema as a TypeBox-compatible TSchema
  return Type.Unsafe(schema);
}

type ToolStructuredContent = NonNullable<AgentToolResult["structuredContent"]>;

/** Namespace pi shows for swarm tools in `tool_search` and codemode listings. */
export const SWARM_TOOL_NAMESPACE = { name: "agent-swarm" } as const;

/**
 * `PI_TOOL_DEFERRAL`: hide non-core swarm tools behind pi's `tool_search`.
 * Off by default until a pilot measures the prompt-cache cost of mid-session
 * tool-set changes. Read from `process.env` by both the adapter traits (which
 * pick the prompt's tool-discovery line) and `createSession`, so the prompt
 * and the session always agree.
 */
export function isPiToolDeferralEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvFlag(env.PI_TOOL_DEFERRAL, false);
}

/**
 * `PI_CODEMODE`: add pi's codemode tool (a harness-side JS sandbox whose
 * scripts call tools) next to the declared tools, on every pi session.
 * Off by default.
 */
export function isPiCodemodeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvFlag(env.PI_CODEMODE, false);
}

/**
 * `PI_CODEMODE_MODELS`: expose pi's `models` API (`classify()`,
 * `generateImages()`, the model catalog) to codemode scripts. Off by default
 * and only effective while `PI_CODEMODE` is on, so a stray `true` never turns
 * model calls on by itself. pi adds a script's `models.*` usage to the
 * `codemode` tool result and `getSessionStats()` sums it into the session
 * cost the adapter reports (see `src/tests/providers/pi-cost.test.ts`).
 */
export function isPiCodemodeModelsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isPiCodemodeEnabled(env) && parseEnvFlag(env.PI_CODEMODE_MODELS, false);
}

/**
 * Tools that stay declared to the model when deferral is on: the lifecycle
 * set Claude also keeps out of ToolSearch, plus any tool the server preloads
 * for this task through `_meta["anthropic/alwaysLoad"]` (task tool manifests).
 */
export function isCoreSwarmTool(tool: McpTool): boolean {
  return CORE_TOOLS.has(tool.name) || tool._meta?.["anthropic/alwaysLoad"] === true;
}

/**
 * Convert MCP tools to pi-mono ToolDefinition objects.
 * Exported for the isError-propagation conformance test — pi-agent-core
 * derives a tool result's error flag solely from execute() throwing.
 *
 * With `deferNonCore`, tools outside the core set get `exposure: "deferred"`:
 * pi leaves them out of the model's tool list until `tool_search` loads them.
 */
export function mcpToolsToDefinitions(
  mcpClient: McpHttpClient,
  tools: McpTool[],
  options: { deferNonCore?: boolean; namespace?: { name: string } } = {},
): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description || tool.name,
    parameters: jsonSchemaToTypeBox(tool.inputSchema),
    ...(tool.outputSchema && { outputSchema: jsonSchemaToTypeBox(tool.outputSchema) }),
    ...(options.namespace && { namespace: options.namespace }),
    ...(options.deferNonCore && {
      exposure: isCoreSwarmTool(tool) ? ("direct" as const) : ("deferred" as const),
    }),
    async execute(_toolCallId, params) {
      const result = await mcpClient.callTool(tool.name, params as Record<string, unknown>);
      const text = result.content
        .map((c) => c.text ?? "")
        .filter(Boolean)
        .join("\n");
      // Propagate MCP isError: pi-agent-core derives a tool result's error flag
      // from whether execute() throws, so a resolved return would silently
      // report failed tool calls as successes to the model.
      if (result.isError) {
        throw new Error(text || `Tool ${tool.name} failed with no error message`);
      }
      return {
        content: [{ type: "text" as const, text: text || "(no output)" }],
        details: undefined,
        // Not sent to the model; codemode scripts read it instead of the text.
        ...(result.structuredContent && {
          structuredContent: result.structuredContent as ToolStructuredContent,
        }),
      };
    },
  }));
}

/**
 * Anthropic-shortname → OpenRouter-mirror model IDs. Used by `resolveModel`
 * when the worker only has `OPENROUTER_API_KEY` so pi-ai's anthropic
 * provider env lookup (`ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` only)
 * doesn't fail with "No API key found for anthropic".
 *
 * The mirror IDs match pi-ai's generated OpenRouter model catalog
 * (`anthropic/claude-{opus,sonnet,haiku}-*`).
 */
const ANTHROPIC_SHORTNAME_OPENROUTER_MIRROR: Record<string, string> = {
  fable: "anthropic/claude-fable-5",
  opus: "anthropic/claude-opus-4.8",
  sonnet: "anthropic/claude-sonnet-5",
  haiku: "anthropic/claude-haiku-4.5",
};

function envHasAnthropicCred(env: Record<string, string | undefined>): boolean {
  return !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_OAUTH_TOKEN);
}

const PI_RUNTIME_API_KEYS = [
  ["OPENROUTER_API_KEY", "openrouter"],
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["OPENAI_API_KEY", "openai"],
  ["GEMINI_API_KEY", "google"],
  ["GOOGLE_API_KEY", "google"],
] as const;

/**
 * Build pi-coding-agent auth services from the runner's per-task resolved env.
 *
 * The runner intentionally does not copy rotated credential-pool selections
 * into `process.env` because that would freeze rotation globally. pi-mono runs
 * in-process, so pass selected keys through pi's runtime auth override instead
 * of relying on environment lookup.
 */
export async function createPiRuntimeAuth(
  env: Record<string, string | undefined> = process.env,
): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create();
  for (const [envKey, provider] of PI_RUNTIME_API_KEYS) {
    const apiKey = env[envKey];
    if (apiKey) {
      await modelRuntime.setRuntimeApiKey(provider, apiKey);
    }
  }

  return modelRuntime;
}

/**
 * Sidecar marker recording the gateway `baseUrl` WE wrote into models.json
 * (and any user value we displaced). Lets `ensureOpenRouterModelsOverride`
 * revert precisely when the env returns to default, without ever touching a
 * hand-authored override it didn't create. Lives next to models.json; NOT
 * part of pi's config surface.
 */
const OPENROUTER_OVERRIDE_MARKER = ".agent-swarm-openrouter-override.json";

interface OpenRouterOverrideMarker {
  baseUrl: string;
  /** User-authored baseUrl we displaced, restored on revert. */
  previous?: string;
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    const parsed: unknown = JSON.parse(await file.text());
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Materialize (or revert) the OpenRouter gateway override in
 * `<agentDir>/models.json` so pi-coding-agent's `ModelRuntime` (which loads
 * that file at create time) composes every built-in OpenRouter model with
 * the gateway `baseUrl` — see `src/utils/openrouter-base-url.ts` for the
 * env contract.
 *
 * Gateway set (non-default): merge-preserving write — existing provider
 * entries and other openrouter keys are kept, only
 * `providers.openrouter.baseUrl` is set; a displaced user value is recorded
 * in a sidecar marker. A corrupt existing file is overwritten with just the
 * override — for gateway deployments, guaranteed rerouting wins over
 * preserving unparseable config.
 *
 * Gateway unset/default: reverts a PREVIOUSLY WRITTEN override (marker
 * present and models.json still carries the marker's value) — restoring the
 * displaced user baseUrl or deleting the key, dropping now-empty objects,
 * and removing models.json entirely if the override was all it contained.
 * The env value in a shared worker isn't per-task in practice, but reverts
 * make rollback = "unset the env" and keep repo-scoped/self-hosted setups
 * from inheriting a stale gateway (PR #1010 review). Without a marker the
 * function never touches models.json, so hand-authored overrides survive.
 */
export async function ensureOpenRouterModelsOverride(
  agentDir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const baseUrl = getOpenRouterBaseUrl(env as NodeJS.ProcessEnv);
  const modelsPath = join(agentDir, "models.json");
  const markerPath = join(agentDir, OPENROUTER_OVERRIDE_MARKER);

  if (baseUrl === DEFAULT_OPENROUTER_BASE_URL) {
    await revertOpenRouterModelsOverride(modelsPath, markerPath);
    return;
  }

  let existing: Record<string, unknown> = {};
  try {
    const file = Bun.file(modelsPath);
    if (await file.exists()) {
      existing = JSON.parse(await file.text()) as Record<string, unknown>;
    }
  } catch (err) {
    console.warn(
      `[pi-mono] ${modelsPath} is unreadable/invalid (${err instanceof Error ? err.message : err}); rewriting with the OpenRouter gateway override`,
    );
    existing = {};
  }

  const providers =
    typeof existing.providers === "object" && existing.providers !== null
      ? (existing.providers as Record<string, unknown>)
      : {};
  const openrouter =
    typeof providers.openrouter === "object" && providers.openrouter !== null
      ? (providers.openrouter as Record<string, unknown>)
      : {};

  // Record what we displace, once — re-runs with the marker already present
  // keep the ORIGINAL displaced value (the current baseUrl is then ours).
  const priorMarker = (await readJsonFile(markerPath)) as OpenRouterOverrideMarker | undefined;
  const currentBaseUrl = typeof openrouter.baseUrl === "string" ? openrouter.baseUrl : undefined;
  const previous = priorMarker
    ? priorMarker.previous
    : currentBaseUrl !== baseUrl
      ? currentBaseUrl
      : undefined;

  const next = {
    ...existing,
    providers: {
      ...providers,
      openrouter: { ...openrouter, baseUrl },
    },
  };
  await Bun.write(modelsPath, `${JSON.stringify(next, null, 2)}\n`);
  const marker: OpenRouterOverrideMarker = {
    baseUrl,
    ...(previous !== undefined ? { previous } : {}),
  };
  await Bun.write(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
}

/**
 * Undo a marker-recorded gateway override. Only acts when the marker exists
 * AND models.json's `providers.openrouter.baseUrl` still equals the value
 * the marker says we wrote — anything else means the user edited the file
 * since, and we leave it alone (the stale marker is dropped either way).
 */
async function revertOpenRouterModelsOverride(
  modelsPath: string,
  markerPath: string,
): Promise<void> {
  const marker = (await readJsonFile(markerPath)) as OpenRouterOverrideMarker | undefined;
  if (!marker) return;
  const removeMarker = () => Bun.file(markerPath).delete();

  const existing = await readJsonFile(modelsPath);
  if (!existing) {
    await removeMarker();
    return;
  }
  const providers =
    typeof existing.providers === "object" && existing.providers !== null
      ? { ...(existing.providers as Record<string, unknown>) }
      : undefined;
  const openrouter =
    providers && typeof providers.openrouter === "object" && providers.openrouter !== null
      ? { ...(providers.openrouter as Record<string, unknown>) }
      : undefined;
  if (!providers || !openrouter || openrouter.baseUrl !== marker.baseUrl) {
    await removeMarker();
    return;
  }

  if (marker.previous !== undefined) {
    openrouter.baseUrl = marker.previous;
  } else {
    delete openrouter.baseUrl;
  }
  if (Object.keys(openrouter).length === 0) {
    delete providers.openrouter;
  } else {
    providers.openrouter = openrouter;
  }
  const next: Record<string, unknown> = { ...existing, providers };
  if (Object.keys(providers).length === 0) {
    delete next.providers;
  }

  if (Object.keys(next).length === 0) {
    await Bun.file(modelsPath).delete();
  } else {
    await Bun.write(modelsPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  await removeMarker();
}

/**
 * Resolve a model string to a pi-ai Model object.
 *
 * When `modelStr` is an anthropic shortname (`sonnet`/`haiku`/`opus`) AND
 * the env only has `OPENROUTER_API_KEY` (no `ANTHROPIC_API_KEY` /
 * `ANTHROPIC_OAUTH_TOKEN`), the shortname is rerouted through the
 * OpenRouter mirror of the same model. This prevents pi-ai's
 * anthropic-provider env lookup from failing at session-start with
 * "No API key found for anthropic" — see task 37a4a87a and the chronic
 * weekly-fire pattern (2026-04-13 → 2026-05-11) tracked in HEARTBEAT.md.
 */
export function resolveModel(
  modelStr: string,
  env: Record<string, string | undefined> = process.env,
) {
  if (!modelStr) return undefined;

  const lower = modelStr.toLowerCase();
  const isAnthropicShortname =
    lower === "opus" || lower === "sonnet" || lower === "haiku" || lower === "fable";

  // Reroute anthropic shortnames through OpenRouter when no anthropic cred
  // is available. The OpenRouter mirror IDs (`anthropic/claude-sonnet-5`,
  // etc.) are present in pi-ai's model catalog.
  if (isAnthropicShortname && !envHasAnthropicCred(env) && env.OPENROUTER_API_KEY) {
    const orModelId = ANTHROPIC_SHORTNAME_OPENROUTER_MIRROR[lower];
    if (orModelId) {
      try {
        return getModel("openrouter" as "anthropic", orModelId as never);
      } catch {
        // Fall through to native anthropic mapping below.
      }
    }
  }

  // Map common shortnames to provider/model pairs (native anthropic path).
  const shortnames: Record<string, [string, string]> = {
    fable: ["anthropic", "claude-fable-5"],
    opus: ["anthropic", "claude-opus-4-8"],
    sonnet: ["anthropic", "claude-sonnet-5"],
    haiku: ["anthropic", "claude-haiku-4-5-20251001"],
  };

  const mapping = shortnames[lower];
  if (mapping) {
    try {
      return getModel(mapping[0] as "anthropic", mapping[1] as never);
    } catch {
      return undefined;
    }
  }

  // Try parsing "provider/model-id" format (split on first "/" only —
  // OpenRouter model IDs contain slashes, e.g. "openrouter/google/gemini-2.5-flash-lite")
  if (modelStr.includes("/")) {
    const slashIdx = modelStr.indexOf("/");
    const provider = modelStr.slice(0, slashIdx);
    const modelId = modelStr.slice(slashIdx + 1);
    try {
      return getModel(provider as "anthropic", modelId as never);
    } catch {
      return undefined;
    }
  }

  // Try as a full model ID with common providers
  for (const provider of ["anthropic", "openai", "google"]) {
    try {
      return getModel(provider as "anthropic", modelStr as never);
    } catch {}
  }

  return undefined;
}

/** Manage AGENTS.md symlink for pi-mono CLAUDE.md compatibility */
function createAgentsMdSymlink(cwd: string): boolean {
  const claudeMd = join(cwd, "CLAUDE.md");
  const agentsMd = join(cwd, "AGENTS.md");

  if (existsSync(claudeMd) && !existsSync(agentsMd)) {
    try {
      symlinkSync("CLAUDE.md", agentsMd);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function cleanupAgentsMdSymlink(cwd: string): void {
  const agentsMd = join(cwd, "AGENTS.md");
  try {
    // Only remove if it's actually a symlink — never delete real AGENTS.md files
    if (existsSync(agentsMd) && lstatSync(agentsMd).isSymbolicLink()) {
      unlinkSync(agentsMd);
    }
  } catch {
    // Ignore cleanup errors
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type?: string; text?: string } =>
        typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
    )
    .map((c) => c.text || "")
    .join("")
    .trim();
}

export function extractPiAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as { role?: string; content?: unknown };
  if (msg.role !== "assistant") return "";
  return extractTextContent(msg.content);
}

/** What one assistant `message_end` carried, by block type only (never content). */
interface AssistantTurnShape {
  stopReason?: string;
  blockTypes: string[];
  outputTokens?: number;
  hasText: boolean;
  hasToolCall: boolean;
}

/** Keep log labels to short identifier-like tokens so a log line can never carry content. */
function safeLabel(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : "other";
}

function describeAssistantTurn(message: unknown): AssistantTurnShape {
  const msg = (message ?? {}) as {
    content?: unknown;
    stopReason?: unknown;
    usage?: { output?: unknown };
  };
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const blockTypes = blocks.map((b) => safeLabel((b as { type?: unknown } | null)?.type));
  const output = msg.usage?.output;
  return {
    stopReason: typeof msg.stopReason === "string" ? safeLabel(msg.stopReason) : undefined,
    blockTypes: typeof msg.content === "string" && msg.content.trim() ? ["text"] : blockTypes,
    outputTokens: typeof output === "number" ? output : undefined,
    hasText: extractTextContent(msg.content) !== "",
    hasToolCall: blockTypes.includes("toolCall"),
  };
}

const TERMINAL_STORE_PROGRESS_STATUSES = new Set(["completed", "failed"]);

export class PiMonoSession implements ProviderSession {
  private listeners: Array<(event: ProviderEvent) => void> = [];
  private eventQueue: ProviderEvent[] = [];
  private _sessionId: string | undefined;
  private completionPromise: Promise<ProviderResult>;
  private agentSession: AgentSession;
  private config: ProviderSessionConfig;
  private createdSymlink: boolean;
  private logFileHandle: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
  /** Track last emitted message text to avoid duplicates across turns */
  private lastEmittedMessage = "";
  /** Last assistant text surfaced by pi-mono; used as runner fallback output. */
  private lastAssistantText = "";
  /** Phase 7: wallclock start so we can populate `durationMs` on the cost row. */
  private sessionStartedAt: number = Date.now();
  /**
   * Phase 7: previous output-token total — used to derive per-turn delta for
   * `context_usage.outputTokens` since pi-ai's `getContextUsage()` doesn't
   * surface it directly.
   */
  private prevOutputTokens = 0;
  /**
   * Terminal error message captured from structured pi-coding-agent events.
   *
   * Set by `message_end` (assistant turn with `stopReason==='error'` — covers
   * NON-retryable failures, including AWS auth which never enters pi's retry
   * loop) and by `auto_retry_end` with `success:false` (the definitive terminal
   * failure after the retryable class — throttle / 5xx / timeout — exhausts).
   * Cleared on recovery: a successful `message_end` or an `auto_retry_end` with
   * `success:true` resets it to null, so a recovered error never surfaces as a
   * false failure. Evaluated once at session end in `runSession()`.
   */
  private terminalError: string | null = null;
  /** Reasoning/effort level actually applied (Phase 4) — null when `applyReasoningEffort()` returned noop. */
  private appliedReasoningEffort: ReasoningEffort | null;
  /**
   * Set once `runSession()` finishes (success or failure). `steer()`/`followUp()`
   * on a finished AgentSession enqueue into a dead agent loop and never throw,
   * so without this gate a late steering delivery would be reported `delivered`
   * while the message silently rots in the disposed session — and the false
   * positive suppresses the server's terminal-status promotion to a follow-up
   * task. Checked by `deliverSteering()`.
   */
  private sessionEnded = false;
  /** Shape of the most recent assistant turn; the last one before idle is the final turn. */
  private lastAssistantTurn: AssistantTurnShape | null = null;
  /** `store-progress` calls with a terminal status that are still running, by tool call id. */
  private pendingTerminalStoreProgress = new Set<string>();
  /** A terminal `store-progress` call (completed or failed) finished without error. */
  private terminalStoreProgressDone = false;
  /** The one-per-session empty-final-turn reprompt has been spent (or skipped for good). */
  private emptyTurnReprompted = false;
  /** `abort()` was called: never prompt a session someone is trying to stop. */
  private abortRequested = false;

  constructor(
    agentSession: AgentSession,
    config: ProviderSessionConfig,
    createdSymlink: boolean,
    appliedReasoningEffort: ReasoningEffort | null = null,
  ) {
    this.agentSession = agentSession;
    this.config = config;
    this.createdSymlink = createdSymlink;
    this.appliedReasoningEffort = appliedReasoningEffort;
    this.logFileHandle = Bun.file(config.logFile).writer();
    this._sessionId = agentSession.sessionId;
    this.sessionStartedAt = Date.now();

    // Emit session_init immediately
    const piVersion = readPkgVersion("@earendil-works/pi-coding-agent");
    this.emit({
      type: "session_init",
      sessionId: this._sessionId,
      provider: "pi",
      harnessVariant: "stock",
      ...(piVersion ? { harnessVariantMeta: { version: piVersion } } : {}),
    });

    // Subscribe to agent events and normalize
    this.agentSession.subscribe((event) => this.handleAgentEvent(event));

    // Start the prompt and track completion
    this.completionPromise = this.runSession();
  }

  /**
   * Canonical model slug for downstream reporting (latestModel, raw_log envelopes).
   * Composes `${provider}/${id}` from the resolved pi-ai model so the UI snapshot
   * lookup matches (e.g. `openrouter/deepseek/deepseek-v4-flash`). Falls back to
   * the configured model string if the session didn't resolve one.
   */
  private reportedModel(): string {
    const m = this.agentSession.model;
    if (m) return `${m.provider}/${m.id}`;
    return this.config.model;
  }

  private emit(event: ProviderEvent): void {
    // Scrub secrets from raw_log / raw_stderr content before egress (log file
    // write, listener dispatch, downstream session-logs push + pretty-print).
    const scrubbed: ProviderEvent =
      event.type === "raw_log" || event.type === "raw_stderr"
        ? { ...event, content: scrubSecrets(event.content) }
        : event;

    // Log all events
    this.logFileHandle.write(
      `${JSON.stringify({ ...scrubbed, timestamp: new Date().toISOString() })}\n`,
    );

    if (this.listeners.length > 0) {
      for (const listener of this.listeners) {
        listener(scrubbed);
      }
    } else {
      this.eventQueue.push(scrubbed);
    }
  }

  private handleAgentEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_end": {
        // Pi emits message_end for user, assistant, and tool-result messages.
        // An assistant turn that ended in `stopReason==='error'` is a failed
        // turn — track it as the (so far) terminal error. This is the ONLY
        // structured signal for NON-retryable failures (AWS auth: ExpiredToken
        // / CredentialsProviderError), which never enter pi's retry loop.
        const endMsg = event.message as {
          role?: string;
          stopReason?: string;
          errorMessage?: string;
        };
        if (endMsg.role === "assistant") {
          const turn = describeAssistantTurn(event.message);
          this.lastAssistantTurn = turn;
          if (endMsg.stopReason === "error") {
            // Candidate terminal failure. May still be cleared by a successful
            // retry (auto_retry_end success / a later good message_end).
            this.terminalError = endMsg.errorMessage ?? this.terminalError ?? "Unknown error";
            break;
          }
          // A successful assistant turn means any prior error has recovered.
          this.terminalError = null;
          if (!turn.hasText && !turn.hasToolCall) {
            // Nothing else records these turns: no text and no tool call leaves
            // no trace in session logs. Block types only, never content.
            const tokens =
              turn.outputTokens === undefined ? "" : `, outputTokens=${turn.outputTokens}`;
            this.emit({
              type: "raw_stderr",
              content: `[pi-mono] assistant turn ended with no text and no tool call (stopReason=${turn.stopReason ?? "none"}, content=[${turn.blockTypes.join(",")}]${tokens})\n`,
            });
          }
        }
        // Only assistant text should be printed or used as fallback output.
        const text = extractPiAssistantText(event.message);
        if (text) {
          this.lastAssistantText = text;
        }
        if (text && text !== this.lastEmittedMessage) {
          const model = this.reportedModel();
          this.emit({
            type: "raw_log",
            content: JSON.stringify({
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text }],
                model,
              },
            }),
          });
          this.emit({ type: "message", role: "assistant", content: text });
          this.lastEmittedMessage = text;
        }
        // Emit context_usage for dashboard tracking.
        // Phase 7: derive `outputTokens` from `SessionStats` delta (pi-ai's
        // `getContextUsage()` doesn't expose per-turn output tokens, but the
        // session-stats counter is monotonic so a delta is correct).
        const usage = this.agentSession.getContextUsage();
        if (usage && usage.tokens != null) {
          const stats = this.agentSession.getSessionStats();
          const currOutput = stats?.tokens?.output ?? 0;
          const outputDelta = Math.max(0, currOutput - this.prevOutputTokens);
          this.prevOutputTokens = currOutput;
          this.emit({
            type: "context_usage",
            contextUsedTokens: usage.tokens,
            contextTotalTokens: usage.contextWindow,
            contextPercent: usage.percent ?? 0,
            outputTokens: outputDelta,
            // Phase 9: pi-ai owns the formula — we just relay its number.
            contextFormula: "pi-delegated",
          });
        }
        break;
      }
      case "tool_execution_start": {
        const status = (event.args as { status?: unknown } | null)?.status;
        if (
          event.toolName.endsWith("store-progress") &&
          typeof status === "string" &&
          TERMINAL_STORE_PROGRESS_STATUSES.has(status)
        ) {
          this.pendingTerminalStoreProgress.add(event.toolCallId);
        }
        const model = this.reportedModel();
        this.emit({
          type: "raw_log",
          content: JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                { type: "tool_use", id: event.toolCallId, name: event.toolName, input: event.args },
              ],
              model,
            },
          }),
        });
        // Emit normalized tool_start for runner auto-progress
        this.emit({
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      }
      case "tool_execution_end":
        if (this.pendingTerminalStoreProgress.delete(event.toolCallId) && !event.isError) {
          this.terminalStoreProgressDone = true;
        }
        this.emit({
          type: "raw_log",
          content: JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: event.toolCallId,
                  content:
                    typeof event.result === "string" ? event.result : JSON.stringify(event.result),
                },
              ],
            },
          }),
        });
        // Emit normalized tool_end
        this.emit({
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        });
        break;
      case "auto_retry_end": {
        // Definitive terminal signal for the RETRYABLE error class
        // (throttle / 5xx / timeout). pi-coding-agent emits success:false with
        // `finalError` only after every retry attempt is exhausted; success:true
        // means the turn recovered, so clear any tracked error.
        if (event.success) {
          this.terminalError = null;
        } else {
          this.terminalError = event.finalError ?? this.terminalError ?? "Unknown error";
        }
        break;
      }
    }
  }

  private async runSession(): Promise<ProviderResult> {
    try {
      // Pi expands a leading `/skill:name` itself, with no tool call to observe.
      const onPromptSkill = this.config.onPromptSkill;
      if (onPromptSkill && this.config.prompt.startsWith("/skill:")) {
        const promptSkill = piPromptSkillName(
          this.config.prompt,
          this.agentSession.resourceLoader.getSkills().skills.map((skill) => skill.name),
        );
        if (promptSkill) onPromptSkill(promptSkill);
      }

      // Send the prompt
      await this.agentSession.prompt(this.config.prompt, {
        source: "rpc",
      });

      // Wait for the agent to finish (poll until not streaming)
      await this.waitForIdle();

      await this.repromptAfterEmptyFinalTurn();

      // Gather cost data
      const stats = this.agentSession.getSessionStats();
      const cost = this.buildCostData(stats);

      // A structured terminal error from pi-coding-agent events is failure by
      // definition (the agent already exhausted retries or hit a non-retryable
      // error). Surface it so the session-chat red box fires and the task fails,
      // exactly like sibling adapters. AWS errors get a categorized, actionable
      // message; anything else surfaces its raw error text.
      if (this.terminalError) {
        const classification = classifyAwsSdkError(this.terminalError);
        const message = classification?.message ?? this.terminalError;
        const category = classification?.category;
        this.emit({ type: "error", message, category });
        return {
          exitCode: 1,
          sessionId: this._sessionId,
          cost,
          isError: true,
          errorCategory: category,
          failureReason: message,
          appliedReasoningEffort: this.appliedReasoningEffort,
        };
      }

      this.emit({
        type: "result",
        cost,
        isError: false,
      });

      return {
        exitCode: 0,
        sessionId: this._sessionId,
        cost,
        output: this.lastAssistantText || undefined,
        isError: false,
        appliedReasoningEffort: this.appliedReasoningEffort,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Defense-in-depth: AWS SDK failures surface as structured events (handled
      // above in runSession), not thrown exceptions, so this catch is for genuine
      // unexpected throws (MCP / transport / etc). Still classify in case an AWS
      // signature ever reaches here, so the red box fires like sibling adapters.
      const awsCatchError = classifyAwsSdkError(errorMessage);
      if (awsCatchError) {
        this.emit({
          type: "error",
          message: awsCatchError.message,
          category: awsCatchError.category,
        });
      }
      this.emit({ type: "raw_stderr", content: `[pi-mono] Error: ${errorMessage}\n` });

      return {
        exitCode: 1,
        sessionId: this._sessionId,
        isError: true,
        errorCategory: awsCatchError?.category,
        failureReason: awsCatchError?.message ?? errorMessage,
        appliedReasoningEffort: this.appliedReasoningEffort,
      };
    } finally {
      this.sessionEnded = true;
      await this.logFileHandle.end();
      if (this.createdSymlink) {
        cleanupAgentsMdSymlink(this.config.cwd);
      }
      this.agentSession.dispose();
    }
  }

  /**
   * Some models end a session on an assistant turn with no text block and no
   * tool call (thinking only, or empty content). pi treats that as a clean end,
   * so a task that needed `store-progress` finishes without a result. Send one
   * reprompt through the normal prompt path, then wait for idle again.
   *
   * Skipped when the final turn has text or a tool call, when it errored or was
   * aborted, when a terminal `store-progress` call already succeeded, and after
   * the first reprompt (a second empty turn is not retried).
   */
  private async repromptAfterEmptyFinalTurn(): Promise<void> {
    if (this.emptyTurnReprompted || !this.finalTurnNeedsReprompt()) return;
    this.emptyTurnReprompted = true;
    try {
      const reprompt = await resolveTemplateAsync("task.nudge.empty_final_turn", {});
      if (reprompt.skipped || !reprompt.text.trim()) return;
      // Workers render templates over HTTP, so abort() or a late event can land
      // while the render is pending. Re-check before starting a new model turn.
      if (!this.finalTurnNeedsReprompt()) return;
      this.emit({
        type: "raw_stderr",
        content: "[pi-mono] final turn had no text and no tool call; sending one reprompt\n",
      });
      await this.agentSession.prompt(reprompt.text, { source: "rpc" });
      await this.waitForIdle();
    } catch (err) {
      // The original outcome stands: a failed nudge must not turn a finished
      // session into a failed one.
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: "raw_stderr",
        content: `[pi-mono] empty-turn reprompt failed: ${message}\n`,
      });
    }
  }

  /** True while the session is still entitled to the one empty-turn reprompt. */
  private finalTurnNeedsReprompt(): boolean {
    const turn = this.lastAssistantTurn;
    return !(
      this.abortRequested ||
      this.terminalError ||
      this.terminalStoreProgressDone ||
      !turn ||
      turn.hasText ||
      turn.hasToolCall ||
      turn.stopReason === "aborted"
    );
  }

  private waitForIdle(): Promise<void> {
    return new Promise<void>((resolve) => {
      // Check if already idle
      if (!this.agentSession.isStreaming) {
        resolve();
        return;
      }

      // Subscribe and wait for agent_end
      const unsub = this.agentSession.subscribe((event) => {
        if (event.type === "agent_end") {
          unsub();
          resolve();
        }
      });
    });
  }

  private buildCostData(stats: SessionStats): CostData {
    return {
      sessionId: "", // Runner overrides with runner session ID
      taskId: this.config.taskId,
      agentId: this.config.agentId,
      totalCostUsd: stats.cost || 0,
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadTokens: stats.tokens.cacheRead,
      cacheWriteTokens: stats.tokens.cacheWrite,
      // Phase 7: real wallclock duration; pi-ai SessionStats doesn't carry
      // one so we track it on this adapter instance.
      durationMs: Date.now() - this.sessionStartedAt,
      numTurns: stats.userMessages + stats.assistantMessages,
      model: this.reportedModel(),
      isError: false,
      provider: "pi",
    };
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    this.listeners.push(listener);
    // Flush queued events
    for (const event of this.eventQueue) {
      listener(event);
    }
    this.eventQueue = [];
  }

  async waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  async abort(): Promise<void> {
    this.abortRequested = true;
    await this.agentSession.abort();
  }

  async deliverSteering({ mode, text }: SteerDelivery): Promise<SteerDeliveryResult> {
    if (this.sessionEnded) {
      // Fail closed: report undeliverable so the server promotes the message
      // to a follow-up task instead of orphaning it in a dead session.
      return { delivered: false, reason: "pi session already completed" };
    }
    try {
      if (mode === "steer") await this.agentSession.steer(text);
      else await this.agentSession.followUp(text);
      return { delivered: true, mode };
    } catch (err) {
      return { delivered: false, reason: String(err) };
    }
  }
}

/** Per-session pi feature switches resolved from flags. */
export interface PiSessionFeatures {
  toolDeferral: boolean;
  /** The agent has installed MCP servers for pi's MCP extension to connect. */
  installedMcp?: boolean;
  /** PI_CODEMODE is on. */
  codemode?: boolean;
  /** PI_CODEMODE_MODELS is on, with codemode: scripts get the `models` API. */
  codemodeModels?: boolean;
}

/**
 * pi's MCP extension with config files disabled. Servers come only from
 * `pi.registerMcpServer` (the swarm hook): a stray `~/.pi/agent/mcp.json` or
 * a repo's `.pi/mcp.json` must never add servers to a swarm session.
 */
export function createSwarmMcpExtension(): ExtensionFactory {
  return createMcpExtension({
    loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
  });
}

/** Extension factories for a pi session: ours first, then pi built-ins the flags turn on. */
export function piExtensionFactories(
  swarmExtension: ExtensionFactory,
  features: PiSessionFeatures,
): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [swarmExtension];
  if (features.toolDeferral) factories.push(createToolSearchExtension());
  if (features.installedMcp) factories.push(createSwarmMcpExtension());
  if (features.codemode) {
    factories.push(
      createBoundedCodemodeExtension(DEFAULT_CODEMODE_LIMITS, {
        models: features.codemodeModels === true,
      }),
    );
  }
  return factories;
}

/** Hard deadline for one codemode script. pi's default is none. */
export const PI_CODEMODE_TIMEOUT_MS = 120_000;
/** Nested tool calls one codemode script may start. */
export const PI_CODEMODE_MAX_NESTED_CALLS = 32;
/** Nested tool calls one codemode script may run at once. */
export const PI_CODEMODE_MAX_CONCURRENT_CALLS = 4;

export interface CodemodeLimits {
  timeoutMs: number;
  maxNestedCalls: number;
  maxConcurrentCalls: number;
}

const DEFAULT_CODEMODE_LIMITS: CodemodeLimits = {
  timeoutMs: PI_CODEMODE_TIMEOUT_MS,
  maxNestedCalls: PI_CODEMODE_MAX_NESTED_CALLS,
  maxConcurrentCalls: PI_CODEMODE_MAX_CONCURRENT_CALLS,
};

/**
 * pi's codemode extension with a per-script deadline and nested-call budget.
 * pi has no option for either: a script runs until it returns unless its own
 * `// @options` line sets `timeout_ms`. Both limits abort the signal pi hands
 * the sandbox, which interrupts the QuickJS worker and fails the codemode call.
 *
 * "on" keeps declared tools declared; "only" would hide the lifecycle tools
 * behind scripts. `models` stays off unless `PI_CODEMODE_MODELS` asks for it.
 * pi 1.0 puts a script's `models.*` usage on the `codemode` tool result and
 * `getSessionStats()` sums it, so model calls from scripts do not bypass the
 * session's cost accounting.
 */
export function createBoundedCodemodeExtension(
  limits: CodemodeLimits = DEFAULT_CODEMODE_LIMITS,
  options: { models?: boolean } = {},
): ExtensionFactory {
  const codemode = createCodemodeExtension({ mode: "on", models: options.models === true });
  return (pi) =>
    codemode(
      new Proxy(pi, {
        get(target, prop) {
          if (prop === "registerTool") {
            return (tool: ToolDefinition) => target.registerTool(boundCodemodeTool(tool, limits));
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
}

export function boundCodemodeTool(tool: ToolDefinition, limits: CodemodeLimits): ToolDefinition {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const script = new AbortController();
      const stop = (message: string) => {
        if (!script.signal.aborted) script.abort(new Error(message));
      };
      const onOuterAbort = () =>
        script.abort(signal?.reason ?? new Error("Codemode script cancelled"));
      if (signal?.aborted) onOuterAbort();
      else signal?.addEventListener("abort", onOuterAbort, { once: true });
      const timer = setTimeout(
        () => stop(`Codemode script exceeded its ${limits.timeoutMs} ms deadline`),
        limits.timeoutMs,
      );

      let started = 0;
      let running = 0;
      const waiters: Array<() => void> = [];
      const release = () => {
        running--;
        waiters.shift()?.();
      };
      const executeTool: typeof ctx.executeTool = async (name, args, options) => {
        if (script.signal.aborted) throw new Error("Codemode script already stopped");
        if (++started > limits.maxNestedCalls) {
          const message = `Codemode script exceeded its budget of ${limits.maxNestedCalls} nested tool calls`;
          stop(message);
          throw new Error(message);
        }
        while (running >= limits.maxConcurrentCalls) {
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
            script.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (script.signal.aborted) {
            waiters.shift()?.();
            throw new Error("Codemode script already stopped");
          }
        }
        running++;
        try {
          return await ctx.executeTool(name, args, {
            ...options,
            signal: options?.signal ?? script.signal,
          });
        } finally {
          release();
        }
      };
      // pi defines `executeTool` non-writable and non-configurable, so a Proxy
      // may not return a different function for it. Copy the descriptors onto
      // a fresh object instead; the getters stay lazy, as in pi's own copies.
      const boundedCtx = ctx
        ? (Object.defineProperties(
            {},
            {
              ...Object.getOwnPropertyDescriptors(ctx),
              executeTool: { value: executeTool, enumerable: true },
            },
          ) as typeof ctx)
        : ctx;

      try {
        return await tool.execute(toolCallId, params, script.signal, onUpdate, boundedCtx);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    },
  };
}

/**
 * Escape a literal for pi's config-value resolver, which runs values that
 * start with `!` as shell commands and expands `$VAR`. Header and env values
 * from the API are resolved secrets, never templates.
 */
function escapePiConfigValue(value: string): string {
  const escaped = value.replace(/\$/g, () => "$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

function escapeValues(values: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!values || typeof values !== "object") return out;
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = escapePiConfigValue(value);
  }
  return out;
}

/**
 * Map installed servers (`fetchInstalledMcpServers(..., "claude")` entries)
 * to pi MCP configs. pi speaks stdio and streamable HTTP; `sse` entries map to
 * HTTP, which is how the previous pi client already reached them. Tools stay
 * `direct`, as before: the prompt lists these servers as in the tool list.
 */
export function toPiMcpServers(
  installed: Record<string, Record<string, unknown>> | null,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(installed ?? {})) {
    if (typeof entry.command === "string") {
      servers[name] = {
        type: "stdio",
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: escapeValues(entry.env),
        exposure: "direct",
      };
    } else if (typeof entry.url === "string") {
      servers[name] = {
        type: "http",
        url: entry.url,
        headers: escapeValues(entry.headers),
        exposure: "direct",
      };
    }
  }
  return servers;
}

/** `defaultTools` additions (`+name`) that activate the built-in tools above. */
export function piDefaultToolAdditions(features: PiSessionFeatures): string[] {
  const additions: string[] = [];
  if (features.toolDeferral) additions.push("+tool_search");
  if (features.codemode) additions.push("+codemode");
  return additions;
}

/**
 * Builds and loads the resource loader for a pi SDK session.
 *
 * The cwd is a task repo clone, which is not trusted, and this worker process
 * holds swarm credentials and tools. So the loader reads nothing from the repo:
 * `projectTrusted: false` blocks `.pi/extensions`, packages, settings and
 * SYSTEM.md, and `noContextFiles` blocks AGENTS.md/CLAUDE.md from the cwd and
 * its ancestors. The system prompt comes only from the server (`systemPrompt`).
 */
export async function createPiResourceLoader(opts: {
  cwd: string;
  agentDir: string;
  systemPrompt?: string;
  extensionFactories: ExtensionFactory[];
}): Promise<{ resourceLoader: DefaultResourceLoader; settingsManager: SettingsManager }> {
  const settingsManager = SettingsManager.create(opts.cwd, opts.agentDir, {
    projectTrusted: false,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    settingsManager,
    noContextFiles: true,
    appendSystemPrompt: opts.systemPrompt ? [opts.systemPrompt] : undefined,
    extensionFactories: opts.extensionFactories,
  });
  // createAgentSession only reloads a loader it builds itself. Without this
  // call a passed loader stays empty: no appended system prompt and no
  // extensions (swarm hooks, tool_search) reach the session.
  await resourceLoader.reload();
  return { resourceLoader, settingsManager };
}

export class PiMonoAdapter implements ProviderAdapter {
  readonly name = "pi";
  // A getter so the prompt's tool-discovery line follows PI_TOOL_DEFERRAL
  // live: the runner rebuilds the system prompt from traits on every task.
  get traits(): ProviderTraits {
    return {
      hasMcp: true,
      hasToolSearch: isPiToolDeferralEnabled(),
      // Pi reads ~/.pi/agent/skills itself and advertises them natively.
      nativeSkillDiscovery: true,
      hasLocalEnvironment: true,
      steerModes: ["steer", "queue"],
    };
  }
  private lastCwd = ".";

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    this.lastCwd = config.cwd;

    console.log(
      `\x1b[2m[${config.role}]\x1b[0m \x1b[35m▸\x1b[0m Spawning pi-mono for task ${config.taskId.slice(0, 8)}`,
    );

    // 1. Set up AGENTS.md symlink
    const createdSymlink = createAgentsMdSymlink(config.cwd);

    // 2. Discover MCP tools from swarm endpoint
    const deferTools = isPiToolDeferralEnabled();
    let customTools: ToolDefinition[] = [];
    if (config.apiUrl && config.apiKey) {
      try {
        const mcpClient = new McpHttpClient(
          config.apiUrl,
          config.apiKey,
          config.agentId,
          config.taskId,
        );
        // Same per-boot runtime identity the runner registers with — dispatch
        // tools require it in multi-runtime mode, and it travels as request
        // context, not as a tool argument.
        const runtimeInstanceId = swarmRuntimeInstanceId();
        if (runtimeInstanceId) {
          mcpClient.customHeaders["X-Runtime-Instance-ID"] = runtimeInstanceId;
        }
        await mcpClient.initialize();
        const tools = await mcpClient.listTools();
        customTools = mcpToolsToDefinitions(mcpClient, tools, {
          deferNonCore: deferTools,
          namespace: SWARM_TOOL_NAMESPACE,
        });
        const deferredCount = deferTools ? tools.filter((t) => !isCoreSwarmTool(t)).length : 0;
        console.log(
          `\x1b[2m[${config.role}]\x1b[0m Discovered ${tools.length} MCP tools from swarm` +
            (deferTools ? ` (${deferredCount} deferred behind tool_search)` : ""),
        );
      } catch (err) {
        console.warn(`\x1b[33m[${config.role}] Failed to discover MCP tools: ${err}\x1b[0m`);
      }
    }

    // 2b. Installed MCP servers (stdio and HTTP) go to pi's own MCP extension,
    // which registers their tools as mcp__<server>__<tool>.
    const installedMcpServers =
      config.apiUrl && config.apiKey && config.agentId
        ? await fetchInstalledMcpServers(config.apiUrl, config.apiKey, config.agentId, "claude")
        : null;
    const piMcpServers = toPiMcpServers(installedMcpServers);
    if (Object.keys(piMcpServers).length > 0) {
      console.log(
        `\x1b[2m[${config.role}]\x1b[0m Registering ${Object.keys(piMcpServers).length} installed MCP server(s) with pi`,
      );
    }

    const sessionEnv = config.env ?? process.env;

    // 3. Resolve model
    // Write the gateway override BEFORE ModelRuntime.create — the runtime
    // loads `<agentDir>/models.json` exactly once at creation.
    await ensureOpenRouterModelsOverride(getAgentDir(), sessionEnv);
    const builtinModel = resolveModel(config.model, sessionEnv);
    const modelRuntime = await createPiRuntimeAuth(sessionEnv);
    // models.json overrides (e.g. the OpenRouter gateway baseUrl) only apply
    // to models resolved through the runtime's composed store; the builtin
    // catalog object from `resolveModel` carries the hardcoded upstream URL
    // and would be used verbatim by the session.
    const model = builtinModel
      ? (modelRuntime.getModel(builtinModel.provider, builtinModel.id) ?? builtinModel)
      : builtinModel;

    // 4. Create swarm hooks extension
    const swarmExtension = createSwarmHooksExtension({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      agentId: config.agentId,
      taskId: config.taskId,
      isLead: config.role === "lead",
      env: sessionEnv,
      mcpServers: piMcpServers,
    });

    const features: PiSessionFeatures = {
      toolDeferral: deferTools,
      installedMcp: Object.keys(piMcpServers).length > 0,
      codemode: isPiCodemodeEnabled(),
      codemodeModels: isPiCodemodeModelsEnabled(),
    };
    if (features.codemode) {
      console.log(
        `\x1b[2m[${config.role}]\x1b[0m codemode on${features.codemodeModels ? " (models)" : ""}`,
      );
    }

    // 5. Create resource loader with system prompt + extensions. SDK sessions
    // load no built-in pi extension, so tool_search is added explicitly.
    const { resourceLoader, settingsManager } = await createPiResourceLoader({
      cwd: config.cwd,
      agentDir: getAgentDir(),
      systemPrompt: config.systemPrompt,
      extensionFactories: piExtensionFactories(swarmExtension, features),
    });
    // tool_search registers inactive; `+` adds it to the default tool set.
    const extraDefaultTools = piDefaultToolAdditions(features);
    if (extraDefaultTools.length > 0) {
      settingsManager.applyOverrides({ defaultTools: extraDefaultTools });
    }

    // 6. Build session options
    const reasoningApplication = applyReasoningEffort("pi", config.model, config.reasoningEffort);
    const reasoningSessionOptions =
      reasoningApplication.kind === "pi-session" ? reasoningApplication.sessionOptions : {};
    const appliedReasoningEffort =
      reasoningApplication.kind === "pi-session" ? (config.reasoningEffort ?? null) : null;
    const sessionOptions: CreateAgentSessionOptions = {
      cwd: config.cwd,
      model,
      customTools,
      resourceLoader,
      settingsManager,
      modelRuntime,
      ...reasoningSessionOptions,
    };

    // 7. Create the session. bindExtensions emits session_start, which the
    // SDK never does on its own: the swarm hook and pi's MCP extension (which
    // connects the installed servers) both run on it.
    const { session } = await createAgentSession(sessionOptions);
    await session.bindExtensions({});

    return new PiMonoSession(session, config, createdSymlink, appliedReasoningEffort);
  }

  async canResume(sessionId: string): Promise<boolean> {
    try {
      const sessionManager = SessionManager.create(this.lastCwd);
      // SessionManager stores sessions as files — check if the session exists
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- pi declares list() as static, so this optional call finds nothing.
      const listable = sessionManager as unknown as { list?(): Promise<Array<{ id: string }>> };
      const sessions = await listable.list?.();
      return sessions?.some((s) => s.id === sessionId) ?? false;
    } catch {
      return false;
    }
  }

  formatCommand(commandName: string): string {
    return `/skill:${commandName}`;
  }
}

/**
 * Pi-mono provider adapter.
 *
 * Creates pi-mono AgentSessions and normalizes their events to the
 * shared ProviderEvent union. MCP tools from the swarm endpoint are
 * discovered at session creation and registered as custom tools.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ignoredBaseUrlVar,
  type OpenAICompatibleProvider,
  openAICompatibleKeyVars,
  openAICompatibleProvider,
  openAICompatibleProviders,
  providerBaseUrl,
  providerForModel,
  providerHarnessModels,
  providerKeyFromEnv,
  providerKeyVars,
} from "@desplega/model-catalog";
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
  type BashSpawnContext,
  createAgentSession,
  createBashToolDefinition,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import "./pi-codemode-runtime";
// Registers the reprompt template in the code registry (the runner loads it too).
import "../commands/templates";
import { contextBoundNoteThreshold, createContextBoundNote } from "../hooks/context-bound-note";
import { resolveTemplateAsync } from "../prompts/resolver";
import { CORE_TOOLS } from "../tools/tool-config";
import { classifyAwsSdkError } from "../utils/aws-error-classifier";
import { parseEnvFlag } from "../utils/env-flag";
import { fetchInstalledMcpServers } from "../utils/mcp-server-fetcher";
import { swarmRuntimeInstanceId } from "../utils/multi-runtime";
import { DEFAULT_OPENROUTER_BASE_URL, getOpenRouterBaseUrl } from "../utils/openrouter-base-url";
import { snapshotCatalogRows } from "../utils/runtime-model-catalog";
import { registerEnvSecrets, scrubObject, scrubSecrets } from "../utils/secret-scrubber";
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
    if (provider === "opencode-go") return ["OPENCODE_API_KEY"];
    // models.json custom providers (`writeSessionModelsJson`). The
    // runner normalizes key aliases (HELMCODE_API_NAN → NAN_API_KEY), but a
    // worker without that step (or a boot-time check) may only see the alias.
    const direct = openAICompatibleProvider(provider);
    if (direct) return providerKeyVars(direct);
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
 * The `opencode-go` model ids this pi-ai build resolves. models.dev can list
 * ids pi-ai does not know yet, and pi runs its default model for those, so the
 * worker reports this list and the picker offers only these ids.
 */
export function listPiOpencodeGoModelIds(): string[] {
  try {
    return getModels("opencode-go").map((m) => m.id);
  } catch {
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

  // Permissive case: any one supported key works. A registry provider key
  // (NaN, Helmcode) only serves `<id>/*` models, but it is still a usable pi
  // credential (the task's explicit model is checked above once it is set).
  if (
    env.ANTHROPIC_API_KEY ||
    env.OPENROUTER_API_KEY ||
    env.OPENAI_API_KEY ||
    openAICompatibleKeyVars().some((k) => env[k])
  ) {
    return { ready: true, missing: [], satisfiedBy: "env" };
  }
  return {
    ready: false,
    missing: ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", authFile],
    hint: `Set one of ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY (any one suffices; ${openAICompatibleProviders()
      .map((p) => p.envVar)
      .join(" or ")} serve only ${openAICompatibleProviders()
      .map((p) => `${p.id}/*`)
      .join(" or ")} models), or run \`pi auth login\` to create ~/.pi/agent/auth.json.`,
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
 * `PI_TOOL_DEFERRAL`: hide non-core swarm tools, and installed MCP server
 * tools, behind pi's `tool_search`. On by default: the deferred schemas cost
 * more on every request than the one partial cache miss a load causes.
 * `false` declares every tool up front. Read from `process.env` by both the
 * adapter traits (which pick the prompt's tool-discovery line) and
 * `createSession`, so the prompt and the session always agree.
 */
export function isPiToolDeferralEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvFlag(env.PI_TOOL_DEFERRAL, true);
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

const PI_RUNTIME_API_KEYS: readonly (readonly [envKey: string, provider: string])[] = [
  ["OPENROUTER_API_KEY", "openrouter"],
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["OPENAI_API_KEY", "openai"],
  ["GEMINI_API_KEY", "google"],
  ["GOOGLE_API_KEY", "google"],
  ["OPENCODE_API_KEY", "opencode-go"],
  // models.json custom providers (the registry). A runtime key beats the
  // file's `apiKey: "$NAN_API_KEY"`, which pi would otherwise read from the
  // shared process.env, where a credential pool is still the raw comma list.
  // Later rows overwrite earlier ones, so each provider's aliases come first
  // and the canonical var (NAN_API_KEY over HELMCODE_API_NAN) wins.
  ...openAICompatibleProviders().flatMap((p) =>
    [...p.aliasEnvVars, p.envVar].map((name) => [name, p.id] as const),
  ),
];

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
  modelsPath?: string,
): Promise<ModelRuntime> {
  // A per-session models.json (`writeSessionModelsJson`) still shares the
  // agent dir's catalog cache, which only holds built-in provider catalogs.
  const modelRuntime = await ModelRuntime.create(
    modelsPath ? { modelsPath, modelsStorePath: join(getAgentDir(), "models-store.json") } : {},
  );
  for (const [envKey, provider] of PI_RUNTIME_API_KEYS) {
    const apiKey = env[envKey];
    if (apiKey) {
      await modelRuntime.setRuntimeApiKey(provider, apiKey);
    }
  }

  return modelRuntime;
}

/**
 * Legacy sidecar marker. Earlier versions wrote the OpenRouter gateway into
 * the shared `<agentDir>/models.json` and recorded here the `baseUrl` they
 * wrote (and any user value they displaced). Nothing writes it any more;
 * `writeSessionModelsJson` reads it to keep such a leftover gateway out of a
 * default-gateway session. Lives next to models.json; NOT part of pi's config
 * surface.
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
 * The models.json `providers.<id>` block for one OpenAI-compatible registry
 * provider, at `baseUrl` (the `<ID>_BASE_URL` override or the registry default).
 *
 * `apiKey` is always the `"$VAR"` interpolation of the canonical env var, never
 * a key value: pi reads a bare name as a literal key. The key a session really
 * uses arrives as a runtime key (`createPiRuntimeAuth`), which beats this field.
 * Costs are 0: the server reprices every session from the pricing table.
 * A `modelsFromCatalog` provider (`vercel`) lists every agent chat model of its
 * catalog snapshot section (`providerHarnessModels`).
 * A `modelId` missing from the list (a catalog id outside it) gets a bare
 * entry so pi still resolves it instead of falling back to its default model;
 * pi fills the omitted limits with its own defaults.
 */
export function customProviderModelsBlock(
  provider: OpenAICompatibleProvider,
  modelId?: string,
  baseUrl: string = provider.baseUrl,
) {
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const listed = providerHarnessModels(provider, snapshotCatalogRows(provider.id));
  const models: Record<string, unknown>[] = listed.map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: [...m.input],
    contextWindow: m.contextWindow,
    maxTokens: m.maxOutputTokens,
    cost: { ...zeroCost },
    compat: { ...m.compat },
  }));
  if (modelId && !listed.some((m) => m.id === modelId)) {
    models.push({ id: modelId, name: modelId, cost: { ...zeroCost } });
  }
  return {
    baseUrl,
    api: "openai-completions",
    apiKey: `$${provider.envVar}`,
    models,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The models.json one pi session loads; see `writeSessionModelsJson`. */
export interface SessionModelsJson {
  /** Per-session models.json, or undefined to load the shared `<agentDir>/models.json`. */
  modelsPath: string | undefined;
  /** Remove the per-session file. Safe to call more than once. */
  dispose(): Promise<void>;
}

/**
 * Compose the models.json this session loads from the shared
 * `<agentDir>/models.json` plus this session's env, and write it to a private
 * temp dir. Concurrent sessions in one worker share `<agentDir>`, so writing
 * per-task values into the shared file lets one session load another's
 * endpoint (and send its key there). The shared file is only ever read: it
 * holds what the operator wrote by hand.
 *
 * The private copy keeps every top-level key and provider of the shared file
 * and adds, from `env` only:
 * - `providers.openrouter.baseUrl`: the session's OpenRouter gateway, over a
 *   hand-authored one. With the default gateway, a value an earlier version
 *   wrote into the shared file (recorded in the legacy marker) is reverted, so
 *   a stale gateway never leaks in.
 * - one block per registry provider (`nan`, `helmcode`, `vercel`) whose key
 *   (canonical var or alias) is set, at its `<ID>_BASE_URL` or the registry
 *   default. A block already in the shared file is user-authored and wins,
 *   except that a `baseUrlLocked` provider (`vercel`) always gets its one
 *   endpoint and API, with a warning when the shared block named another.
 * - `model` (the task's model) adds a bare entry to its provider's block when
 *   its id is outside the table.
 *
 * Nothing to add (no registry key, default gateway, no override marker): no
 * copy, the session loads the shared file as before. A corrupt shared file is
 * replaced by an empty object in the copy; pi cannot load it either way.
 */
export async function writeSessionModelsJson(
  agentDir: string,
  env: Record<string, string | undefined> = process.env,
  model?: string,
): Promise<SessionModelsJson> {
  const sharedPath = join(agentDir, "models.json");
  const registry = openAICompatibleProviders();
  const wanted = registry.filter((p) => providerKeyFromEnv(p, env) !== undefined);
  const gateway = getOpenRouterBaseUrl(env as NodeJS.ProcessEnv);
  const marker = (await readJsonFile(join(agentDir, OPENROUTER_OVERRIDE_MARKER))) as
    | OpenRouterOverrideMarker
    | undefined;
  if (wanted.length === 0 && gateway === DEFAULT_OPENROUTER_BASE_URL && !marker) {
    return { modelsPath: undefined, dispose: async () => {} };
  }

  let shared: Record<string, unknown> = {};
  const sharedFile = Bun.file(sharedPath);
  if (await sharedFile.exists()) {
    try {
      const parsed: unknown = JSON.parse(await sharedFile.text());
      if (!isPlainObject(parsed)) throw new Error("not a JSON object");
      shared = parsed;
    } catch (err) {
      console.warn(
        scrubSecrets(
          `[pi-mono] ${sharedPath} is unreadable/invalid (${err instanceof Error ? err.message : String(err)}); this session loads its own provider blocks only`,
        ),
      );
    }
  }

  const providers = isPlainObject(shared.providers) ? { ...shared.providers } : {};
  const openrouter = isPlainObject(providers.openrouter) ? { ...providers.openrouter } : {};
  if (gateway !== DEFAULT_OPENROUTER_BASE_URL) {
    openrouter.baseUrl = gateway;
  } else if (marker && openrouter.baseUrl === marker.baseUrl) {
    if (marker.previous !== undefined) openrouter.baseUrl = marker.previous;
    else delete openrouter.baseUrl;
  }
  if (Object.keys(openrouter).length > 0) providers.openrouter = openrouter;
  else delete providers.openrouter;

  const modelProvider = providerForModel(model);
  const modelId = modelProvider && model ? model.slice(modelProvider.id.length + 1) : undefined;
  for (const provider of wanted) {
    const ignored = ignoredBaseUrlVar(provider, env);
    if (ignored) {
      console.warn(
        scrubSecrets(
          `[pi-mono] ${ignored} is ignored: ${provider.displayName} is only reached at ${provider.baseUrl}`,
        ),
      );
    }
    const existing = providers[provider.id];
    if (provider.baseUrlLocked && isPlainObject(existing)) {
      if (existing.baseUrl !== provider.baseUrl || existing.api !== "openai-completions") {
        console.warn(
          scrubSecrets(
            `[pi-mono] ${sharedPath} providers.${provider.id} points at ${String(existing.baseUrl)}; using ${provider.baseUrl}`,
          ),
        );
      }
      providers[provider.id] = {
        ...customProviderModelsBlock(
          provider,
          modelProvider?.id === provider.id ? modelId : undefined,
        ),
        ...existing,
        baseUrl: provider.baseUrl,
        api: "openai-completions",
      };
      continue;
    }
    if (existing !== undefined) {
      console.warn(
        scrubSecrets(
          `[pi-mono] ${sharedPath} already has a providers.${provider.id} block; using it as is`,
        ),
      );
      continue;
    }
    providers[provider.id] = customProviderModelsBlock(
      provider,
      modelProvider?.id === provider.id ? modelId : undefined,
      providerBaseUrl(provider, env),
    );
  }

  const next: Record<string, unknown> = { ...shared, providers };
  if (Object.keys(providers).length === 0) delete next.providers;
  const dir = await mkdtemp(join(tmpdir(), "pi-session-models-"));
  const modelsPath = join(dir, "models.json");
  await Bun.write(modelsPath, `${JSON.stringify(next, null, 2)}\n`);
  return {
    modelsPath,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
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
 *
 * `provider/id` strings that pi-ai's builtin catalog does not know (the
 * models.json custom providers of the registry, `nan` / `helmcode`) fall back to
 * `modelRuntime.getModel(provider, id)` when a runtime is passed. When nothing
 * resolves, a scrubbed warning names the model: the session then silently runs
 * pi's own default model, which is otherwise invisible.
 */
export function resolveModel(
  modelStr: string,
  env: Record<string, string | undefined> = process.env,
  modelRuntime?: Pick<ModelRuntime, "getModel">,
) {
  const model = resolveModelInner(modelStr, env, modelRuntime);
  if (modelStr && !model) {
    console.warn(
      scrubSecrets(
        `[pi-mono] Model "${modelStr}" did not resolve to a builtin or models.json model; pi will fall back to its default model`,
      ),
    );
  }
  return model;
}

function resolveModelInner(
  modelStr: string,
  env: Record<string, string | undefined>,
  modelRuntime: Pick<ModelRuntime, "getModel"> | undefined,
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
    let builtin: ReturnType<typeof getModel> | undefined;
    try {
      // pi-ai returns undefined (does not throw) for an unknown provider/id.
      builtin = getModel(provider as "anthropic", modelId as never);
    } catch {
      builtin = undefined;
    }
    if (builtin) return builtin;
    // Custom providers live only in models.json, so only the runtime's
    // composed store knows them.
    return modelRuntime?.getModel(provider, modelId);
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

/** Prompt size of the request behind an assistant message: input + cache read + cache write. */
function requestContextTokens(message: unknown): number | undefined {
  const usage = (
    message as { usage?: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown } }
  )?.usage;
  if (typeof usage?.input !== "number") return undefined;
  const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
  const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
  return usage.input + cacheRead + cacheWrite;
}

/**
 * The session-log line for one LLM call's usage (token counts only, never
 * content). The dashboard reads it as that call's cache-hit chip.
 */
function callUsageLine(message: unknown): string | undefined {
  const usage = (message as { usage?: Record<string, unknown> } | null)?.usage;
  if (typeof usage?.input !== "number") return undefined;
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return JSON.stringify({
    type: "call_usage",
    harness: "pi",
    usage: {
      input: count(usage.input),
      cacheRead: count(usage.cacheRead),
      cacheWrite: count(usage.cacheWrite),
      output: count(usage.output),
      reasoning: count(usage.reasoning),
    },
  });
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

/** Rewrite a pi session file with every line scrubbed. No-op when absent or clean. */
function scrubSessionFileSync(path: string | undefined): void {
  if (!path || !existsSync(path)) return;
  const text = readFileSync(path, "utf-8");
  const scrubbed = scrubSecrets(text);
  if (scrubbed !== text) writeFileSync(path, scrubbed);
}

/**
 * pi persists every session entry to its own `sessions/<cwd>/*.jsonl`, an
 * egress none of ours covers: a provider error that echoes the request's key
 * lands there verbatim. Scrub each entry on its way to disk. The in-memory
 * entries (the model's context) are left as they are. pi's first write flushes
 * every entry held so far, so that file is scrubbed once right after it.
 */
export function scrubPiSessionPersistence(sessionManager: SessionManager): void {
  const persist = sessionManager._persist.bind(sessionManager);
  sessionManager._persist = (entry) => {
    const file = sessionManager.getSessionFile();
    const existed = file ? existsSync(file) : true;
    persist(scrubObject(entry));
    if (!existed) scrubSessionFileSync(file);
  };
}

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
  /** Pending `waitForIdle()` resolvers released when `agent_end` fires or `abort()` is called. */
  private idleResolvers = new Set<() => void>();
  /** Removes this session's own models.json once the session ends. */
  private disposeModels: () => Promise<void>;
  /** Fed each assistant request's prompt size; steers the one-time context-bound note. */
  private readonly observeContextBound: (contextTokens: number | undefined) => Promise<void>;
  /**
   * From a tool-call reply until its turn ends. Pi reads steering after the
   * turn's tool results; a steer queued later waits for the next reply, and
   * when that is the final one it starts another turn.
   */
  private toolTurnOpen = false;

  constructor(
    agentSession: AgentSession,
    config: ProviderSessionConfig,
    createdSymlink: boolean,
    appliedReasoningEffort: ReasoningEffort | null = null,
    disposeModels: () => Promise<void> = async () => {},
  ) {
    this.agentSession = agentSession;
    this.disposeModels = disposeModels;
    this.config = config;
    this.createdSymlink = createdSymlink;
    this.appliedReasoningEffort = appliedReasoningEffort;
    this.logFileHandle = Bun.file(config.logFile).writer();
    this._sessionId = agentSession.sessionId;
    this.sessionStartedAt = Date.now();
    this.observeContextBound = createContextBoundNote({
      threshold: contextBoundNoteThreshold(config.env ?? process.env),
      model: () => this.reportedModel(),
      canDeliver: () => this.toolTurnOpen && !this.sessionEnded && !this.abortRequested,
      inject: (note) => this.deliverSteering({ mode: "steer", text: note }),
    });

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
    // Scrub every event before egress (log file write, listener dispatch,
    // downstream session-logs push + pretty-print): an error or result event
    // can carry a provider message that echoes the request's key.
    const scrubbed = scrubObject(event);

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
          // Ahead of the turn's text and tool lines: the chip rides on the
          // call's first row.
          const usageLine = callUsageLine(event.message);
          if (usageLine) this.emit({ type: "raw_log", content: usageLine });
          if (endMsg.stopReason === "error") {
            // Candidate terminal failure. May still be cleared by a successful
            // retry (auto_retry_end success / a later good message_end).
            this.terminalError = endMsg.errorMessage ?? this.terminalError ?? "Unknown error";
            break;
          }
          // A successful assistant turn means any prior error has recovered.
          this.terminalError = null;
          // Only on tool-call turns: a steer after the final reply would start
          // another turn.
          if (turn.hasToolCall) {
            this.toolTurnOpen = true;
            void this.observeContextBound(requestContextTokens(event.message));
          }
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
      case "turn_end":
        this.toolTurnOpen = false;
        break;
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
          const snapshotCost = this.safeBuildCostData(false);
          if (snapshotCost) {
            this.emit({
              type: "result",
              cost: snapshotCost,
              isError: false,
            });
          }
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
        const message = scrubSecrets(classification?.message ?? this.terminalError);
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
      if (this.abortRequested && this.terminalStoreProgressDone) {
        const cost = this.safeBuildCostData(false);
        if (cost) {
          this.emit({
            type: "result",
            cost,
            isError: false,
          });
        }
        return {
          exitCode: 0,
          sessionId: this._sessionId,
          cost,
          output: this.lastAssistantText || undefined,
          isError: false,
          appliedReasoningEffort: this.appliedReasoningEffort,
        };
      }
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

      const cost = this.safeBuildCostData(true);
      return {
        exitCode: 1,
        sessionId: this._sessionId,
        cost,
        isError: true,
        errorCategory: awsCatchError?.category,
        failureReason: scrubSecrets(awsCatchError?.message ?? errorMessage),
        appliedReasoningEffort: this.appliedReasoningEffort,
      };
    } finally {
      this.sessionEnded = true;
      await this.logFileHandle.end();
      if (this.createdSymlink) {
        cleanupAgentsMdSymlink(this.config.cwd);
      }
      this.agentSession.dispose();
      // Entries pi wrote outside `_persist` (a rewrite on migration or
      // branching) are covered here.
      try {
        // Test doubles of AgentSession may carry no session manager.
        scrubSessionFileSync(this.agentSession.sessionManager?.getSessionFile());
      } catch (err) {
        console.warn(scrubSecrets(`[pi-mono] could not scrub the session file: ${String(err)}`));
      }
      await this.disposeModels();
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

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        unsub();
        this.idleResolvers.delete(finish);
        resolve();
      };

      // Subscribe and wait for agent_end (or abort)
      const unsub = this.agentSession.subscribe((event) => {
        if (event.type === "agent_end") {
          finish();
        }
      });
      this.idleResolvers.add(finish);
      if (this.abortRequested) {
        finish();
      }
    });
  }

  private safeBuildCostData(isError: boolean): CostData | undefined {
    try {
      const stats = this.agentSession.getSessionStats();
      if (!stats) return undefined;
      return { ...this.buildCostData(stats), isError };
    } catch {
      return undefined;
    }
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
    for (const resolve of [...this.idleResolvers]) {
      resolve();
    }
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
 * pi 1.4 caps live codemode workers per process (two unless
 * `PI_CODEMODE_MAX_WORKERS` raises it) and queues a script for a free one for
 * at most 60 seconds. The deadline's abort also ends that wait, before the
 * script starts.
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
 * HTTP, which is how the previous pi client already reached them. With
 * `deferred`, their tools load through `tool_search` like non-core swarm
 * tools; otherwise they are declared up front.
 */
export function toPiMcpServers(
  installed: Record<string, Record<string, unknown>> | null,
  options: { deferred?: boolean } = {},
): Record<string, McpServerConfig> {
  const exposure = options.deferred ? "deferred" : "direct";
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(installed ?? {})) {
    if (typeof entry.command === "string") {
      servers[name] = {
        type: "stdio",
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: escapeValues(entry.env),
        exposure,
      };
    } else if (typeof entry.url === "string") {
      servers[name] = {
        type: "http",
        url: entry.url,
        headers: escapeValues(entry.headers),
        exposure,
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

/** Keys pi computes for each Bash call (PATH carries pi's managed `rg`/`fd` bin dir). */
const PI_SPAWN_ENV_KEYS = [
  "PATH",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;

/**
 * The env one pi Bash call runs with: the session's own env plus the keys pi
 * computed for the call. Nothing else from the process env gets through.
 */
export function buildPiShellEnv(
  sessionEnv: Record<string, string | undefined>,
  spawnEnv: BashSpawnContext["env"],
): BashSpawnContext["env"] {
  const env: BashSpawnContext["env"] = { ...sessionEnv };
  for (const key of PI_SPAWN_ENV_KEYS) {
    if (spawnEnv[key] !== undefined) env[key] = spawnEnv[key];
    else if (key !== "PATH") delete env[key];
  }
  return env;
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
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
          break;
        } catch (err) {
          const error = scrubSecrets(String(err));
          if (attempt === maxAttempts) {
            console.warn(
              `\x1b[33m[${config.role}] Failed to discover MCP tools after ${maxAttempts} attempts: ${error}\x1b[0m`,
            );
          } else {
            const delayMs = 500 * 2 ** (attempt - 1);
            console.warn(
              `\x1b[33m[${config.role}] MCP setup attempt ${attempt}/${maxAttempts} failed: ${error}; retrying in ${delayMs}ms\x1b[0m`,
            );
            await Bun.sleep(delayMs);
          }
        }
      }
    }

    // 2b. Installed MCP servers (stdio and HTTP) go to pi's own MCP extension,
    // which registers their tools as mcp__<server>__<tool>.
    const installedMcpServers =
      config.apiUrl && config.apiKey && config.agentId
        ? await fetchInstalledMcpServers(config.apiUrl, config.apiKey, config.agentId, "claude")
        : null;
    const piMcpServers = toPiMcpServers(installedMcpServers, { deferred: deferTools });
    if (Object.keys(piMcpServers).length > 0) {
      console.log(
        `\x1b[2m[${config.role}]\x1b[0m Registering ${Object.keys(piMcpServers).length} installed MCP server(s) with pi`,
      );
    }

    const sessionEnv = config.env ?? process.env;

    // A key picked from a pool for this task lives only in sessionEnv, so the
    // scrubber's process.env pass cannot see it. Register it before anything
    // (a provider error that echoes it, a log line) can reach an egress.
    registerEnvSecrets(sessionEnv);

    // 3. Resolve model
    // This session's own models.json: the shared file plus the gateway and
    // the registry's custom provider blocks from sessionEnv. Written BEFORE
    // ModelRuntime.create, which loads it exactly once. Nothing writes the
    // shared file, so concurrent sessions never read each other's endpoints.
    const sessionModels = await writeSessionModelsJson(getAgentDir(), sessionEnv, config.model);
    try {
      return await this.createSessionWithModels(config, sessionEnv, sessionModels, {
        createdSymlink,
        customTools,
        deferTools,
        piMcpServers,
      });
    } catch (err) {
      await sessionModels.dispose();
      throw err;
    }
  }

  private async createSessionWithModels(
    config: ProviderSessionConfig,
    sessionEnv: Record<string, string | undefined>,
    sessionModels: SessionModelsJson,
    setup: {
      createdSymlink: boolean;
      customTools: ToolDefinition[];
      deferTools: boolean;
      piMcpServers: Record<string, McpServerConfig>;
    },
  ): Promise<ProviderSession> {
    const { createdSymlink, customTools, deferTools, piMcpServers } = setup;
    // The runtime is created before resolving so custom providers, which only
    // exist in its composed store, can resolve.
    const modelRuntime = await createPiRuntimeAuth(sessionEnv, sessionModels.modelsPath);
    const resolvedModel = resolveModel(config.model, sessionEnv, modelRuntime);
    // models.json overrides (e.g. the OpenRouter gateway baseUrl) only apply
    // to models resolved through the runtime's composed store; the builtin
    // catalog object from `resolveModel` carries the hardcoded upstream URL
    // and would be used verbatim by the session.
    const model = resolvedModel
      ? (modelRuntime.getModel(resolvedModel.provider, resolvedModel.id) ?? resolvedModel)
      : resolvedModel;

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
    // pi's built-in Bash tool spawns with a copy of process.env, which is
    // shared by every concurrent session and never sees this task's env (rows
    // admitted or withheld by fetchResolvedEnv after boot). A custom tool
    // named "bash" replaces the built-in, so every shell call, including
    // codemode's executeTool("bash"), runs with this session's env.
    const bashTool = defineTool(
      createBashToolDefinition(config.cwd, {
        commandPrefix: settingsManager.getShellCommandPrefix(),
        shellPath: settingsManager.getShellPath(),
        spawnHook: (context) => ({ ...context, env: buildPiShellEnv(sessionEnv, context.env) }),
      }),
    );
    // pi's own default session manager (same session dir), with its writes
    // to `sessions/*.jsonl` scrubbed.
    const sessionManager = SessionManager.create(config.cwd);
    scrubPiSessionPersistence(sessionManager);
    const sessionOptions: CreateAgentSessionOptions = {
      cwd: config.cwd,
      sessionManager,
      model,
      customTools: [...customTools, bashTool],
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

    return new PiMonoSession(
      session,
      config,
      createdSymlink,
      appliedReasoningEffort,
      sessionModels.dispose,
    );
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

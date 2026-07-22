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
  CreateAgentSessionOptions,
  SessionStats,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { classifyAwsSdkError } from "../utils/aws-error-classifier";
import { scrubSecrets } from "../utils/secret-scrubber";
import { readPkgVersion } from "./harness-version";
import { createSwarmHooksExtension } from "./pi-mono-extension";
import { McpHttpClient } from "./pi-mono-mcp-client";
import { applyReasoningEffort, type ReasoningEffort } from "./reasoning-effort";
import type {
  CostData,
  CredCheckOptions,
  CredStatus,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
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
    if (provider === "google") return ["GOOGLE_API_KEY"];
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
  // Determine Bedrock SDK mode:
  //   - Explicit:  BEDROCK_AUTH_MODE=sdk
  //   - Fallback:  BEDROCK_AUTH_MODE absent AND MODEL_OVERRIDE starts with
  //                "amazon-bedrock/" (preserves today's prefix-inference semantics)
  // BEDROCK_AUTH_MODE=bearer is declared/validated but the full bearer-token
  // path is not implemented yet — it falls through to the standard auth check.
  const bedrockAuthMode = env.BEDROCK_AUTH_MODE?.toLowerCase();
  const isBedrockSdk =
    bedrockAuthMode === "sdk" ||
    (bedrockAuthMode === undefined &&
      env.MODEL_OVERRIDE?.toLowerCase().startsWith("amazon-bedrock/"));

  if (isBedrockSdk) {
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
        satisfiedBy: "sdk-delegated",
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

/** Convert MCP tools to pi-mono ToolDefinition objects */
function mcpToolsToDefinitions(
  mcpClient: McpHttpClient,
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>,
): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description || tool.name,
    parameters: jsonSchemaToTypeBox(tool.inputSchema),
    async execute(_toolCallId, params) {
      const result = await mcpClient.callTool(tool.name, params as Record<string, unknown>);
      const text = result.content
        .map((c) => c.text ?? "")
        .filter(Boolean)
        .join("\n");
      return {
        content: [{ type: "text" as const, text: text || "(no output)" }],
        details: undefined,
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
      await modelRuntime.setRuntimeApiKey(provider, apiKey, { allowNetwork: false });
    }
  }

  return modelRuntime;
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
          if (endMsg.stopReason === "error") {
            // Candidate terminal failure. May still be cleared by a successful
            // retry (auto_retry_end success / a later good message_end).
            this.terminalError = endMsg.errorMessage ?? this.terminalError ?? "Unknown error";
            break;
          }
          // A successful assistant turn means any prior error has recovered.
          this.terminalError = null;
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
      // Send the prompt
      await this.agentSession.prompt(this.config.prompt, {
        source: "rpc",
      });

      // Wait for the agent to finish (poll until not streaming)
      await this.waitForIdle();

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
      await this.logFileHandle.end();
      if (this.createdSymlink) {
        cleanupAgentsMdSymlink(this.config.cwd);
      }
      this.agentSession.dispose();
    }
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
    await this.agentSession.abort();
  }
}

export class PiMonoAdapter implements ProviderAdapter {
  readonly name = "pi";
  readonly traits = { hasMcp: true, hasLocalEnvironment: true };
  private lastCwd = ".";

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    this.lastCwd = config.cwd;

    console.log(
      `\x1b[2m[${config.role}]\x1b[0m \x1b[35m▸\x1b[0m Spawning pi-mono for task ${config.taskId.slice(0, 8)}`,
    );

    // 1. Set up AGENTS.md symlink
    const createdSymlink = createAgentsMdSymlink(config.cwd);

    // 2. Discover MCP tools from swarm endpoint
    let customTools: ToolDefinition[] = [];
    if (config.apiUrl && config.apiKey) {
      try {
        const mcpClient = new McpHttpClient(
          config.apiUrl,
          config.apiKey,
          config.agentId,
          config.taskId,
        );
        await mcpClient.initialize();
        const tools = await mcpClient.listTools();
        customTools = mcpToolsToDefinitions(mcpClient, tools);
        console.log(
          `\x1b[2m[${config.role}]\x1b[0m Discovered ${tools.length} MCP tools from swarm`,
        );
      } catch (err) {
        console.warn(`\x1b[33m[${config.role}] Failed to discover MCP tools: ${err}\x1b[0m`);
      }

      // 2b. Discover tools from installed MCP servers (HTTP/SSE transport only)
      try {
        const mcpServersRes = await fetch(
          `${config.apiUrl}/api/agents/${config.agentId}/mcp-servers?resolveSecrets=true`,
          {
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "X-Agent-ID": config.agentId,
            },
          },
        );
        if (mcpServersRes.ok) {
          const mcpServersData = (await mcpServersRes.json()) as {
            servers: Array<{
              name: string;
              transport: string;
              url?: string;
              headers?: string;
              isActive: boolean;
              isEnabled: boolean;
              resolvedHeaders?: Record<string, string>;
            }>;
          };
          const httpServers = mcpServersData.servers.filter(
            (s) =>
              s.isActive &&
              s.isEnabled &&
              (s.transport === "http" || s.transport === "sse") &&
              s.url,
          );

          for (const srv of httpServers) {
            try {
              const srvClient = new McpHttpClient(srv.url!, "", "");
              srvClient.useRawUrl = true;
              // Build custom headers from static headers + resolved secret headers
              let parsedHeaders: Record<string, string> = {};
              try {
                parsedHeaders = srv.headers ? JSON.parse(srv.headers) : {};
              } catch {
                // invalid JSON
              }
              srvClient.customHeaders = {
                ...parsedHeaders,
                ...(srv.resolvedHeaders || {}),
              };
              await srvClient.initialize();
              const srvTools = await srvClient.listTools();
              // Prefix tool names with mcp__<server-name>__ to avoid conflicts
              const prefixed = mcpToolsToDefinitions(srvClient, srvTools).map((t) => ({
                ...t,
                name: `mcp__${srv.name}__${t.name}`,
              }));
              customTools.push(...prefixed);
              console.log(
                `\x1b[2m[${config.role}]\x1b[0m Discovered ${srvTools.length} tools from MCP server "${srv.name}"`,
              );
            } catch (srvErr) {
              console.warn(
                `\x1b[33m[${config.role}] Failed to discover tools from MCP server "${srv.name}": ${srvErr}\x1b[0m`,
              );
            }
          }
        }
      } catch {
        // Non-fatal — installed MCP server tool discovery is optional
      }
    }

    const sessionEnv = config.env ?? process.env;

    // 3. Resolve model
    const model = resolveModel(config.model, sessionEnv);
    const modelRuntime = await createPiRuntimeAuth(sessionEnv);

    // 4. Create swarm hooks extension
    const swarmExtension = createSwarmHooksExtension({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      agentId: config.agentId,
      taskId: config.taskId,
      isLead: config.role === "lead",
    });

    // 5. Create resource loader with system prompt + extension
    const resourceLoader = new DefaultResourceLoader({
      cwd: config.cwd,
      agentDir: getAgentDir(),
      appendSystemPrompt: config.systemPrompt ? [config.systemPrompt] : undefined,
      extensionFactories: [swarmExtension],
    });

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
      modelRuntime,
      ...reasoningSessionOptions,
    };

    // 7. Create the session
    const { session } = await createAgentSession(sessionOptions);

    return new PiMonoSession(session, config, createdSymlink, appliedReasoningEffort);
  }

  async canResume(sessionId: string): Promise<boolean> {
    try {
      const sessionManager = SessionManager.create(this.lastCwd);
      // SessionManager stores sessions as files — check if the session exists
      const sessions = await (
        sessionManager as unknown as { list(): Promise<Array<{ id: string }>> }
      ).list?.();
      return sessions?.some((s) => s.id === sessionId) ?? false;
    } catch {
      return false;
    }
  }

  formatCommand(commandName: string): string {
    return `/skill:${commandName}`;
  }
}

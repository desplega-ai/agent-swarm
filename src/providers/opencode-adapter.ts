/**
 * Opencode provider adapter (OpenCode 2).
 *
 * OpenCode 2 runs in-process through `@opencode/sdk`: one embedded host per
 * task, no `opencode serve` child, no port, no config or data-home files.
 * Config travels as a string, the database is in memory, and the swarm plugin
 * is a plain object (`opencode-swarm-plugin.ts`) passed to `OpenCode.create`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  baseUrlOverride,
  ignoredBaseUrlVar,
  type OpenAICompatibleProvider,
  openAICompatibleKeyVars,
  openAICompatibleProvider,
  openAICompatibleProviders,
  providerBaseUrl,
  providerForKeyVar,
  providerKeyVars,
} from "@desplega/model-catalog";
import type { OpenCode, OpenCodeEvent } from "@opencode/sdk";
import { contextBoundNoteThreshold, createContextBoundNote } from "../hooks/context-bound-note";
import {
  CONTEXT_FORMULA,
  clampContextPercent,
  getContextWindowSize,
} from "../utils/context-window";
import {
  openAICompatibleKeyLabels,
  splitCredentialPool,
  validateOpencodeCredentials,
} from "../utils/credentials";
import { isEnvFlagEnabled, isSessionSummarySkipped } from "../utils/env-flag";
import { fetchInstalledMcpServers } from "../utils/mcp-server-fetcher";
import { swarmRuntimeInstanceId } from "../utils/multi-runtime";
import {
  DEFAULT_OPENROUTER_BASE_URL,
  getOpenRouterAttributionHeaders,
  getOpenRouterBaseUrl,
} from "../utils/openrouter-base-url";
import { registerVolatileSecret, scrubSecrets } from "../utils/secret-scrubber";
import { resolveSlashSkillPrompt } from "./codex-skill-resolver";
import { CTX_MODE_NUDGE_EVERY } from "./ctx-mode-env";
import { OpenRouterBilling } from "./opencode-billing";
import {
  createOpencodeSwarmPlugin,
  type OpencodeRequestContext,
  type OpencodeToolLister,
} from "./opencode-swarm-plugin";
import {
  apiHeaders,
  autoIndexMemoryFile,
  fireAndForget,
  type SwarmHooksConfig,
  summarizeTranscript,
  syncIdentityFilesToServer,
} from "./pi-mono-extension";
import { applyReasoningEffort, type ReasoningEffort } from "./reasoning-effort";
import {
  BUILTIN_TOOL_GROUP,
  HookCompositionReporter,
  type HookRequestMeasure,
  type HookToolGroup,
  measureHookRequest,
  postHookComposition,
  SWARM_TOOL_GROUP,
  textChars,
} from "./request-composition-hook";
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
 * The subset of OpenCode's V1-shaped config we write. OpenCode 2 still reads
 * V1 config (`opencode.json`, `OPENCODE_CONFIG_CONTENT`) and normalizes it in
 * memory, so the ACP target and this adapter share one shape.
 */
export type OpencodeConfig = {
  provider?: Record<
    string,
    {
      /** Env var names OpenCode reads the key from; `[]` stops it reading `process.env`. */
      env?: string[];
      npm?: string;
      name?: string;
      options?: Record<string, unknown>;
      models?: Record<string, { options?: Record<string, unknown>; [key: string]: unknown }>;
    }
  >;
  [key: string]: unknown;
};

/**
 * Map opencode model strings to the env var that satisfies them. Opencode
 * uses the same `provider/model-id` shape as pi-mono — the prefix tells us
 * which key the user must supply.
 */
function opencodeModelToCredKey(modelStr: string | undefined): string | null {
  if (!modelStr) return null;
  if (modelStr.includes("/")) {
    const provider = modelStr.slice(0, modelStr.indexOf("/")).toLowerCase();
    if (provider === "anthropic") return "ANTHROPIC_API_KEY";
    if (provider === "openrouter") return "OPENROUTER_API_KEY";
    if (provider === "openai") return "OPENAI_API_KEY";
    // OpenAI-compatible registry providers (`nan`, `helmcode`).
    const direct = openAICompatibleProvider(provider);
    if (direct) return direct.envVar;
  }
  return null;
}

/**
 * Env var names that satisfy `requiredKey`. The runner copies a registry
 * key alias (`HELMCODE_API_NAN`) into its canonical var per task, but a
 * check that reads `process.env` directly sees only the alias.
 */
function credKeyNames(requiredKey: string): readonly string[] {
  const direct = providerForKeyVar(requiredKey);
  return direct ? providerKeyVars(direct) : [requiredKey];
}

/** Keys that satisfy opencode when no model pins a provider. */
const OPENCODE_ANY_KEY_VARS = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  ...openAICompatibleKeyVars(),
];

/**
 * Opencode is satisfied by ANY of:
 *   1. `~/.local/share/opencode/auth.json` exists (the file `opencode auth login`
 *      writes; OpenCode 2 imports it into its credential store on start).
 *   2. `MODEL_OVERRIDE` resolves to a provider-prefixed model — only that
 *      provider's key is required (a registry provider also accepts its key
 *      aliases: `nan/*` takes `HELMCODE_API_NAN`).
 *   3. Otherwise any one of OPENROUTER_API_KEY / ANTHROPIC_API_KEY /
 *      OPENAI_API_KEY / a registry provider key (canonical or alias)
 *      suffices.
 */
export function checkOpencodeCredentials(
  env: Record<string, string | undefined>,
  opts: CredCheckOptions = {},
): CredStatus {
  const homeDir = opts.homeDir ?? env.HOME ?? "/root";
  const probe = opts.fs?.existsSync ?? existsSync;
  const authFile = `${homeDir}/.local/share/opencode/auth.json`;
  if (probe(authFile)) {
    return { ready: true, missing: [], satisfiedBy: "file" };
  }

  const requiredKey = opencodeModelToCredKey(env.MODEL_OVERRIDE);
  if (requiredKey) {
    if (credKeyNames(requiredKey).some((name) => env[name])) {
      return { ready: true, missing: [], satisfiedBy: "env" };
    }
    return {
      ready: false,
      missing: [requiredKey, authFile],
      hint: `MODEL_OVERRIDE=${env.MODEL_OVERRIDE} requires ${requiredKey}; or run \`opencode auth login\` to create ${authFile}.`,
    };
  }

  if (OPENCODE_ANY_KEY_VARS.some((name) => env[name])) {
    return { ready: true, missing: [], satisfiedBy: "env" };
  }
  return {
    ready: false,
    missing: [
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      ...openAICompatibleProviders().map((p) => p.envVar),
      authFile,
    ],
    hint: `Set one of ${[
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      ...openAICompatibleKeyLabels(),
    ].join(
      " / ",
    )} (any one suffices), or run \`opencode auth login\` to create ~/.local/share/opencode/auth.json.`,
  };
}

function defaultOpencodeSkillsDir(): string {
  if (process.env.OPENCODE_SKILLS_DIR) {
    return process.env.OPENCODE_SKILLS_DIR;
  }
  return join(process.env.HOME ?? "/home/worker", ".opencode", "skills");
}

// The worker image installs `@opencode/sdk` with `npm install -g`. It stays on
// disk instead of being bundled into the compiled binary because it carries
// native modules (pty, file watcher, tree-sitter).
const OPENCODE_SDK_GLOBAL_ROOTS = ["/usr/lib/node_modules", "/usr/local/lib/node_modules"];
const OPENCODE_SDK_SUBPATH = "@opencode/sdk/dist/index.js";

/**
 * `OPENCODE_SDK_PATH` wins, then the global npm roots, then the bare package
 * name (resolved from the repo's node_modules when running from source).
 */
export function resolveOpencodeSdkSpecifier(): string {
  const override = process.env.OPENCODE_SDK_PATH;
  if (override) return override;
  for (const root of OPENCODE_SDK_GLOBAL_ROOTS) {
    const candidate = join(root, OPENCODE_SDK_SUBPATH);
    if (existsSync(candidate)) return candidate;
  }
  return "@opencode/sdk";
}

type OpencodeSdk = typeof import("@opencode/sdk");
type LoadedOpencodeSdk = { sdk: OpencodeSdk; version?: string };

/** The embedded host reports no version of its own; read the SDK's package.json. */
function readOpencodeSdkVersion(entry: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

// A variable specifier keeps `bun build --compile` from bundling the SDK.
async function loadOpencodeSdk(): Promise<LoadedOpencodeSdk> {
  const specifier = resolveOpencodeSdkSpecifier();
  const sdk = (await import(specifier)) as OpencodeSdk;
  const entry = specifier.startsWith("/") ? specifier : Bun.resolveSync(specifier, import.meta.dir);
  return { sdk, version: readOpencodeSdkVersion(entry) };
}

let loadOpencodeSdkImpl = loadOpencodeSdk;

export function _setOpencodeSdkLoaderForTests(fn: (() => Promise<LoadedOpencodeSdk>) | null): void {
  loadOpencodeSdkImpl = fn ?? loadOpencodeSdk;
}

/**
 * Route OpenRouter traffic through the configured gateway (see
 * src/utils/openrouter-base-url.ts). opencode's bundled openrouter provider
 * honors `provider.openrouter.options.baseURL`. Mutates `opencodeConfig` in
 * place, and attribute direct OpenRouter requests to Agent Swarm.
 */
export function applyOpenRouterBaseUrlOverride(
  opencodeConfig: OpencodeConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  const openRouterBaseUrl = getOpenRouterBaseUrl(env as NodeJS.ProcessEnv);
  const headers = getOpenRouterAttributionHeaders(openRouterBaseUrl, env);
  const overrideBaseUrl = openRouterBaseUrl !== DEFAULT_OPENROUTER_BASE_URL;
  if (!overrideBaseUrl && Object.keys(headers).length === 0) return;
  opencodeConfig.provider = {
    ...opencodeConfig.provider,
    openrouter: {
      ...opencodeConfig.provider?.openrouter,
      options: {
        ...opencodeConfig.provider?.openrouter?.options,
        ...(overrideBaseUrl ? { baseURL: openRouterBaseUrl } : {}),
        ...(Object.keys(headers).length > 0
          ? {
              headers: {
                ...(opencodeConfig.provider?.openrouter?.options?.headers as
                  | Record<string, string>
                  | undefined),
                ...headers,
                "X-Title": "Agent Swarm",
              },
            }
          : {}),
      },
    },
  };
}

/**
 * OpenCode provider block for an OpenAI-compatible registry provider that
 * OpenCode does not ship (`catalog: "registry"`, e.g. `helmcode`). `apiKey` is
 * a literal key (embedded host) or an `{env:NAME}` reference (ACP
 * subprocess). `baseUrl` is the `<ID>_BASE_URL` override or the registry
 * default. `env: []` keeps OpenCode from reading a key out of `process.env`.
 * A `modelId` missing from the registry (accepted through `allowCustomModel`)
 * gets a bare entry so OpenCode still resolves it instead of falling back to
 * its default model.
 */
export function buildOpenAICompatibleProviderBlock(
  provider: OpenAICompatibleProvider,
  apiKey: string,
  modelId?: string,
  baseUrl: string = provider.baseUrl,
): NonNullable<OpencodeConfig["provider"]>[string] {
  const models: Record<string, Record<string, unknown>> = {};
  for (const m of provider.models) {
    models[m.id] = {
      name: m.name,
      tool_call: true,
      reasoning: m.reasoning,
      limit: { context: m.contextWindow, output: m.maxOutputTokens },
    };
  }
  if (modelId && !models[modelId]) models[modelId] = { name: modelId, tool_call: true };
  return {
    npm: provider.npm,
    name: provider.displayName,
    env: [],
    options: { baseURL: baseUrl, apiKey },
    models,
  };
}

/**
 * Built-in OpenCode providers whose key OpenCode reads from `process.env`:
 * `openrouter` plus every registry provider models.dev lists
 * (`catalog: "models.dev"`, e.g. `nan`), which OpenCode ships built in.
 */
function envBoundKeyVars(providerId: string): readonly string[] | undefined {
  if (providerId === "openrouter") return ["OPENROUTER_API_KEY"];
  const direct = openAICompatibleProvider(providerId);
  return direct?.catalog === "models.dev" ? providerKeyVars(direct) : undefined;
}

/** Registry providers OpenCode does not ship (`catalog: "registry"`); they get a full custom block. */
function customBlockProvider(providerId: string): OpenAICompatibleProvider | undefined {
  const direct = openAICompatibleProvider(providerId);
  return direct?.catalog === "registry" ? direct : undefined;
}

/**
 * One key from the first non-empty var in `names`. The runner's per-task env
 * already holds one picked pool member; a value that still carries a comma
 * pool (no runner, or `process.env`) yields its first member.
 */
function pickProviderKey(
  env: Record<string, string | undefined>,
  names: readonly string[],
): { key: string; name: string } | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (!value) continue;
    const key = splitCredentialPool(value)[0];
    if (key) return { key, name };
  }
  return undefined;
}

/**
 * Hand the embedded host exactly one key for the active model's provider.
 *
 * Embedded OpenCode reads a built-in provider's key from the shared
 * `process.env`, and that value beats `options.apiKey`. The entrypoint exports
 * a credential pool there as a raw comma list, and a key saved from the
 * dashboard after boot never reaches `process.env` at all, so both 401 without
 * this splice. For `openrouter` and the built-in registry providers (`nan`,
 * `vercel`) it sets `env: []` plus `options.apiKey` (and `options.baseURL`
 * when `<ID>_BASE_URL` is set; a `baseUrlLocked` provider gets none); for registry providers OpenCode does not ship
 * (`helmcode`) it writes the full custom provider block at
 * `<ID>_BASE_URL` or the registry default. No splice when the key is absent
 * (credStatus reports that).
 *
 * The key lives only in the in-memory config string handed to the SDK.
 * Mutates `opencodeConfig` in place and returns the env var the key came from,
 * or `undefined` when nothing was spliced.
 */
export function applyProviderKeySplice(
  opencodeConfig: OpencodeConfig,
  model: string | undefined,
  env: Record<string, string | undefined>,
): { key: string; name: string } | undefined {
  const slash = model?.indexOf("/") ?? -1;
  if (!model || slash <= 0) return undefined;
  const providerId = model.slice(0, slash);
  const existing = opencodeConfig.provider?.[providerId];

  const custom = customBlockProvider(providerId);
  if (custom) {
    const picked = pickProviderKey(env, providerKeyVars(custom));
    if (!picked) return undefined;
    const block = buildOpenAICompatibleProviderBlock(
      custom,
      picked.key,
      model.slice(slash + 1),
      providerBaseUrl(custom, env),
    );
    opencodeConfig.provider = {
      ...opencodeConfig.provider,
      [providerId]: {
        ...existing,
        ...block,
        options: { ...existing?.options, ...block.options },
        models: { ...existing?.models, ...block.models },
      },
    };
    return picked;
  }

  const names = envBoundKeyVars(providerId);
  if (!names) return undefined;
  const picked = pickProviderKey(env, names);
  if (!picked) return undefined;
  const direct = openAICompatibleProvider(providerId);
  const baseURL = direct ? baseUrlOverride(direct, env) : undefined;
  const options = { ...existing?.options, ...(baseURL ? { baseURL } : {}), apiKey: picked.key };
  if (direct?.baseUrlLocked) {
    // OpenCode's built-in SDK (AI Gateway) knows its endpoint; any URL here is wrong.
    const ignored = ignoredBaseUrlVar(direct, env);
    if (ignored || options.baseURL !== undefined) {
      console.warn(
        `[opencode] ${ignored ?? `provider.${providerId}.options.baseURL`} is ignored: ${direct.displayName} uses its built-in endpoint`,
      );
    }
    delete options.baseURL;
  }
  opencodeConfig.provider = {
    ...opencodeConfig.provider,
    [providerId]: { ...existing, env: [], options },
  };
  return picked;
}

const SWARM_AGENT_NAME = "swarm";
const TRANSCRIPT_TAIL_CHARS = 20_000;
const TOOL_RESULT_PREVIEW_CHARS = 500;
// The last response body finishes streaming with the step; this only covers
// a read still in flight when the session ends.
const BILLING_SETTLE_MS = 2_000;

/** The swarm MCP server's name in the OpenCode config. */
const SWARM_MCP_SERVER = "swarm";
/** Swarm tools a session cannot report without. OpenCode keys them `swarm_<tool>`. */
const REQUIRED_SWARM_TOOLS = ["store-progress"];
const ADMISSION_POLL_MS = 250;

type SessionEndHooks = {
  /** Cap on session-end network work; host close and completion never wait longer. */
  budgetMs: number;
  /** Cap on swarm MCP connect plus tool discovery before the first prompt. */
  admissionTimeoutMs: number;
  syncIdentity: typeof syncIdentityFilesToServer;
};
const DEFAULT_SESSION_HOOKS: SessionEndHooks = {
  budgetMs: 10_000,
  admissionTimeoutMs: 30_000,
  syncIdentity: syncIdentityFilesToServer,
};
let sessionHooks = DEFAULT_SESSION_HOOKS;

export function _setOpencodeSessionHooksForTests(hooks: Partial<SessionEndHooks> | null): void {
  sessionHooks = hooks ? { ...DEFAULT_SESSION_HOOKS, ...hooks } : DEFAULT_SESSION_HOOKS;
}

/** Resolve after `promise` settles or `ms` elapses, whichever is first. Never rejects. */
async function settleWithin(promise: Promise<unknown>, ms: number, signal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  try {
    await Promise.race([promise.catch(() => {}), cut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait until the swarm MCP server is connected and its required tools are
 * registered. OpenCode turns a refused or unauthorized server into a status
 * and keeps going, so without this check a session would run without
 * `store-progress`. Returns null when admitted, else the reason.
 */
export async function checkSwarmMcpAdmission(
  host: Pick<OpenCode.Interface, "mcp">,
  directory: string,
  listTools: () => OpencodeToolLister | undefined,
  timeoutMs: number,
  isCancelled: () => boolean = () => false,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let last = "swarm MCP server is not registered";
  while (!isCancelled()) {
    const servers = await host.mcp.list({ location: { directory } });
    const status = servers.data.find((server) => server.name === SWARM_MCP_SERVER)?.status;
    if (status?.status === "failed" || status?.status === "needs_auth") {
      return `swarm MCP server ${status.status}: ${status.error}`;
    }
    if (status?.status === "disabled") return "swarm MCP server is disabled";
    if (status?.status === "connected") {
      const lister = listTools();
      const ids = new Set(lister ? (await lister()).map((tool) => tool.id) : []);
      const missing = REQUIRED_SWARM_TOOLS.filter((tool) => !ids.has(`swarm_${tool}`));
      if (missing.length === 0) return null;
      last = `swarm MCP server connected without required tools: ${missing.join(", ")}`;
    } else if (status) {
      last = `swarm MCP server still ${status.status}`;
    }
    if (Date.now() >= deadline) return `${last} after ${timeoutMs}ms`;
    await Bun.sleep(ADMISSION_POLL_MS);
  }
  return null;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? fallback);
  }
  return error === undefined ? fallback : String(error);
}

function toolResultText(content: ReadonlyArray<{ type: string; text?: string }> | undefined) {
  return (content ?? [])
    .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
    .join("");
}

/**
 * Tool name → schema group. OpenCode keys MCP tools `<server>_<tool>`; any
 * other tool is an OpenCode built-in.
 */
export function opencodeToolGroupOf(
  mcpServers: readonly string[],
): (name: string) => HookToolGroup {
  // Longest first, so `a_b` wins over `a` for a tool `a_b_x`.
  const servers = [...mcpServers].sort((a, b) => b.length - a.length);
  return (name) => {
    const server = servers.find((candidate) => name.startsWith(`${candidate}_`));
    if (!server) return BUILTIN_TOOL_GROUP;
    if (server === SWARM_MCP_SERVER) return SWARM_TOOL_GROUP;
    return { id: `mcp:${server}`, label: `${server} tool schemas` };
  };
}

/** Measure one primary request from OpenCode's `context` hook event. */
export function measureOpencodeContext(
  event: OpencodeRequestContext,
  groupOf: (name: string) => HookToolGroup,
): HookRequestMeasure {
  return measureHookRequest({
    system: event.system.map((part) => part.text ?? "").join("\n"),
    tools: Object.entries(event.tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      schema: tool.input,
    })),
    messageChars: textChars(event.messages),
    groupOf,
  });
}

export class OpencodeSession implements ProviderSession {
  private listeners: Array<(event: ProviderEvent) => void> = [];
  // The runner attaches its listener after `createSession` resolves; buffer
  // events (session_init first) until then so none are lost.
  private pendingEvents: ProviderEvent[] = [];
  private completionResolve!: (result: ProviderResult) => void;
  private completionPromise: Promise<ProviderResult>;
  private aborted = false;
  private completed = false;
  // Cancels session-end network work when the session is aborted mid-finish.
  private readonly sessionEnd = new AbortController();
  private startedAt = Date.now();

  // `session.usage.updated` carries the cumulative session totals.
  private usage = {
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  private steps = 0;
  private toolNames = new Map<string, string>();
  // Assistant text by message, in part order; the runner keeps the last emit.
  private textByMessage = new Map<string, string[]>();
  private transcript: string[] = [];
  /** Set when the session posts harness-hook request composition manifests. */
  composition: HookCompositionReporter | undefined;
  /** Fed each step's prompt size; steers the one-time context-bound note. */
  private readonly observeContextBound: (contextTokens: number | undefined) => Promise<void>;

  constructor(
    private readonly host: OpenCode.Interface,
    private readonly _sessionId: string,
    private model: string,
    private readonly swarm: SwarmHooksConfig,
    private readonly cwd: string,
    private readonly appliedReasoningEffort: ReasoningEffort | null = null,
    private readonly billing?: OpenRouterBilling,
  ) {
    this.completionPromise = new Promise<ProviderResult>((resolve) => {
      this.completionResolve = resolve;
    });
    this.observeContextBound = createContextBoundNote({
      threshold: contextBoundNoteThreshold(swarm.env ?? process.env),
      model: () => this.model,
      canDeliver: () => !this.completed && !this.aborted,
      // A steer is promoted at the next step boundary mid-work; `resume: false`
      // leaves an idle session idle. Same route as OpenCode's own Plan reminder.
      inject: (note) =>
        host.sessions.synthetic({
          sessionID: _sessionId,
          text: note,
          delivery: "steer",
          resume: false,
        }),
    });
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get isFinished(): boolean {
    return this.completed;
  }

  emitSessionInit(harnessVariantMeta?: Record<string, unknown>): void {
    this.emit({
      type: "session_init",
      sessionId: this._sessionId,
      provider: "opencode",
      harnessVariant: "stock",
      ...(harnessVariantMeta ? { harnessVariantMeta } : {}),
    });
  }

  emitProviderEvent(event: ProviderEvent): void {
    this.emit(event);
  }

  recordUserPrompt(text: string): void {
    this.transcript.push(`[user]: ${text}`);
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    const wasEmpty = this.listeners.length === 0;
    this.listeners.push(listener);
    if (wasEmpty && this.pendingEvents.length > 0) {
      const buffered = this.pendingEvents;
      this.pendingEvents = [];
      for (const ev of buffered) listener(ev);
    }
  }

  private emitDirect(event: ProviderEvent): void {
    if (this.listeners.length === 0) {
      this.pendingEvents.push(event);
      return;
    }
    for (const l of this.listeners) l(event);
  }

  /** Emit `event` plus its scrubbed `raw_log` mirror. */
  private emit(event: ProviderEvent): void {
    this.emitDirect(event);
    this.emitDirect({ type: "raw_log", content: scrubSecrets(JSON.stringify(event)) });
  }

  /** Process one OpenCode 2 event. */
  handleOpencodeEvent(ev: OpenCodeEvent): void {
    if (this.aborted || this.completed) return;

    if (ev.type === "filesystem.changed") {
      this.onFileChanged(ev.data.file);
      return;
    }
    const data = (ev as { data?: { sessionID?: string } }).data;
    if (data?.sessionID !== this._sessionId) return;

    this.emitDirect({ type: "raw_log", content: scrubSecrets(JSON.stringify(ev)) });

    switch (ev.type) {
      case "session.step.started": {
        // OpenCode 2 runs its default model when the configured one is not in
        // its catalog, with no error event. Fail instead of billing the task
        // to a model nobody asked for.
        const actual = `${ev.data.model.providerID}/${ev.data.model.id}`;
        if (this.model.includes("/") && actual !== this.model) {
          this.fail(
            `opencode ran ${actual} instead of the requested model ${this.model}; the requested model is not in OpenCode's catalog`,
          );
        }
        break;
      }

      case "session.tool.input.started":
        this.toolNames.set(ev.data.id, ev.data.name);
        break;

      case "session.tool.called": {
        const toolName = this.toolNames.get(ev.data.id) ?? "tool";
        this.transcript.push(`[tool:${toolName}]: ${JSON.stringify(ev.data.input)}`);
        this.emit({
          type: "tool_start",
          toolCallId: ev.data.id,
          toolName,
          // OpenCode's native skill tool names the skill with `id`, not `name`.
          // Normalize only this tool for the shared skill.invoke tracker.
          args:
            toolName === "skill" && typeof ev.data.input?.id === "string"
              ? { ...ev.data.input, name: ev.data.input.id }
              : ev.data.input,
        });
        break;
      }

      case "session.tool.success":
      case "session.tool.failed": {
        const isError = ev.type === "session.tool.failed";
        const result = isError
          ? errorMessage(ev.data.error, "tool failed")
          : toolResultText(ev.data.content);
        this.transcript.push(`[tool result]: ${result.slice(0, TOOL_RESULT_PREVIEW_CHARS)}`);
        this.emit({
          type: "tool_end",
          toolCallId: ev.data.id,
          toolName: this.toolNames.get(ev.data.id) ?? "tool",
          result,
          isError,
        });
        break;
      }

      case "session.text.ended": {
        const parts = this.textByMessage.get(ev.data.assistantMessageID) ?? [];
        parts[ev.data.ordinal] = ev.data.text;
        this.textByMessage.set(ev.data.assistantMessageID, parts);
        const text = parts.join("").trim();
        if (!text) break;
        this.transcript.push(`[assistant]: ${ev.data.text}`);
        this.emit({
          type: "message",
          role: "assistant",
          content: text,
          messageId: ev.data.assistantMessageID,
        });
        break;
      }

      case "session.step.ended": {
        this.steps++;
        // Per-step usage drives the dashboard's context gauge.
        const t = ev.data.tokens;
        const contextUsed = t.input + t.cache.read + t.cache.write + t.output;
        void this.observeContextBound(t.input + t.cache.read + t.cache.write);
        this.composition?.observeUsage(t.input + t.cache.read + t.cache.write, this.model);
        const contextTotal = getContextWindowSize(this.model || "default");
        if (contextTotal > 0 && contextUsed > 0) {
          this.emit({
            type: "context_usage",
            contextUsedTokens: contextUsed,
            contextTotalTokens: contextTotal,
            contextPercent: clampContextPercent(contextUsed, contextTotal) ?? 0,
            outputTokens: t.output,
            contextFormula: CONTEXT_FORMULA,
          });
        }
        break;
      }

      case "session.usage.updated":
        this.usage = { cost: ev.data.cost, tokens: ev.data.tokens };
        break;

      case "session.execution.succeeded":
        void this.finish(async () => {
          const cost = await this.buildCostData(false);
          this.emit({ type: "result", cost, isError: false });
          return { exitCode: 0, sessionId: this._sessionId, cost, isError: false };
        });
        break;

      case "session.execution.failed":
        this.fail(errorMessage(ev.data.error, "opencode session error"));
        break;

      case "session.execution.interrupted":
        this.fail("opencode session was interrupted");
        break;

      case "permission.asked":
        // A headless worker cannot answer a permission prompt.
        this.fail(
          `Permission request received in headless mode (id=${ev.data.id}); aborting session`,
        );
        break;

      default:
        break;
    }
  }

  /** Same file triggers the claude and pi hooks act on. */
  private onFileChanged(file: string): void {
    const path = file.startsWith("/") ? file : join(this.cwd, file);
    if (
      path === "/workspace/SOUL.md" ||
      path === "/workspace/IDENTITY.md" ||
      path === "/workspace/TOOLS.md" ||
      path === "/workspace/CLAUDE.md"
    ) {
      void syncIdentityFilesToServer(this.swarm, "self_edit");
    }
    if (
      path.startsWith("/workspace/personal/memory/") ||
      path.startsWith("/workspace/shared/memory/")
    ) {
      void autoIndexMemoryFile(this.swarm, path);
    }
  }

  /** Settle the session as failed; also used when the event stream dies. */
  fail(rawMessage: string): void {
    if (this.aborted || this.completed) return;
    // SDK and provider errors can echo request details; the message reaches
    // the runner's logs and the task's failure reason.
    const message = scrubSecrets(rawMessage);
    this.emit({ type: "error", message });
    void this.finish(async () => ({
      exitCode: 1,
      sessionId: this._sessionId,
      cost: await this.buildCostData(true),
      isError: true,
      failureReason: message,
    }));
  }

  private async buildCostData(isError: boolean): Promise<CostData> {
    const { cost, tokens } = this.usage;
    const billed = await this.billing?.settle(BILLING_SETTLE_MS);
    return {
      sessionId: this._sessionId,
      taskId: this.swarm.taskId,
      agentId: this.swarm.agentId,
      ...(billed?.complete
        ? { totalCostUsd: billed.costUsd, harnessCostBilled: true }
        : { totalCostUsd: cost }),
      inputTokens: tokens.input,
      // OpenCode 2's `output` excludes reasoning; both bill at the output rate.
      outputTokens: tokens.output + tokens.reasoning,
      reasoningOutputTokens: tokens.reasoning,
      cacheReadTokens: tokens.cache.read,
      cacheWriteTokens: tokens.cache.write,
      durationMs: Date.now() - this.startedAt,
      numTurns: this.steps,
      model: this.model,
      isError,
      provider: "opencode",
    };
  }

  async waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  /** Identity sync, session summary, and session close (Stop-hook parity). */
  private async runSessionEnd(signal: AbortSignal): Promise<void> {
    await sessionHooks.syncIdentity(this.swarm, "session_sync", signal);
    if (isSessionSummarySkipped()) {
      console.debug("session_summary skipped (opencode): SKIP_SESSION_SUMMARY is set");
    } else {
      const transcript = this.transcript.join("\n").slice(-TRANSCRIPT_TAIL_CHARS);
      void summarizeTranscript(this.swarm, "opencode", transcript);
    }
    fireAndForget(`${this.swarm.apiUrl}/api/sessions/${this._sessionId}/close`, {
      method: "POST",
      headers: apiHeaders(this.swarm),
    });
  }

  /**
   * Settle the session. Session-end work is bounded and cancellable, so the
   * host always closes and completion always resolves.
   */
  private async finish(settle: ProviderResult | (() => Promise<ProviderResult>)): Promise<void> {
    if (this.completed) return;
    this.completed = true;
    const { signal } = this.sessionEnd;
    const result = typeof settle === "function" ? await settle() : settle;
    try {
      if (!this.aborted) {
        await settleWithin(this.runSessionEnd(signal), sessionHooks.budgetMs, signal);
      }
    } finally {
      this.sessionEnd.abort();
      await settleWithin(this.host.close(), sessionHooks.budgetMs);
      this.completionResolve({ ...result, appliedReasoningEffort: this.appliedReasoningEffort });
    }
  }

  async abort(): Promise<void> {
    if (this.aborted) return;
    if (this.completed) {
      // Already finishing: cut the session-end work short and wait for cleanup.
      this.aborted = true;
      this.sessionEnd.abort();
      await this.completionPromise;
      return;
    }
    this.aborted = true;
    await this.host.sessions.interrupt({ sessionID: this._sessionId }).catch(() => {});
    await this.finish({
      exitCode: 1,
      sessionId: this._sessionId,
      isError: true,
      failureReason: "aborted",
    });
  }

  async deliverSteering({ mode, text }: SteerDelivery): Promise<SteerDeliveryResult> {
    if (this.completed || this.aborted) {
      // The host is closed; fail closed so the server promotes the message
      // to a follow-up task (same as pi).
      return { delivered: false, reason: "opencode session already completed" };
    }
    try {
      // `steerModes` advertises queue only, so a "steer" request has already
      // been degraded upstream. Say so explicitly: OpenCode 2 defaults to steer.
      void mode;
      await this.host.sessions.prompt({ sessionID: this._sessionId, text, delivery: "queue" });
      this.recordUserPrompt(text);
      return { delivered: true, mode: "queue" };
    } catch (err) {
      return { delivered: false, reason: String(err) };
    }
  }
}

export class OpencodeAdapter implements ProviderAdapter {
  readonly name = "opencode";

  readonly traits: ProviderTraits = {
    hasMcp: true,
    hasToolSearch: false,
    // Same inline-resolver pattern as codex (`resolveSlashSkillPrompt`) — no
    // ambient skill awareness, so the system prompt enumerates them.
    nativeSkillDiscovery: false,
    hasLocalEnvironment: true,
    steerModes: ["queue"],
  };

  validateCredentials(env: Record<string, string | undefined> = {}): string {
    return validateOpencodeCredentials(env);
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    const taskId = config.taskId;
    const env = config.env ?? process.env;

    // Build MCP config: swarm endpoint + installed MCP servers
    const installedMcp =
      (await fetchInstalledMcpServers(config.apiUrl, config.apiKey, config.agentId, "opencode")) ??
      {};
    // Same per-boot runtime identity the runner registers with — dispatch
    // tools require it in multi-runtime mode, and it travels as request
    // context, not as a tool argument.
    const runtimeInstanceId = swarmRuntimeInstanceId();
    const mcp: Record<string, unknown> = {
      swarm: {
        type: "remote",
        url: `${config.apiUrl}/mcp`,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "X-Agent-ID": config.agentId,
          // Per-task identity, same as claude/codex: gives `store-progress` a
          // default task. The host is per task, so this is not shared.
          "X-Source-Task-Id": taskId,
          ...(config.contextKey ? { "X-Context-Key": config.contextKey } : {}),
          ...(runtimeInstanceId ? { "X-Runtime-Instance-ID": runtimeInstanceId } : {}),
        },
      },
      ...installedMcp,
    };
    // context-mode ships only a V1 opencode plugin, which OpenCode 2 cannot
    // load, so wire its stdio MCP server instead (same as codex).
    if (!isEnvFlagEnabled("CONTEXT_MODE_DISABLED", false)) {
      mcp["context-mode"] = {
        type: "local",
        command: ["context-mode"],
        environment: { CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY: CTX_MODE_NUDGE_EVERY },
      };
    }

    const opencodeConfig: OpencodeConfig = {
      $schema: "https://opencode.ai/config.json",
      model: config.model,
      mcp,
      permission: {
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
        doom_loop: "allow",
        external_directory: "allow",
      },
      // The system prompt lives on a config-defined agent; nothing is written
      // into the task's working directory.
      agent: {
        [SWARM_AGENT_NAME]: { mode: "primary", prompt: config.systemPrompt ?? "" },
      },
    };

    // One picked key for the model's provider (D3). It stays in this
    // in-memory config; registering it lets every scrubbed egress redact it
    // even when it never reached `process.env` (a key saved after boot).
    const splicedKey = applyProviderKeySplice(opencodeConfig, config.model, env);
    if (splicedKey) registerVolatileSecret(splicedKey.key, splicedKey.name);

    // Splice the provider-keyed reasoning options into
    // `provider[providerId].models[modelId].options`. `off` (and any
    // capability-rejected level) resolves to `noop`.
    const reasoningApplication = applyReasoningEffort(
      "opencode",
      config.model,
      config.reasoningEffort,
    );
    const appliedReasoningEffort =
      reasoningApplication.kind === "opencode-options" ? (config.reasoningEffort ?? null) : null;
    if (reasoningApplication.kind === "opencode-options") {
      const { providerId, modelId, options } = reasoningApplication;
      const provider = opencodeConfig.provider?.[providerId];
      opencodeConfig.provider = {
        ...opencodeConfig.provider,
        [providerId]: {
          ...provider,
          models: {
            ...provider?.models,
            [modelId]: {
              ...provider?.models?.[modelId],
              options: { ...provider?.models?.[modelId]?.options, ...options },
            },
          },
        },
      };
    }

    applyOpenRouterBaseUrlOverride(opencodeConfig, env);

    const swarm: SwarmHooksConfig = {
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      agentId: config.agentId,
      taskId,
      isLead: config.role === "lead",
      env: config.env,
    };
    const { sdk, version: opencodeVersion } = await loadOpencodeSdkImpl();
    let listTools: OpencodeToolLister | undefined;
    let onContext: ((event: OpencodeRequestContext) => void) | undefined;
    const billing = config.model.startsWith("openrouter/") ? new OpenRouterBilling() : undefined;
    // The config string carries the spliced provider key and the swarm MCP
    // bearer. It goes to the SDK only; nothing logs, writes, or uploads it,
    // and errors raised while the SDK parses it are scrubbed before they
    // propagate to the runner.
    let host: OpenCode.Interface;
    try {
      host = await sdk.OpenCode.create({
        config: { content: JSON.stringify(opencodeConfig) },
        plugins: [
          createOpencodeSwarmPlugin(swarm, {
            onToolRegistry: (lister) => {
              listTools = lister;
            },
            ...(billing ? { onOpenRouterResponse: (response) => billing.observe(response) } : {}),
            onContext: (event) => onContext?.(event),
          }),
        ],
        log: {
          level: "warn",
          emit: (entry) => console.warn(scrubSecrets(`[opencode] ${entry.message}`)),
        },
      });
    } catch (err) {
      throw new Error(scrubSecrets(`opencode host failed to start: ${errorMessage(err, "")}`));
    }

    let sessionId: string;
    try {
      const created = await host.sessions.create({
        location: { directory: config.cwd },
        agent: SWARM_AGENT_NAME,
      });
      sessionId = created.id;
    } catch (err) {
      await host.close().catch(() => {});
      throw new Error(scrubSecrets(`opencode session create failed: ${errorMessage(err, "")}`));
    }

    const session = new OpencodeSession(
      host,
      sessionId,
      config.model,
      swarm,
      config.cwd,
      appliedReasoningEffort,
      billing,
    );
    session.emitSessionInit(opencodeVersion ? { version: opencodeVersion } : undefined);
    if (config.runnerSessionId && taskId) {
      const composition = new HookCompositionReporter(
        { sessionId: config.runnerSessionId, provider: "opencode" },
        (body) =>
          postHookComposition({ apiUrl: config.apiUrl, taskId, headers: apiHeaders(swarm) }, body),
      );
      session.composition = composition;
      const groupOf = opencodeToolGroupOf(Object.keys(mcp));
      onContext = (event) => {
        // Subagent child sessions share the host; only the task session counts.
        if (event.sessionID !== sessionId) return;
        try {
          composition.observeRequest(measureOpencodeContext(event, groupOf));
        } catch (err) {
          console.warn(`[opencode] Request composition measure failed: ${err}`);
        }
      };
    }

    // Drive the session from the host's event stream. Closing the host ends
    // the stream; ending without a terminal event means the host died.
    void (async () => {
      try {
        for await (const event of host.events.subscribe()) {
          session.handleOpencodeEvent(event);
          if (session.isFinished) break;
        }
        session.fail("runner exited without result: opencode event stream ended");
      } catch (err) {
        session.fail(String(err));
      }
    })();

    void (async () => {
      // Without the swarm tools the model cannot report; fail before prompting.
      const refused = await checkSwarmMcpAdmission(
        host,
        config.cwd,
        () => listTools,
        sessionHooks.admissionTimeoutMs,
        () => session.isFinished,
      );
      if (refused) {
        session.fail(scrubSecrets(`swarm MCP admission failed: ${refused}`));
        return;
      }
      if (session.isFinished) return;
      const prompt = await resolveSlashSkillPrompt(config.prompt, {
        providerLabel: "opencode",
        skillsDir: defaultOpencodeSkillsDir(),
        emit: (event) => session.emitProviderEvent(event),
        onInline: config.onPromptSkill,
      });
      session.recordUserPrompt(prompt);
      await host.sessions.prompt({ sessionID: sessionId, text: prompt, delivery: "queue" });
    })().catch((err: unknown) => session.fail(scrubSecrets(errorMessage(err, String(err)))));

    return session;
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}

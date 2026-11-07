// Bun has no rename, chmod or mkdir API; file reads and writes use Bun.file/Bun.write.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getKnownContextWindowSize } from "../utils/context-window";
import { FX_ROUTE_KEY_VARS, type ResolvedFxRoute, requireFxRoute } from "../utils/fx-models";
import { getOpenRouterBaseUrl } from "../utils/openrouter-base-url";
import { registerVolatileSecret } from "../utils/secret-scrubber";
import { ACPAdapter } from "./acp-adapter";
import { fxSessionExists, fxTargetProfile } from "./acp-targets";
import type {
  CredStatus,
  ProviderAdapter,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
} from "./types";

/**
 * The fx release the worker image installs (`ARG FX_VERSION` in
 * Dockerfile.worker; bump the two together). Every ACP shape this adapter
 * relies on was measured against it.
 */
export const FX_PINNED_VERSION = "0.0.16";

/** OpenAI's Chat Completions prefix; fx appends `/chat/completions`. */
export const FX_OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * fx (Vercel Labs' terminal coding agent) on the swarm's ACP client: `fx acp`
 * is an ACP server, so spawn, swarm MCP, permissions, event translation and
 * cost come from {@link ACPAdapter} with {@link fxTargetProfile}. This adapter
 * resolves the model route, checks its key and seeds `~/.fx/settings.json`.
 *
 * Routes (`src/utils/fx-models.ts`): `openrouter/<vendor>/<id>` on
 * OPENROUTER_API_KEY, `vercel/<vendor>/<id>` on AI_GATEWAY_API_KEY, a bare
 * OpenAI id on OPENAI_API_KEY.
 */
export function checkFxCredentials(env: Record<string, string | undefined>): CredStatus {
  return FX_ROUTE_KEY_VARS.some((name) => env[name]?.trim())
    ? { ready: true, missing: [], satisfiedBy: "env" }
    : {
        ready: false,
        missing: [...FX_ROUTE_KEY_VARS],
        hint: "Set OPENROUTER_API_KEY (openrouter/<vendor>/<id>), OPENAI_API_KEY (bare OpenAI ids) or AI_GATEWAY_API_KEY (vercel/<vendor>/<id>) for fx.",
      };
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** An fx custom connection: OpenAI Chat Completions with a bearer key read from `keyVar`. */
function connection(baseUrl: string, keyVar: string): JsonObject {
  return {
    protocol: "openai-chat-completions",
    base_url: baseUrl,
    auth: { type: "bearer", env: keyVar },
  };
}

export interface FxSettingsInput {
  /** The home dir whose `.fx/settings.json` fx reads (fx has no config-dir override). */
  home: string;
  route: ResolvedFxRoute;
  /** The model's context window, registered so fx reports usage and compacts on time. */
  contextWindow?: number;
  openRouterBaseUrl: string;
}

/**
 * `~/.fx/settings.json` with the swarm-owned keys merged in:
 * - `providers.openrouter` and `providers.openai`: custom connections that
 *   name the key's env var (never its value). Fields the swarm does not own
 *   (`model_metadata`, `tool_choice_mode`, ...) are kept.
 * - `model_metadata[<id>].context_window` for the session's model on its
 *   connection, when the catalog knows it and the file has no entry: without
 *   a window fx sends no `usage_update` and cannot time compaction.
 * - `auto_upgrade: false` (the image pins fx) and `session_titles: false`
 *   (a title is an extra, unmetered model call).
 * Every other key is preserved. Pure.
 */
export function mergeFxSettings(
  current: JsonObject,
  input: Omit<FxSettingsInput, "home">,
): JsonObject {
  const next: JsonObject = structuredClone(current);
  const providers: JsonObject = isJsonObject(next.providers) ? next.providers : {};
  const owned: Record<string, JsonObject> = {
    openrouter: connection(input.openRouterBaseUrl, "OPENROUTER_API_KEY"),
    openai: connection(FX_OPENAI_BASE_URL, "OPENAI_API_KEY"),
  };
  for (const [name, fields] of Object.entries(owned)) {
    const existing = isJsonObject(providers[name]) ? providers[name] : {};
    providers[name] = { ...existing, ...fields };
  }
  const { fxProvider, fxModel } = input.route;
  const target = fxProvider === "gateway" ? undefined : (providers[fxProvider] as JsonObject);
  if (target && input.contextWindow && input.contextWindow > 0) {
    const metadata = isJsonObject(target.model_metadata) ? target.model_metadata : {};
    if (!isJsonObject(metadata[fxModel])) {
      metadata[fxModel] = { context_window: input.contextWindow };
    }
    target.model_metadata = metadata;
  }
  next.providers = providers;
  next.auto_upgrade = false;
  next.session_titles = false;
  return next;
}

/**
 * Merge the swarm's keys into `<home>/.fx/settings.json` ({@link mergeFxSettings}).
 * Idempotent: an unchanged file is not rewritten. Atomic: the new content goes
 * to a temp file in the same dir, then replaces the old one with a rename, so
 * a concurrent fx never reads half a file. A file that is not a JSON object is
 * an error, not something to overwrite.
 */
export async function ensureFxSettings(input: FxSettingsInput): Promise<{
  path: string;
  changed: boolean;
}> {
  const path = join(input.home, ".fx", "settings.json");
  const file = Bun.file(path);
  let current: JsonObject = {};
  if (await file.exists()) {
    const text = await file.text();
    if (text.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${path} is not valid JSON; fix or remove it before running fx`);
      }
      if (!isJsonObject(parsed)) {
        throw new Error(`${path} is not a JSON object; fix or remove it before running fx`);
      }
      current = parsed;
    }
  }
  const next = mergeFxSettings(current, input);
  if (JSON.stringify(next) === JSON.stringify(current)) return { path, changed: false };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.swarm-${process.pid}-${randomUUID()}.tmp`;
  try {
    await Bun.write(tmp, `${JSON.stringify(next, null, 2)}\n`);
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return { path, changed: true };
}

export interface FxAdapterOptions {
  /** The home dir fx runs under. Defaults to the session's `HOME`. Tests inject a temp dir. */
  home?: string;
}

export class FxAdapter implements ProviderAdapter {
  readonly name = "fx";

  readonly traits: ProviderTraits = {
    hasMcp: true,
    // fx defers swarm tools behind its own `capability_search`; the prompt
    // uses the fx-specific discovery line, not the generic tool-search one.
    hasToolSearch: false,
    // `~/.claude/skills` is a native fx skill root (verified: a planted skill loaded).
    nativeSkillDiscovery: true,
    hasLocalEnvironment: true,
    steerModes: ["steer"],
  };

  private readonly acp = new ACPAdapter({ providerName: "fx", target: fxTargetProfile });

  constructor(private readonly options: FxAdapterOptions = {}) {}

  async createSession(sessionConfig: ProviderSessionConfig): Promise<ProviderSession> {
    const route = requireFxRoute(sessionConfig.model);
    const env = { ...process.env, ...sessionConfig.env };
    const apiKey = env[route.keyVar]?.trim();
    if (!apiKey) throw new Error(`fx requires ${route.keyVar} for ${route.model}`);
    registerVolatileSecret(apiKey, route.keyVar);
    const home = this.options.home ?? env.HOME;
    if (!home) throw new Error("fx requires HOME: it keeps its settings and sessions in ~/.fx");

    await ensureFxSettings({
      home,
      route,
      contextWindow:
        route.fxProvider === "gateway" ? undefined : getKnownContextWindowSize(route.model),
      openRouterBaseUrl: getOpenRouterBaseUrl(env),
    });
    return this.acp.createSession({
      ...sessionConfig,
      model: route.model,
      env: { ...sessionConfig.env, [route.keyVar]: apiKey, HOME: home },
    });
  }

  async canResume(sessionId: string): Promise<boolean> {
    return fxSessionExists(sessionId, this.options.home ?? process.env.HOME);
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}

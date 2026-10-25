/** Shared credential probes. This module does not import worker harnesses. */
import {
  type OpenAICompatibleProvider,
  providerBaseUrl,
  providerForKeyVar,
} from "@desplega/model-catalog";
import {
  createScopedFetch,
  deriveDefaultRoute,
  getRouteProvider,
  type ModelRoute,
} from "@desplega/model-routing";
import { assertUrlSafe, publicEndpointSsrfOptions } from "../oauth/mcp-wrapper";
import { getOpenRouterAttributionHeaders, getOpenRouterBaseUrl } from "./openrouter-base-url";
import { scrubSecrets } from "./secret-scrubber";

interface ProbeOptions {
  env?: Record<string, string | undefined>;
  publicEndpoint?: boolean;
}

const LIVE_TEST_TIMEOUT_MS = 5_000;

function scrubProbeBody(body: string, init: RequestInit): string {
  const headers = new Headers(init.headers);
  const apiKey =
    headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return scrubSecrets(apiKey ? body.replaceAll(apiKey, "[REDACTED]") : body);
}

export interface LiveKeyResult {
  keyType: string;
  index: number;
  suffix: string;
  ok: boolean;
  error?: string;
  httpStatus?: number;
  latency_ms: number;
}

export interface LiveValidationResult {
  ok: boolean;
  error?: string;
  httpStatus?: number;
  warning?: string;
  keys?: LiveKeyResult[];
  latency_ms: number;
  /** No free live check exists for this credential (cloud routes): report presence only. */
  skipped?: boolean;
}

export async function timedFetch(
  url: string,
  init: RequestInit,
  options: ProbeOptions = {},
): Promise<{ ok: boolean; status: number; bodyText: string; latency_ms: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_TEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    if (options.publicEndpoint) assertUrlSafe(url, publicEndpointSsrfOptions());
    const res = await fetch(url, {
      ...init,
      ...(options.publicEndpoint ? { redirect: "manual" } : {}),
      signal: controller.signal,
    });
    let bodyText = "";
    try {
      bodyText = scrubProbeBody(await res.text(), init);
    } catch {
      // The HTTP status is sufficient when the response body cannot be read.
    }
    return {
      ok: res.ok,
      status: res.status,
      bodyText,
      latency_ms: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkAnthropicApiKey(
  apiKey: string,
  options: ProbeOptions = {},
): Promise<LiveValidationResult> {
  const r = await timedFetch(
    "https://api.anthropic.com/v1/models",
    {
      method: "GET",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    },
    options,
  );
  if (r.ok) return { ok: true, latency_ms: r.latency_ms };
  return {
    ok: false,
    error: scrubSecrets(`HTTP ${r.status}: ${r.bodyText.slice(0, 200)}`),
    httpStatus: r.status,
    latency_ms: r.latency_ms,
  };
}

export async function checkOpenAiApiKey(
  apiKey: string,
  options: ProbeOptions = {},
): Promise<LiveValidationResult> {
  const r = await timedFetch(
    "https://api.openai.com/v1/models",
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    options,
  );
  if (r.ok) return { ok: true, latency_ms: r.latency_ms };
  return {
    ok: false,
    error: scrubSecrets(`HTTP ${r.status}: ${r.bodyText.slice(0, 200)}`),
    httpStatus: r.status,
    latency_ms: r.latency_ms,
  };
}

/** `GET /v1/models` is the call the Grok CLI makes first; it runs no inference. */
export async function checkXaiApiKey(
  apiKey: string,
  options: ProbeOptions = {},
): Promise<LiveValidationResult> {
  const r = await timedFetch(
    "https://api.x.ai/v1/models",
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    options,
  );
  if (r.ok) return { ok: true, latency_ms: r.latency_ms };
  return {
    ok: false,
    error: scrubSecrets(`HTTP ${r.status}: ${r.bodyText.slice(0, 200)}`),
    httpStatus: r.status,
    latency_ms: r.latency_ms,
  };
}

/** Fetch a key-authenticated GET and normalize it into a `LiveValidationResult`. */
async function checkBearerGet(
  url: string,
  init: RequestInit,
  options: ProbeOptions = {},
): Promise<LiveValidationResult> {
  const r = await timedFetch(url, { method: "GET", ...init }, options);
  if (r.ok) return { ok: true, latency_ms: r.latency_ms };
  return {
    ok: false,
    error: scrubSecrets(`HTTP ${r.status}: ${r.bodyText.slice(0, 200)}`),
    httpStatus: r.status,
    latency_ms: r.latency_ms,
  };
}

/**
 * OpenRouter's `/models` is public and answers 200 for any key, so the check
 * reads `GET /key` (the key's own info, 401 for a bad key). A custom
 * `OPENROUTER_BASE_URL` without `/key` (404/405) falls back to `/models`.
 */
export async function checkOpenRouter(
  apiKey: string,
  options: ProbeOptions = {},
): Promise<LiveValidationResult> {
  const base = getOpenRouterBaseUrl(options.env);
  const get = (url: string) =>
    checkBearerGet(
      url,
      {
        headers: {
          ...getOpenRouterAttributionHeaders(url, options.env),
          Authorization: `Bearer ${apiKey}`,
        },
      },
      options,
    );
  const keyResult = await get(`${base}/key`);
  if (keyResult.httpStatus === 404 || keyResult.httpStatus === 405) return get(`${base}/models`);
  return keyResult;
}

/** `GET /models` on the official DeepSeek API: lists models, runs no inference. */
export function checkDeepSeekApiKey(
  apiKey: string,
  options: ProbeOptions = {},
): Promise<LiveValidationResult> {
  return checkBearerGet(
    "https://api.deepseek.com/models",
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    options,
  );
}

/**
 * `GET <baseUrl>/models` with a Bearer key against an OpenAI-compatible
 * registry provider (NaN, Helmcode). Lists models, runs no inference.
 * `baseUrl` defaults to the registry entry; the probe passes the
 * `<ID>_BASE_URL` override, and tests inject a fake server.
 */
export async function checkOpenAICompatibleProvider(
  provider: OpenAICompatibleProvider,
  apiKey: string,
  baseUrl: string = provider.baseUrl,
  options: ProbeOptions = {},
): Promise<LiveValidationResult> {
  const r = await timedFetch(
    `${baseUrl.replace(/\/+$/, "")}/models`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    options,
  );
  if (r.ok) return { ok: true, latency_ms: r.latency_ms };
  return {
    ok: false,
    error: scrubSecrets(`HTTP ${r.status}: ${r.bodyText.slice(0, 200)}`),
    httpStatus: r.status,
    latency_ms: r.latency_ms,
  };
}

/**
 * Run the route provider's own check. Requests stay on the route's origin and
 * path prefix, go to public hosts only, and never follow a redirect.
 */
async function checkRoute(
  route: ModelRoute,
  env: Record<string, string | undefined>,
): Promise<LiveValidationResult> {
  const startedAt = Date.now();
  const provider = getRouteProvider(route.provider);
  const baseUrl = route.baseUrl ?? provider?.defaultBaseUrl;
  if (!provider?.validate || !baseUrl) return { ok: true, skipped: true, latency_ms: 0 };
  const publicFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assertUrlSafe(String(url), publicEndpointSsrfOptions());
    const res = await fetch(url, init);
    if (res.ok || !res.body) return res;
    return new Response(scrubProbeBody(await res.text(), init ?? {}), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
  const result = await provider.validate({
    route,
    env,
    signal: AbortSignal.timeout(LIVE_TEST_TIMEOUT_MS),
    fetch: createScopedFetch(baseUrl, publicFetch as typeof fetch),
  });
  const latency_ms = Date.now() - startedAt;
  if (result.status === "verified") return { ok: true, latency_ms };
  return {
    ok: result.status === "configured",
    ...(result.status === "configured" ? { skipped: true } : { httpStatus: result.httpStatus }),
    error: scrubSecrets(result.reason),
    latency_ms,
  };
}

/** Check one newly submitted pool member without loading a worker harness. */
export async function checkProviderPoolKey(
  keyType: string,
  apiKey: string,
  env: Record<string, string | undefined> = process.env,
): Promise<LiveValidationResult> {
  const startedAt = Date.now();
  const options: ProbeOptions = { env, publicEndpoint: true };
  try {
    switch (keyType) {
      case "ANTHROPIC_API_KEY": {
        // Behind a gateway (`ANTHROPIC_BASE_URL`), Claude Code sends this key
        // to the gateway, so check it there and not at api.anthropic.com.
        const keyEnv = { ...env, ANTHROPIC_API_KEY: apiKey };
        const route = deriveDefaultRoute("claude", keyEnv);
        if (
          route?.provider === "anthropic-gateway" &&
          "secretKey" in route.auth &&
          route.auth.secretKey === "ANTHROPIC_API_KEY"
        ) {
          return await checkRoute(route, keyEnv);
        }
        return await checkAnthropicApiKey(apiKey, options);
      }
      case "OPENAI_API_KEY":
        return await checkOpenAiApiKey(apiKey, options);
      case "OPENROUTER_API_KEY":
        return await checkOpenRouter(apiKey, options);
      case "DEEPSEEK_API_KEY":
        return await checkDeepSeekApiKey(apiKey, options);
      case "XAI_API_KEY":
        return await checkXaiApiKey(apiKey, options);
      case "CLAUDE_CODE_OAUTH_TOKEN": {
        const tokenEnv = { CLAUDE_CODE_OAUTH_TOKEN: apiKey };
        return await checkRoute(deriveDefaultRoute("claude", tokenEnv)!, tokenEnv);
      }
      default: {
        const provider = providerForKeyVar(keyType);
        if (provider) {
          return await checkOpenAICompatibleProvider(
            provider,
            apiKey,
            providerBaseUrl(provider, env),
            options,
          );
        }
        return { ok: true, skipped: true, latency_ms: 0 };
      }
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: scrubSecrets(raw.split(apiKey).join("[REDACTED]")) || "Unknown error",
      latency_ms: Date.now() - startedAt,
    };
  }
}

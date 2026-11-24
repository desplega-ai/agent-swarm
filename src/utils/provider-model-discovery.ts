import { createHash } from "node:crypto";
import { parseLiteLLMModelInfo } from "./litellm-model-info";
import { type ModelLimits, positiveTokenLimit } from "./provider-model-limits";

export interface DiscoverySettings {
  mode: "off" | "litellm";
  baseURL: string;
  semantics?: "conservative" | "input-plus-output";
  ttlMs?: number;
  /** Optional exact-model operator policy; not a discovery cache. */
  limits?: Record<string, ModelLimits>;
}

/** Relative to the inference base: strip ONLY a terminal /v1, retain all other prefixes. */
export function metadataUrl(baseURL: string): string {
  const url = new URL(baseURL);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid discovery base URL");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/model/info`;
  return url.href;
}

export function parseDiscoveryConfig(raw: string | undefined): Record<string, DiscoverySettings> {
  if (!raw?.trim()) return {};
  const invalid = () => new Error("Invalid PROVIDER_MODEL_DISCOVERY configuration");
  try {
    if (raw.length > 65536) throw invalid();
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length > 32
    )
      throw invalid();
    for (const [provider, value] of Object.entries(parsed)) {
      const entry = value as DiscoverySettings;
      if (
        !/^[a-z0-9-]+$/.test(provider) ||
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        Object.keys(entry).some(
          (key) => !["mode", "baseURL", "semantics", "ttlMs", "limits"].includes(key),
        ) ||
        !["off", "litellm"].includes(entry.mode) ||
        typeof entry.baseURL !== "string" ||
        (entry.semantics !== undefined &&
          !["conservative", "input-plus-output"].includes(entry.semantics)) ||
        (entry.ttlMs !== undefined && (!positiveTokenLimit(entry.ttlMs) || entry.ttlMs > 3600000))
      )
        throw invalid();
      metadataUrl(entry.baseURL);
      if (entry.limits !== undefined) {
        if (
          !entry.limits ||
          typeof entry.limits !== "object" ||
          Array.isArray(entry.limits) ||
          Object.keys(entry.limits).length > 256
        )
          throw invalid();
        for (const limit of Object.values(entry.limits)) {
          if (
            !limit ||
            typeof limit !== "object" ||
            Array.isArray(limit) ||
            Object.entries(limit).some(
              ([key, n]) => !["input", "output", "context"].includes(key) || !positiveTokenLimit(n),
            )
          )
            throw invalid();
        }
      }
    }
    return parsed;
  } catch {
    throw invalid();
  }
}

export function validateDiscoveryConfig(raw: unknown): string | null {
  try {
    if (typeof raw !== "string") throw new Error();
    parseDiscoveryConfig(raw);
    return null;
  } catch {
    return "Invalid PROVIDER_MODEL_DISCOVERY configuration";
  }
}

type Diagnostic =
  | "invalid-route"
  | "access-denied"
  | "unsupported"
  | "invalid-metadata"
  | "unavailable"
  | "alias-unknown";
export interface DiscoveryResult {
  limits?: ModelLimits;
  observedAt?: number;
  stale?: boolean;
  diagnostic?: Diagnostic;
}
interface DiscoveryRoute {
  provider: string;
  baseURL: string;
  key: string;
  modelId: string;
  /** Agent/repository execution scope, opaque and never emitted. */
  scope?: string;
  ttlMs?: number;
  timeoutMs?: number;
}
const MAX_RESPONSE_BYTES = 1048576;
const MAX_ENTRIES = 128;
const MAX_STALE_MS = 86400000;
const BACKOFF_MS = 30000;

/** Private process-local, selected-alias-only cache. Fingerprints are never exported or logged. */
export function createModelDiscovery(deps: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const cache = new Map<
    string,
    { result: DiscoveryResult; nextAt: number; good?: DiscoveryResult }
  >();
  const inFlight = new Map<string, Promise<DiscoveryResult>>();
  const now = deps.now ?? Date.now;
  return async (route: DiscoveryRoute): Promise<DiscoveryResult> => {
    let endpoint: string;
    try {
      endpoint = metadataUrl(route.baseURL);
      if (!route.key.trim() || route.key.includes(",") || /[\r\n]/.test(route.key))
        throw new Error();
    } catch {
      return { diagnostic: "invalid-route" };
    }
    const identity = createHash("sha256")
      .update(
        JSON.stringify([
          route.provider,
          new URL(route.baseURL).href.replace(/\/+$/, ""),
          route.key,
          route.modelId,
          route.scope,
        ]),
      )
      .digest("hex");
    const previous = cache.get(identity);
    if (previous && now() < previous.nextAt) {
      // A negative backoff must not extend the maximum stale age.
      if (previous.result.stale && now() - (previous.result.observedAt ?? 0) > MAX_STALE_MS)
        return { diagnostic: previous.result.diagnostic };
      return structuredClone(previous.result);
    }
    const pending = inFlight.get(identity);
    if (pending) return structuredClone(await pending);
    // Bound in-flight work as well as settled entries, without evicting a live promise.
    if (inFlight.size >= MAX_ENTRIES) return { diagnostic: "unavailable" };
    const request = (async (): Promise<DiscoveryResult> => {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("timeout"));
        }, route.timeoutMs ?? 5000);
      });
      const failure: { diagnostic: Diagnostic } = { diagnostic: "unavailable" };
      let success: DiscoveryResult | undefined;
      let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel"> | undefined;
      try {
        success = await Promise.race([
          (async () => {
            const response = await (deps.fetchImpl ?? fetch)(endpoint, {
              headers: { Authorization: `Bearer ${route.key}` },
              signal: abort.signal,
              redirect: "error",
            });
            if (!response.ok) {
              failure.diagnostic =
                response.status === 401 || response.status === 403
                  ? "access-denied"
                  : response.status === 404 || response.status === 405
                    ? "unsupported"
                    : "unavailable";
              await response.body?.cancel();
              return undefined;
            }
            failure.diagnostic = "invalid-metadata";
            if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
              await response.body?.cancel();
              return undefined;
            }
            reader = response.body?.getReader();
            if (!reader) return undefined;
            const chunks: Uint8Array[] = [];
            let size = 0;
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                return undefined;
              }
              chunks.push(next.value);
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }
            const limits = parseLiteLLMModelInfo(
              JSON.parse(new TextDecoder().decode(bytes)),
              route.modelId,
            );
            return limits
              ? { limits, observedAt: now(), stale: false }
              : { diagnostic: "alias-unknown" as const };
          })(),
          timeout,
        ]);
      } catch {
        // Never format network errors or response bodies: either can contain secrets.
        if (
          abort.signal.aborted &&
          failure.diagnostic !== "access-denied" &&
          failure.diagnostic !== "unsupported"
        )
          failure.diagnostic = "unavailable";
      } finally {
        clearTimeout(timer);
        abort.abort();
        void reader?.cancel().catch(() => {});
      }
      const { diagnostic } = failure;
      const good = diagnostic !== "unavailable" || success ? undefined : previous?.good;
      const stale = good?.limits && now() - (good.observedAt ?? 0) <= MAX_STALE_MS;
      const result: DiscoveryResult =
        success ?? (stale ? { ...good, stale: true, diagnostic } : { diagnostic });
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
      cache.set(identity, {
        result,
        nextAt: now() + (success?.limits ? (route.ttlMs ?? 300000) : BACKOFF_MS),
        good: success?.limits ? success : good,
      });
      return result;
    })();
    inFlight.set(identity, request);
    try {
      return structuredClone(await request);
    } finally {
      inFlight.delete(identity);
    }
  };
}

export const discoverProviderModel = createModelDiscovery();

import {
  MAX_REDIRECTS,
  MAX_REPLAY_BODY_BYTES,
  nextHopRequest,
  REDIRECT_STATUSES,
  RequestBodyTooLargeError,
  replayableBody,
} from "../../utils/egress-guard";
import type { FailedCredentialBinding, ResolvedCredentialBinding } from "./types";

function hostnameForFetchInput(input: string | URL | Request): string | null {
  try {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function urlForFetchInput(input: string | URL | Request): URL | null {
  try {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    return new URL(url);
  } catch {
    return null;
  }
}

function cloneRequestInit(input: string | URL | Request, init?: RequestInit): RequestInit {
  return {
    ...(input instanceof Request
      ? {
          method: input.method,
          body: input.body,
          redirect: input.redirect,
          signal: input.signal,
        }
      : {}),
    ...init,
  };
}

function applyQueryTemplates(url: URL, bindings: ResolvedCredentialBinding[]): boolean {
  let modified = false;

  for (const binding of bindings) {
    if (!binding.allowedHosts.includes(url.hostname) || !binding.queryTemplate) continue;
    const separator = binding.queryTemplate.indexOf("=");
    if (separator <= 0) continue;

    const paramName = binding.queryTemplate.slice(0, separator);
    const paramTemplate = binding.queryTemplate.slice(separator + 1);
    if (!paramTemplate.includes(binding.placeholder)) continue;

    const values = url.searchParams.getAll(paramName);
    if (values.length === 0) continue;

    url.searchParams.delete(paramName);
    for (const value of values) {
      const nextValue = value.includes(binding.placeholder)
        ? value.split(binding.placeholder).join(binding.value)
        : value;
      if (nextValue !== value) modified = true;
      url.searchParams.append(paramName, nextValue);
    }
  }

  return modified;
}

function assertNoFailedBinding(
  failedBindings: FailedCredentialBinding[],
  hostname: string,
  url: URL,
  headers: Headers,
): void {
  if (failedBindings.length === 0) return;
  for (const failed of failedBindings) {
    if (!failed.allowedHosts.includes(hostname)) continue;
    const inUrl = url.href.includes(failed.placeholder);
    const inHeaders = [...headers.values()].some((value) => value.includes(failed.placeholder));
    if (inUrl || inHeaders) {
      throw new Error(
        `OAuth authorization '${failed.authorizationLabel ?? "unknown"}' is in refresh-failed state: ${failed.reason}`,
      );
    }
  }
}

export function patchFetchWithCredentialBroker(
  bindings: ResolvedCredentialBinding[],
  failedBindings: FailedCredentialBinding[] = [],
): void {
  // Always install: even with zero resolved bindings (fresh install, identity
  // without the credential) the wrapper must strip unresolved placeholder
  // headers below, or the literal placeholder rides to the provider as a
  // guaranteed 401 and optional-auth APIs stop serving public data.
  const originalFetch = globalThis.fetch;

  async function patchedFetch(
    input: string | URL | Request,
    init?: RequestInit,
    hop = 0,
  ): Promise<Response> {
    const url = urlForFetchInput(input);
    const hostname = url?.hostname ?? hostnameForFetchInput(input);
    if (!hostname || !url) return originalFetch(input, init);

    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);

    // Fail closed: a request that would carry a broken binding's placeholder to
    // its host throws a typed error instead of leaking the placeholder.
    assertNoFailedBinding(failedBindings, hostname, url, headers);

    let headersModified = false;
    const newHeaders = new Headers();

    for (const [key, rawValue] of headers.entries()) {
      let value = rawValue;
      for (const binding of bindings) {
        if (binding.allowedHosts.includes(hostname) && value.includes(binding.placeholder)) {
          value = value.split(binding.placeholder).join(binding.value);
          headersModified = true;
        }
      }
      // A placeholder still present after substitution means the credential is
      // not configured (or not allowed) for this identity and host: drop the
      // header instead of sending the literal, so optional-auth providers can
      // still serve public data unauthenticated.
      if (value.includes("[REDACTED:")) {
        headersModified = true;
        continue;
      }
      newHeaders.set(key, value);
    }

    const urlModified = applyQueryTemplates(url, bindings);

    // Once the broker follows a redirect it keeps following every later hop,
    // so the chain has one hop budget even where the fetch below also counts.
    if (!headersModified && !urlModified && hop === 0) return originalFetch(input, init);

    const callerInit = cloneRequestInit(input, init);
    const redirectMode = callerInit.redirect ?? "follow";
    // A 307/308 sends the body again, so a short stream (a Request body) is read
    // once here; a longer one is sent unbuffered and cannot follow such a hop.
    let replayable = true;
    if (redirectMode === "follow") {
      const prepared = await replayableBody(callerInit.body, callerInit.signal);
      callerInit.body = prepared.body;
      replayable = prepared.replayable;
    }
    const mergedInit: RequestInit = {
      ...callerInit,
      headers: headersModified || input instanceof Request ? newHeaders : init?.headers,
      // Never let the fetch follow a redirect with the substituted credential
      // attached: each hop goes back through the broker, which substitutes
      // again only for an allowed host.
      redirect: "manual",
    };
    const nextUrl = urlModified ? url.href : input instanceof Request ? input.url : input;
    const response = await originalFetch(nextUrl, mergedInit);
    const location = response.headers.get("location");
    if (redirectMode === "manual" || !REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }
    if (redirectMode === "error")
      throw new TypeError(`fetch redirect refused (redirect: "error"): ${url.href}`);
    if (hop >= MAX_REDIRECTS)
      throw new TypeError(`fetch exceeded ${MAX_REDIRECTS} redirects: ${url.href}`);
    await response.body?.cancel().catch(() => {});
    const next = new URL(location, url);
    // Re-enter with the caller's placeholder headers, not the substituted ones.
    const hopRequest = nextHopRequest(response.status, url, next, {
      method: callerInit.method ?? "GET",
      headers,
      body: callerInit.body ?? undefined,
    });
    if (!replayable && hopRequest.body !== undefined) {
      throw new RequestBodyTooLargeError(MAX_REPLAY_BODY_BYTES);
    }
    return patchedFetch(
      next.href,
      { ...callerInit, ...hopRequest, redirect: redirectMode },
      hop + 1,
    );
  }

  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => patchedFetch(input, init),
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
}
